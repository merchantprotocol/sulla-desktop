# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
"""Guest export routing regression: no Docker engine or real user data required."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOTLESS_MARKERS = ('shadow-subids', 'fuse-overlayfs', 'slirp4netns', 'docker-rootless-extras',
                    'adduser', 'addgroup', '/etc/subuid', '/etc/subgid', 'wsl-rootfs')


def dockerfile_stages():
    """Return {stage name: (base, instruction text without comments)} in file order."""
    stages = {}
    name = None
    for raw in (HERE / 'Dockerfile').read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        match = re.match(r'FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$', line, re.IGNORECASE)
        if match:
            name = match.group(2) or f'<unnamed {len(stages)}>'
            stages[name] = [match.group(1), []]
            continue
        if name is not None:
            stages[name][1].append(line)
    return {key: (base, '\n'.join(body)) for key, (base, body) in stages.items()}


def stage_chain(target):
    """Every stage a `--target <target>` build reads from (FROM, COPY --from, RUN --mount from)."""
    stages = dockerfile_stages()
    seen = []
    pending = [target]
    while pending:
        current = pending.pop()
        if current in seen or current not in stages:
            continue
        seen.append(current)
        base, body = stages[current]
        pending.append(base)
        pending.extend(re.findall(r'--from=([\w.-]+)', body))
        pending.extend(re.findall(r'--mount=\S*\bfrom=([\w.-]+)', body))
    return seen


class GuestExportTest(unittest.TestCase):
    def test_build_routes_to_guest_export_not_final_container_stage(self):
        with tempfile.TemporaryDirectory(prefix='guest-export-', dir=HERE) as temporary:
            root = Path(temporary)
            docker = root / 'docker'
            docker.write_text('''#!/bin/sh
set -eu
[ "$1" = buildx ] && [ "$2" = build ]
target=; output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) shift; target=$1 ;;
    --output) shift; output=${1#type=local,dest=} ;;
  esac
  shift
done
[ "$target" = guest-export ] || exit 42
# Synthetic output only; never substitutes for an actual guest build.
for file in vmlinuz initramfs.img usr.erofs VERSION; do
  printf 'synthetic fixture\\n' > "$output/$file"
done
(cd "$output" && sha256sum vmlinuz initramfs.img usr.erofs VERSION > SHA256SUMS)
''')
            docker.chmod(0o700)
            result = subprocess.run(['sh', str(HERE / 'build.sh'), 'arm64', str(root / 'out')],
                                    env={**os.environ, 'PATH': f'{root}:{os.environ["PATH"]}'},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((root / 'out' / 'usr.erofs').exists())

    def test_named_export_contains_vz_artifacts(self):
        dockerfile = (HERE / 'Dockerfile').read_text()
        stage = dockerfile.split('FROM scratch AS guest-export\n', 1)[1].split('\nFROM ', 1)[0]
        self.assertIn('COPY --from=usr /out/ /', stage)

    def test_macos_guest_export_chain_has_no_rootless_or_wsl_additions(self):
        # risk: the macOS VZ guest must stay exactly what it was; the WSL/rootless
        # packages, the uid-1000 user and subordinate id ranges belong only to WSL.
        chain = stage_chain('guest-export')
        self.assertEqual(sorted(chain), ['agent', 'guest-export', 'image', 'usr'])
        stages = dockerfile_stages()
        for stage in chain:
            for marker in ROOTLESS_MARKERS:
                self.assertNotIn(marker, stages[stage][1], f'{marker} leaked into guest stage {stage}')

    def test_wsl_import_rootfs_chain_carries_rootless_additions(self):
        chain = stage_chain('wsl-import-rootfs')
        self.assertIn('wsl-image', chain)
        self.assertIn('image', chain)
        body = '\n'.join(dockerfile_stages()[stage][1] for stage in chain)
        for marker in ROOTLESS_MARKERS:
            self.assertIn(marker, body)
        self.assertIn('adduser -D -u 1000 -G sulla', body)
        self.assertNotIn('from=image', dockerfile_stages()['wsl-import-rootfs'][1],
                         'wsl-import-rootfs must copy from wsl-image, not the shared guest stage')

    def test_invalid_arch_never_invokes_engine(self):
        result = subprocess.run(['sh', str(HERE / 'build.sh'), 'invalid'], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
