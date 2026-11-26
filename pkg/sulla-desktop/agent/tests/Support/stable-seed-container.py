#!/usr/bin/python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Synthetic Docker execution edge for real-Git tests in unprivileged CI."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

argv = sys.argv[1:]
root = Path(__file__).parent.parent
image = 'sha256:' + 'a' * 64
if argv[:2] == ['image', 'inspect']:
    print(image + ' null')
    sys.exit(0)
cmd = argv[argv.index('/usr/bin/python3'):]
i = cmd.index('-c')
uid, gid = map(int, cmd[i+2:i+4])
operation = cmd[i+4]
with (root / 'helper-calls').open('a') as log:
    log.write(json.dumps(dict(argv=argv[:argv.index(image)], operation=operation)) + '\n')
paths = json.loads(cmd[i+5])
mounts = {}
for k, value in enumerate(argv):
    if value == '--mount':
        spec = dict(item.split('=', 1) for item in argv[k+1].split(',') if '=' in item)
        mounts[spec['dst']] = os.path.realpath(spec['src'])
with tempfile.TemporaryDirectory() as tmp:
    # Only copy the synthetic fixture's declared mounts. CI may itself run as
    # root: still execute *every* production reader/publisher as the chosen UID.
    stage = mounts.get('/seed/stage')
    for key, dest in list(paths.items()):
        if dest not in mounts:
            continue
        src, projected = mounts[dest], Path(tmp, key)
        if key == 'stage':
            projected.mkdir()
            os.chown(projected, uid, gid)
        elif os.path.isdir(src):
            shutil.copytree(src, projected, symlinks=True,
                            ignore=shutil.ignore_patterns('.git' if key == 'checkout' else 'info'))
        else:
            shutil.copyfile(src, projected)
        paths[key] = str(projected)
    if operation == 'publish' and (root / 'swap').exists():
        target = root / 'runtime/conversations/task/workspace'
        target.rename(target.parent / 'prior')
        target.mkdir()
    if operation == 'publish' and (root / 'substitute.bundle').exists():
        shutil.copyfile(root / 'substitute.bundle', paths['bundle'])
    cmd[i+5] = json.dumps(paths)
    if operation == 'bundle' and (root / 'overflow').exists():
        sys.stdout.buffer.write(b'0' * 1024**2)
        sys.exit(0)
    if operation == 'bundle' and (root / 'partial').exists():
        sys.stdout.buffer.write(b'incomplete transfer')
        sys.exit(1)
    if (root / 'offline').exists():
        sys.exit(125)
    os.chmod(tmp, 0o755)
    credentials = dict(user=uid, group=gid, extra_groups=[]) if os.geteuid() == 0 else {}
    code = subprocess.run(cmd, env={'PATH': '/usr/bin:/bin'}, **credentials).returncode
    if stage and not code:
        shutil.copytree(paths['stage'], stage, dirs_exist_ok=True)
    sys.exit(code)
