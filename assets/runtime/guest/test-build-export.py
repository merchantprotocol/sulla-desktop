# Sulla Desktop · https://sulladesktop.com
# Copyright (c) 2025-2026 Merchant Protocol LLC.
# SPDX-License-Identifier: GPL-2.0-or-later
"""Guest export routing regression: no Docker engine or real user data required."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


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

    def test_invalid_arch_never_invokes_engine(self):
        result = subprocess.run(['sh', str(HERE / 'build.sh'), 'invalid'], capture_output=True)
        self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
