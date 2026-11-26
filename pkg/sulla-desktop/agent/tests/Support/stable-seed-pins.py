# SPDX-License-Identifier: GPL-2.0-or-later
# Injected at the broker's bind/umount syscall boundary in unprivileged CI.
class FixturePins(MountPins):
    def bind(self, fd):
        return self.handles.proc(fd)

    @staticmethod
    def detach(dest):
        fixture = Path(sys.argv[5]).parent
        if (fixture / 'deny-detach').exists():
            raise OSError('fixture refused detach')
        stage = Path((fixture / 'abandoned-stage').read_text())
        require(dest == stage.parent / 'pin-interrupted space', 'unexpected detach')
        dest.rename(fixture / 'external-source')
        dest.mkdir()
        table = fixture / 'mountinfo'
        table.write_bytes(b''.join(line for line in table.read_bytes().splitlines(keepends=True)
                                   if not line.startswith(b'2 1 ')))


main(FixturePins)
