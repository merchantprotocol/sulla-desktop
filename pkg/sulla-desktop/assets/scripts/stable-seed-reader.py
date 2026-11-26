# SPDX-License-Identifier: GPL-2.0-or-later
"""Executed only by the numeric non-root helper entrypoint, never by guest root."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote_to_bytes, urlsplit


class SeedGit:
    def __init__(self, directory):
        self.directory = directory
        self.env = dict(PATH='/usr/bin:/bin', HOME='/nonexistent', LC_ALL='C',
                        GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                        GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0',
                        GIT_NO_REPLACE_OBJECTS='1', GIT_ATTR_NOSYSTEM='1')

    def run(self, *args, stdout=subprocess.PIPE, check=True):
        return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                               '-c', 'protocol.allow=never', '-c', 'core.untrackedCache=false',
                               '-C', self.directory, *args], env=self.env, stdout=stdout,
                              stderr=subprocess.DEVNULL, check=check)


def oid(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('unsupported or invalid Git object ID')
    return value


def origin_url(value):
    if not value:
        return value
    # Check the literal before urlsplit (it strips some controls). Keep encoded
    # path bytes verbatim for Git; decoding here is ONLY for the control check.
    if (not value.isascii() or re.search(r'[\x00-\x20\x7f]|%(?![0-9a-fA-F]{2})', value)
            or re.search(rb'[\x00-\x1f\x7f]', unquote_to_bytes(value))):
        raise ValueError('unsupported Git origin')
    label = r'[A-Za-z0-9_~](?:[A-Za-z0-9_~-]{0,61}[A-Za-z0-9_~])?'
    host = rf'{label}(?:\.{label})*\.?'
    # Existing credential-free local and scp-style forms, not URL authorities.
    if re.fullmatch(rf'/(?!/)[A-Za-z0-9./@:_~-]*|git@{host}:[A-Za-z0-9._/-]+', value):
        return value
    u = urlsplit(value)
    authority = rf'(?:{host}|\[[0-9a-fA-F:.]+\])(?::[0-9]+)?'
    # urlsplit validates bracketed IPv6; .port also checks the numeric range.
    if (u.scheme not in ('http', 'https', 'ssh') or u.username is not None or u.password is not None
            or not re.fullmatch(authority, u.netloc) or u.port == 0 or '?' in value or '#' in value
            or not re.fullmatch(r"[A-Za-z0-9._~!$&'()*+,;=:@/%-]*", u.path)):
        raise ValueError('unsupported Git origin')
    return value


class SeedSourceRepository:
    def __init__(self, git, paths, ref, read_origin=True):
        self.git, self.paths, self.ref = git, paths, ref
        self.git.run('init', '--quiet', '--template=')
        gitdir = Path(git.directory, '.git')
        self.git.env.update(GIT_DIR=str(gitdir), GIT_WORK_TREE=paths['checkout'],
                            GIT_ALTERNATE_OBJECT_DIRECTORIES=paths['objects'])
        if ref != 'HEAD':
            self.git.run('check-ref-format', ref)
            if not ref.startswith('refs/heads/') or ref[11:].startswith('-'):
                raise ValueError('invalid seed branch')
        self.tracking = 'refs/remotes/origin/' + ref[11:] if ref != 'HEAD' else ''
        refs = {}
        if 'packed' in paths:
            with open(paths['packed'], 'rb') as packed:
                for line in packed:
                    words = line.split()
                    if len(words) == 2 and words[1] in (ref.encode(), self.tracking.encode()):
                        refs[words[1].decode()] = oid(words[0].decode())
        for name, label in ((ref, 'tip'), (self.tracking, 'tracking')):
            if label in paths:
                with open(paths[label]) as f:
                    refs[name] = oid(f.read(128).strip())
        self.head = refs[ref]
        self.remote_head = refs.get(self.tracking, '')
        if ref != 'HEAD':
            f = gitdir / ref
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text(self.head + '\n')
        (gitdir / 'HEAD').write_text(('ref: ' + ref if ref != 'HEAD' else self.head) + '\n')
        if 'index' in paths:
            shutil.copyfile(paths['index'], gitdir / 'index')
        self.git.run('cat-file', '-e', self.head + '^{commit}')
        # Read only this pinned file. Never adopt it as Git configuration or follow includes.
        version = self.git.run('config', '--no-includes', '--file', paths['config'], '--get-all',
                               'core.repositoryformatversion', check=False)
        if version.returncode or version.stdout.strip() not in (b'0', b'1'):
            raise ValueError('unsupported source repository format')
        extensions = self.git.run('config', '--no-includes', '--file', paths['config'], '--name-only',
                                  '--get-regexp', r'^extensions\.', check=False)
        if extensions.returncode not in (0, 1) or set(extensions.stdout.splitlines()) - {b'extensions.worktreeconfig'}:
            raise ValueError('unsupported source repository format')
        self.origin = ''
        if not read_origin:  # Module origins are neither used nor published.
            return
        result = self.git.run('config', '--no-includes', '--file', paths['config'], '--get-all',
                              'remote.origin.url', check=False)
        if result.returncode not in (0, 1):
            raise ValueError('invalid source origin')
        self.origin = origin_url(result.stdout.decode().removesuffix('\n'))

    def metadata(self):
        return [self.ref, self.head, self.origin, self.remote_head]

    def gitlinks(self):
        # Names are NUL-delimited data, not pathspecs. Bind them to this commit, not a mutable index.
        tree = self.git.run('ls-tree', '-rz', '--full-tree', self.head).stdout
        links = []
        for record in tree.split(b'\0'):
            if record.startswith(b'160000 commit '):
                entry, name = record.split(b'\t', 1)
                links.append((os.fsdecode(name), oid(entry.split()[2].decode())))
        return links

    def check_clean(self):
        # Do not trust the worker's cached stat/assume-valid/skip-worktree flags.
        # A fresh index also avoids executing split-index and fsmonitor extensions.
        index = Path(self.git.env['GIT_DIR'], 'index')
        if not index.exists() or self.git.run('write-tree').stdout.strip() != self.git.run(
                'rev-parse', self.head + '^{tree}').stdout.strip():
            raise ValueError('container workspacePath must be clean before guest transport')
        index.unlink()
        self.git.run('read-tree', self.head)
        if self.git.run('status', '--porcelain=v1', '--ignore-submodules=all', '--untracked-files=normal').stdout:
            raise ValueError('container workspacePath must be clean before guest transport')

    def probe(self, operation, expected):
        if operation == 'legacy':
            self.git.run('merge-base', '--is-ancestor', oid(expected), 'HEAD')
        print(json.dumps(self.metadata()))


def read_seed(operation, paths, ref, expected):
    with tempfile.TemporaryDirectory() as scratch:
        if operation not in ('bundle', 'clean'):
            paths['checkout'] = scratch
        repo = SeedSourceRepository(SeedGit(scratch), paths, ref, read_origin=operation != 'clean')
        if operation == 'bundle':
            if repo.metadata() != json.loads(expected):
                raise ValueError('approved Git ref moved during transport')
            repo.check_clean()
            repo.git.run('bundle', 'create', '-', repo.ref, stdout=sys.stdout.buffer)
        elif operation == 'clean':
            if repo.head != oid(expected):
                raise ValueError('initialized submodule HEAD differs from recorded gitlink')
            repo.check_clean()
            print(json.dumps(repo.gitlinks()))
        elif operation == 'inspect':
            print(json.dumps([repo.metadata(), repo.gitlinks()]))
        else:
            repo.probe(operation, expected)


def confined_identity(uid, gid):
    if int(uid) <= 0 or int(gid) <= 0 or (os.geteuid(), os.getegid()) != (int(uid), int(gid)):
        raise ValueError('invalid helper identity')
    if set(os.getgroups()) - {int(gid)}:
        raise ValueError('unexpected supplementary groups')
    # Read-only mounts do not by themselves disable Unix domain sockets.
    import ctypes
    sec = ctypes.CDLL('libseccomp.so.2')
    sec.seccomp_init.restype = ctypes.c_void_p
    ctx = ctypes.c_void_p(sec.seccomp_init(0x7fff0000))  # SCMP_ACT_ALLOW
    if not ctx:
        raise ValueError('socket isolation unavailable')
    try:
        for name in (b'socket', b'socketpair', b'connect', b'io_uring_setup'):
            nr = sec.seccomp_syscall_resolve_name(name)
            if nr < 0 or sec.seccomp_rule_add(ctx, 0x00050001, nr, 0):  # ERRNO(EPERM)
                raise ValueError('socket isolation unavailable')
        if sec.seccomp_load(ctx):
            raise ValueError('socket isolation unavailable')
    finally:
        sec.seccomp_release(ctx)
