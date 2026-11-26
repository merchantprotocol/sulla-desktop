# SPDX-License-Identifier: GPL-2.0-or-later
"""Guest-side path broker. Only the confined helper interprets Git configuration."""
import contextlib
import ctypes
import fcntl
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


def require(ok, message):
    if not ok:
        raise ValueError(message)


class Handles(contextlib.ExitStack):
    """Walk every component with O_NOFOLLOW; inspect type before opening for I/O."""
    def pin(self, path, parent=None, kind=stat.S_ISDIR):
        path = Path(path)
        if parent is None:
            require(path.is_absolute(), 'absolute seed path required')
            parent = self.keep(os.open('/', os.O_RDONLY | os.O_DIRECTORY))
        parts = path.parts[1:] if path.is_absolute() else path.parts
        for i, name in enumerate(parts):
            require(name not in ('.', '..'), 'invalid path component')
            fd = self.keep(os.open(name, os.O_PATH | os.O_NOFOLLOW, dir_fd=parent))
            mode = os.fstat(fd).st_mode
            require((kind if i == len(parts)-1 else stat.S_ISDIR)(mode), 'invalid seed path type')
            parent = fd
        return parent

    def keep(self, fd):
        self.callback(os.close, fd)
        return fd

    @staticmethod
    def proc(fd):
        return f'/proc/{os.getpid()}/fd/{fd}'

    def text(self, fd):
        with open(self.proc(fd), 'rb') as f:
            data = f.read(8193)
        require(len(data) <= 8192, 'oversized seed pointer')
        return data.decode().removesuffix('\n')

    def optional(self, path, parent):
        try:
            return self.pin(path, parent, stat.S_ISREG)
        except FileNotFoundError:
            return None


class MountPins:
    """Docker receives only stable, broker-owned names, never a worker pathname."""
    def __init__(self, private, handles):
        self.private, self.handles = private, handles

    def bind(self, fd):
        is_dir = stat.S_ISDIR(os.fstat(fd).st_mode)
        if is_dir:
            dest = tempfile.mkdtemp(dir=self.private)
        else:
            leaf, dest = tempfile.mkstemp(dir=self.private)
            os.close(leaf)
        libc = ctypes.CDLL(None, use_errno=True)
        src, dst = os.fsencode(self.handles.proc(fd)), os.fsencode(dest)
        # Nonrecursive MS_BIND: do not project any subordinate host mounts.
        if libc.mount(src, dst, None, 4096, None):
            raise OSError(ctypes.get_errno(), 'cannot pin seed mount')
        def release():
            if libc.umount2(dst, 2):
                raise OSError(ctypes.get_errno(), 'cannot release seed mount')
            (os.rmdir if is_dir else os.unlink)(dest)
        self.handles.callback(release)
        return dest


class ContainerRunner:
    def __init__(self, image, uid, gid, helper):
        self.image, self.uid, self.gid, self.helper = image, uid, gid, helper

    def run(self, mounts, operation, paths, *args, output=None, limit=32768):
        cmd = ['docker', 'run', '--rm', '--pull=never', '--user', f'{self.uid}:{self.gid}',
               '--network', 'none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
               '--pids-limit=64', '--ipc=none', '--log-driver=none', '--workdir=/',
               '--tmpfs', '/tmp:rw,nodev,nosuid,noexec,size=256m,mode=1777', '--entrypoint=/usr/bin/env']
        for src, dest, writable in mounts:
            cmd += ['--mount', f'type=bind,src={src},dst={dest},bind-recursive=disabled' +
                    ('' if writable else ',readonly')]
        cmd += [self.image, '-i', 'PATH=/usr/bin:/bin', '/usr/bin/python3', '-IS', '-c', self.helper,
                str(self.uid), str(self.gid), operation, json.dumps(paths), *args]
        with subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as proc:
            try:
                if output is None:
                    result = proc.stdout.read(limit + 1)
                    require(len(result) <= limit, 'oversized helper response')
                else:
                    total = 0
                    while chunk := proc.stdout.read(65536):
                        total += len(chunk)
                        require(total <= limit, 'no space left on device for seed bundle and VM reserve')
                        output.write(chunk)
                    result = None
                require(proc.wait() == 0, 'confined seed ' + operation + ' failed')
                return result
            finally:
                if proc.poll() is None:
                    proc.kill()


class Checkout:
    def __init__(self, path, directory, handles, pins, private, allow_link):
        self.h, self.pins, self.private = handles, pins, private
        h = handles
        dot = h.pin('.git', directory, lambda m: stat.S_ISDIR(m) or stat.S_ISREG(m))
        self.linked = stat.S_ISREG(os.fstat(dot).st_mode)
        if self.linked:
            require(allow_link, 'linked recovery target refused')
            pointer = h.text(dot)
            require(pointer.startswith('gitdir: '), 'invalid worktree pointer')
            admin_path = Path(os.path.normpath(os.path.join(path, pointer[8:])))
            require(admin_path.parent.name == 'worktrees' and admin_path.parent.parent.name == '.git',
                    'invalid worktree administration directory')
            common = h.pin(admin_path.parent.parent)
            admin = h.pin(Path('worktrees', admin_path.name), common)
            require(h.text(h.pin('commondir', admin, stat.S_ISREG)) == '../..', 'invalid common directory')
            back = os.path.normpath(os.path.join(admin_path, h.text(h.pin('gitdir', admin, stat.S_ISREG))))
            require(back == str(path / '.git') and os.path.samestat(os.fstat(dot),
                    os.fstat(h.pin(back, kind=stat.S_ISREG))), 'unregistered worktree')
            self.name = admin_path.parent.parent.parent.name
        else:
            common = admin = dot
            self.name = path.name
        self.directory, self.common = directory, common
        head = h.pin('HEAD', admin, stat.S_ISREG)
        tip = h.text(head)
        self.ref = tip[5:] if tip.startswith('ref: ') else 'HEAD'
        require(self.ref == 'HEAD' or (self.ref.startswith('refs/heads/') and
                all(re.fullmatch(r'[A-Za-z0-9_.-]+', part) and part not in ('.', '..')
                    for part in self.ref.split('/'))), 'unsupported seed ref')
        self.files = {'objects': h.pin('objects', common), 'config': h.pin('config', common, stat.S_ISREG),
                      'packed': h.optional('packed-refs', common), 'index': h.optional('index', admin),
                      'tip': head if self.ref == 'HEAD' else h.optional(self.ref, common)}
        if self.ref != 'HEAD':
            self.files['tracking'] = h.optional('refs/remotes/origin/' + self.ref[11:], common)
        # Never permit worker-provided alternates, grafts or replacement refs.
        h.pin('info', self.files['objects'])
        self.mask = Path(private, 'mask-dir')
        self.mask.mkdir(exist_ok=True)
        self.mounts, self.paths = [], {'checkout': '/seed/checkout'}
        for key, fd in self.files.items():
            if fd is not None:
                self.paths[key] = '/seed/' + key
                self.mounts.append((pins.bind(fd), self.paths[key], False))
        self.mounts.append((str(self.mask), '/seed/objects/info', False))

    def read(self, runner, op, expected='', **kwargs):
        mounts = list(self.mounts)
        if op in ('bundle', 'size'):
            mask = self.mask
            if self.linked:
                mask = Path(self.private, 'mask-file')
                mask.touch(exist_ok=True)
            mounts += [(self.pins.bind(self.directory), self.paths['checkout'], False),
                       (str(mask), self.paths['checkout'] + '/.git', False)]
        return runner.run(mounts, op, self.paths, self.ref, expected, **kwargs)
