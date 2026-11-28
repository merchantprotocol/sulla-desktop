# SPDX-License-Identifier: GPL-2.0-or-later
# Loaded with SeedGit in the confined helper, not the broker.
class StableSeedPublisher:
    def __init__(self, paths):
        self.stage, self.bundle = Path(paths['stage']), paths['bundle']
        self.git = SeedGit(self.stage)

    def publish(self, metadata, source, reserve):
        ref, head, remote, tracking = json.loads(metadata)
        oid(head)
        origin_url(remote)
        if tracking:
            oid(tracking)
        if ref != 'HEAD':
            if not ref.startswith('refs/heads/') or ref[11:].startswith('-'):
                raise ValueError('unexpected seed branch')
            self.git.run('check-ref-format', ref)
        if any(self.stage.iterdir()):
            raise ValueError('nonempty seed staging')
        self.git.run('init', '-q', '--template=')
        self.git.run('bundle', 'verify', self.bundle)
        if self.git.run('bundle', 'list-heads', self.bundle).stdout != f'{head} {ref}\n'.encode():
            raise ValueError('bundle does not match approved ref and OID')
        self.git.run('-c', 'transfer.fsckObjects=true', 'bundle', 'unbundle', self.bundle)
        if self.git.run('fsck', '--connectivity-only', '--no-reflogs', '--unreachable', head).stdout:
            raise ValueError('bundle contains objects outside the approved history')
        # Check expanded checkout bytes, not just compressed bundle bytes. Count
        # a repeated blob once per tree entry, including sparse source files.
        space = os.statvfs(self.stage)
        available = space.f_frsize * space.f_bavail - int(reserve) * 1024
        listing = self.git.run('ls-tree', '-rtl', '--full-tree', head).stdout
        block = max(4096, space.f_frsize)
        for line in listing.splitlines():
            _, kind, _, size = line.split(b'\t', 1)[0].split()
            # A gitlink checks out as an empty directory; its objects are never fetched.
            available -= block + (0 if kind in (b'tree', b'commit') else (int(size) + block - 1) // block * block)
            if available < 0:
                sys.exit(79)  # Broker maps reserve exhaustion without forwarding worker stderr.
        self.git.run('checkout', '--no-recurse-submodules', '--detach', head)
        if ref != 'HEAD':
            self.git.run('checkout', '--no-recurse-submodules', '-B', ref[11:], head)
        if self.git.run('rev-parse', 'HEAD').stdout != (head + '\n').encode():
            raise ValueError('published HEAD mismatch')
        if remote:
            self.git.run('remote', 'add', 'origin', remote)
        if tracking and ref != 'HEAD' and self.git.run('cat-file', '-e', tracking + '^{commit}', check=False).returncode == 0:
            self.git.run('update-ref', 'refs/remotes/origin/' + ref[11:], tracking)
        (self.stage / '.git' / 'sulla-workspace-binding').write_text(f'{source}\n{head}\n')


uid, gid, op, paths, *args = sys.argv[1:]
confined_identity(uid, gid)
paths = json.loads(paths)
if op == 'publish':
    StableSeedPublisher(paths).publish(*args)
elif op == 'size':
    sizes = subprocess.check_output(['du', '-sk', paths['checkout'], paths['objects']])
    print(sum(int(line.split()[0]) for line in sizes.splitlines()))
else:
    read_seed(op, paths, *args)
