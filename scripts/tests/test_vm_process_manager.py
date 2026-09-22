"""Run inside Linux: python3 -m unittest discover -s scripts/tests -p test_vm_process_manager.py."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'pkg/rancher-desktop/main/processManager/probe.ts'
PROBE = SOURCE.read_text().split('String.raw`', 1)[1].rsplit('`;', 1)[0]
namespace = {'__name__': 'probe_test'}
exec(PROBE, namespace)


@unittest.skipUnless(sys.platform == 'linux', 'Requires real Linux procfs and pidfds')
class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.child = subprocess.Popen(['sleep', '60'])
        self.process = namespace['process'](self.child.pid)
        self.request = dict(action='terminate', pid=self.child.pid, started=self.process['started'],
                            boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip(), signal='TERM')

    def tearDown(self):
        if self.child.poll() is None:
            self.child.terminate()
        self.child.wait(timeout=5)

    def test_snapshot_real_vm_memory_and_process(self):
        result = namespace['snapshot']()
        self.assertGreater(result['memoryTotal'], result['memoryAvailable'])
        self.assertGreater(result['cores'], 0)
        self.assertTrue(any(p['pid'] == self.child.pid for p in result['processes']))
        self.assertTrue(any(f['path'] == '/' for f in result['filesystems']))
        self.assertNotIn('cmdline', result['processes'][0])
        devices = [os.stat(f['path']).st_dev for f in result['filesystems']]
        self.assertEqual(len(devices), len(set(devices)))

    def test_stale_identity_never_signals(self):
        for field, bad in [('started', '0'), ('boot', 'wrong')]:
            with self.assertRaises(ValueError):
                namespace['terminate']({**self.request, field: bad})
            self.assertIsNone(self.child.poll())

    def test_invalid_targets_and_signals(self):
        for change in [dict(pid=1), dict(pid=-1), dict(pid='2; kill -1'), dict(signal='STOP')]:
            with self.assertRaises(ValueError):
                namespace['terminate']({**self.request, **change})
            self.assertIsNone(self.child.poll())

    def test_protected_process_never_signals(self):
        with patch.dict(namespace, process=lambda pid: {**self.process, 'protected': 'Core service'}):
            with self.assertRaisesRegex(ValueError, 'Core service'):
                namespace['terminate'](self.request)
        self.assertIsNone(self.child.poll())

    def test_missing_pidfd_support_fails_closed(self):
        with patch.object(os, 'pidfd_open', side_effect=OSError('unsupported')):
            with self.assertRaises(OSError):
                namespace['terminate'](self.request)
        self.assertIsNone(self.child.poll())

    @unittest.skipIf(os.getuid() == 0, 'Root processes intentionally protected')
    def test_quit_only_owned_disposable_child(self):
        self.assertTrue(namespace['terminate'](self.request)['sent'])
        self.assertEqual(self.child.wait(timeout=5), -signal.SIGTERM)

    @unittest.skipIf(os.getuid() == 0, 'Root processes intentionally protected')
    def test_force_quit_only_owned_disposable_child(self):
        self.assertTrue(namespace['terminate']({**self.request, 'signal': 'KILL'})['sent'])
        self.assertEqual(self.child.wait(timeout=5), -signal.SIGKILL)

    def test_exited_process_fails_without_signal(self):
        self.child.terminate()
        self.child.wait(timeout=5)
        with self.assertRaises(ProcessLookupError):
            namespace['terminate'](self.request)

    def test_cli_returns_json(self):
        result = subprocess.run([sys.executable, '-c', PROBE], check=True, capture_output=True, text=True)
        self.assertIn('processes', json.loads(result.stdout))


if __name__ == '__main__':
    unittest.main()
