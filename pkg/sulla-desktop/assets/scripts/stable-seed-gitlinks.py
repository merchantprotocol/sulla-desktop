# SPDX-License-Identifier: GPL-2.0-or-later
"""Broker-side path pins only. The existing confined reader handles all Git."""
class GitlinkProbe:
    def __init__(self, seed):
        self.seed = seed

    def check(self, repo, source, links):
        pending = [(repo, source, links)]
        initialized = 0
        while pending:
            parent, checkout, links = pending.pop()
            if not links:
                continue
            # Walk the same nonrecursive mount view as Git, not a hidden subordinate guest mount.
            worktree = self.seed.pins.view(parent.directory)
            admin_path, admin_fd = parent.admin
            module = ModuleAdmin(self.seed.h, (admin_path, self.seed.pins.view(admin_fd)))
            for name, expected in links:
                require(all(p not in ('', '.', '..', '.git') for p in name.split('/')), 'invalid gitlink path')
                directory = self.seed.h.pin(name, worktree)
                with os.scandir(self.seed.h.proc(directory)) as entries:
                    if next(entries, None) is None:  # uninitialized: no bytes to preserve
                        continue
                initialized += 1
                require(initialized <= 32, 'too many initialized submodules for stable seeding')
                path = checkout / name
                child = Checkout(path, directory, self.seed.h, self.seed.pins, self.seed.private,
                                 False, module)
                nested = json.loads(child.read(self.seed.runner, 'clean', expected))
                pending.append((child, path, nested))


class ModuleAdmin:
    def __init__(self, handles, parent):
        self.handles, (self.path, self.directory) = handles, parent

    def pin_admin(self, checkout, pointer):
        require(pointer.startswith('gitdir: '), 'invalid submodule gitfile')
        raw = pointer[8:]
        target = Path(os.path.normpath(checkout / raw))
        relative = target.relative_to(self.path / 'modules')
        require(relative.parts and raw in (str(target), os.path.relpath(target, checkout)),
                'invalid submodule administration path')
        return target, self.handles.pin(Path('modules') / relative, self.directory)
