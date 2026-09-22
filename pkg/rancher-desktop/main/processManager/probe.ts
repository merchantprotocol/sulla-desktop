/** Linux-only, standard-library probe. No command lines or environments leave the VM. */
export const VM_PROBE = String.raw`
import json, os, pwd, signal, sys, time
from pathlib import Path

CRITICAL = {'init', 'systemd', 'sshd', 'sshd-session', 'dockerd', 'containerd', 'containerd-shim', 'containerd-shim-runc-v2', 'postgres', 'redis-server', 'k3s', 'sulla-proxy', 'sulla'}

def text(path):
    return Path(path).read_text()

def process(pid):
    base = '/proc/' + str(pid)
    stat = text(base + '/stat')
    end = stat.rfind(')')
    fields = stat[end + 2:].split()
    uid = Path(base).stat().st_uid
    name = stat[stat.find('(') + 1:end]
    try:
        executable = os.path.basename(os.readlink(base + '/exe'))
    except OSError:
        executable = name
    try:
        user = pwd.getpwuid(uid).pw_name
    except KeyError:
        user = str(uid)
    reason = ''
    if pid <= 1 or not Path(base + '/cmdline').read_bytes():
        reason = 'Kernel or VM system process'
    elif uid == 0:
        reason = 'Root-owned process; manage through its service or container'
    elif name in CRITICAL or executable in CRITICAL or executable.startswith('containerd-shim'):
        reason = 'Core service'
    elif uid != os.getuid():
        reason = 'Owned by another VM user'
    return dict(pid=pid, name=name, user=user, uid=uid, state=fields[0], parent=int(fields[1]),
                started=fields[19], ticks=int(fields[11]) + int(fields[12]),
                memory=max(0, int(fields[21])) * os.sysconf('SC_PAGE_SIZE'), protected=reason)

def snapshot():
    processes = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            processes.append(process(int(entry.name)))
        except (OSError, ValueError, IndexError):
            pass
    memory = {}
    for line in text('/proc/meminfo').splitlines():
        key, value = line.split(':', 1)
        memory[key] = int(value.split()[0]) * 1024
    cpu_lines = text('/proc/stat').splitlines()
    # guest/guest_nice are already included in user/nice.
    cpu = [int(v) for v in cpu_lines[0].split()[1:9]]
    filesystems = []
    seen = set()
    for line in text('/proc/mounts').splitlines():
        dev, mount, kind = line.split()[:3]
        if kind != 'tmpfs':
            continue
        try:
            mount = mount.replace('\\040', ' ')
            fs = os.statvfs(mount)
            identity = os.stat(mount).st_dev
            if identity in seen:
                continue
            seen.add(identity)
            filesystems.append(dict(path=mount, total=fs.f_blocks * fs.f_frsize,
                                    used=(fs.f_blocks - fs.f_bfree) * fs.f_frsize))
        except OSError:
            pass
    return dict(boot=text('/proc/sys/kernel/random/boot_id').strip(), timestamp=time.monotonic(),
                cores=sum(1 for line in cpu_lines if line.startswith('cpu') and line[3:4].isdigit()),
                totalTicks=sum(cpu), idleTicks=cpu[3] + cpu[4], ticksPerSecond=os.sysconf('SC_CLK_TCK'),
                memoryTotal=memory['MemTotal'], memoryAvailable=memory['MemAvailable'],
                shared=memory.get('Shmem', 0), cache=memory.get('Cached', 0),
                swapTotal=memory['SwapTotal'], swapUsed=memory['SwapTotal'] - memory['SwapFree'],
                processes=processes, filesystems=filesystems)

def terminate(request):
    pid = request.get('pid')
    if type(pid) is not int or pid <= 1 or request.get('signal') not in ('TERM', 'KILL'):
        raise ValueError('Invalid process or signal')
    if request.get('boot') != text('/proc/sys/kernel/random/boot_id').strip():
        raise ValueError('VM restarted. Refresh and select the process again.')
    # Pin the kernel process identity before inspecting it. Never fall back to os.kill.
    fd = os.pidfd_open(pid)
    try:
        current = process(pid)
        if current['started'] != request.get('started'):
            raise ValueError('Process changed. Refresh and select it again.')
        if current['protected']:
            raise ValueError(current['protected'])
        signal.pidfd_send_signal(fd, signal.SIGTERM if request['signal'] == 'TERM' else signal.SIGKILL)
    finally:
        os.close(fd)
    return dict(sent=True)

if __name__ == '__main__':
    try:
        request = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        print(json.dumps(terminate(request) if request.get('action') == 'terminate' else snapshot()))
    except Exception as error:
        print(json.dumps(dict(error=str(error))))
        sys.exit(1)
`;
