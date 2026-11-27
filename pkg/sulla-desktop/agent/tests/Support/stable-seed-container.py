#!/usr/bin/python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Synthetic Docker execution edge for real-Git tests in unprivileged CI."""
import json
import os
from pathlib import Path
import signal
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
# Minimal daemon edge: only full IDs matching the requested run label may be removed.
helpers = root / 'helpers'
registry = json.loads(helpers.read_text()) if helpers.exists() else {}
if argv[0] == 'ps':
    match = argv[argv.index('--filter') + 1].removeprefix('label=')
    for ident, label in registry.items():
        if label == match:
            print(ident)
    sys.exit(0)
if argv[:2] == ['rm', '-f']:
    for ident in argv[2:]:
        del registry[ident]
    helpers.write_text(json.dumps(registry))
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
if operation == 'publish' and (root / 'kill-on-publish').exists():
    (root / 'kill-on-publish').unlink()
    stage = Path(mounts['/seed/stage'])
    (root / 'abandoned-stage').write_text(str(stage))
    pin = stage.parent / 'pin-interrupted space'
    (root / 'external-source').rename(pin)  # Synthetic mounted contents until detach.
    with (root / 'mountinfo').open('a') as table:
        table.write('2 1 8:1 /source ' + str(pin).replace(' ', r'\040') + ' rw - ext4 /dev/root rw\n')
    label = argv[argv.index('--label') + 1] if '--label' in argv else ''
    helpers.write_text(json.dumps({'a' * 64: label, 'b' * 64: 'unrelated'}))
    (stage / 'outside-link').symlink_to(root)
    (stage / 'partial').write_text('unpublished')
    os.kill(os.getppid(), signal.SIGKILL)  # This fixture is the broker's direct subprocess.
    sys.exit(1)
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
                            ignore=lambda dirname, _: (['.git'] if key == 'checkout' else ['info'])
                            if dirname == src else [])
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
