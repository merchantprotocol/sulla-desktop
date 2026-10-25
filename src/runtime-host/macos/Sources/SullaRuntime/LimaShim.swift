import Darwin
import Foundation

// While Desktop runs on the Sulla runtime, its many `limactl shell 0 ...`
// call sites keep working unchanged: Desktop points them at a `limactl`
// symlink to this binary, and these few subcommands map onto guest exec.
// Lifecycle commands are owned by Desktop's runtime backend, not by callers.

private func guestDirectoryExists(_ socketPath: String, _ path: String) -> Bool {
    let devNull = open("/dev/null", O_RDWR)
    let saved = (dup(STDIN_FILENO), dup(STDOUT_FILENO), dup(STDERR_FILENO))
    dup2(devNull, STDIN_FILENO); dup2(devNull, STDOUT_FILENO); dup2(devNull, STDERR_FILENO)
    let code = runGuestCommand(socketPath: socketPath, argv: ["test", "-d", path], workdir: "/", env: [])
    dup2(saved.0, STDIN_FILENO); dup2(saved.1, STDOUT_FILENO); dup2(saved.2, STDERR_FILENO)
    close(saved.0); close(saved.1); close(saved.2); close(devNull)
    return code == 0
}

private func shell(_ socketPath: String, _ arguments: [String]) -> Int32 {
    var workdir: String?
    var rest = arguments[...]
    while let first = rest.first, first.hasPrefix("-") {
        rest = rest.dropFirst()
        if first == "--" { break }
        if first.hasPrefix("--workdir=") {
            workdir = String(first.dropFirst("--workdir=".count))
        } else if first == "--workdir", let value = rest.first {
            workdir = value; rest = rest.dropFirst()
        }
    }
    // Instance name, then an optional "--" before the command.
    guard rest.first != nil else { fputs("limactl shell: missing instance\n", stderr); return 2 }
    rest = rest.dropFirst()
    if rest.first == "--" { rest = rest.dropFirst() }
    var argv = Array(rest)
    if argv.isEmpty { argv = ["/bin/sh", "-l"] }
    // Lima starts in the caller's directory when the guest has it.
    if workdir == nil || workdir == "." { workdir = FileManager.default.currentDirectoryPath }
    if let directory = workdir, !guestDirectoryExists(socketPath, directory) { workdir = "/" }
    return runGuestCommand(socketPath: socketPath, argv: argv, workdir: workdir, env: [])
}

func runLimaShim(socketPath: String, controlPath: String, _ arguments: [String]) -> Int32 {
    var rest = arguments[...]
    while let first = rest.first, first.hasPrefix("-") { rest = rest.dropFirst() }  // --debug, --tty=false
    guard let command = rest.first else { fputs("limactl: missing command\n", stderr); return 2 }
    let tail = Array(rest.dropFirst())
    switch command {
    case "shell": return shell(socketPath, tail)
    case "copy", "cp": return runCopyCommand(socketPath: socketPath, tail)
    case "list", "ls":
        let running = (try? connectUnixSocket(path: controlPath)).map { descriptor -> Bool in close(descriptor); return true } ?? false
        print("{\"name\":\"0\",\"status\":\"\(running ? "Running" : "Stopped")\",\"vmType\":\"sulla\"}")
        return 0
    default:
        fputs("limactl \(command): not available on the Sulla runtime\n", stderr)
        return 1
    }
}
