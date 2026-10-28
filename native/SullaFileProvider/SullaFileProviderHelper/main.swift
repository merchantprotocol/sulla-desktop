// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import FileProvider
import Foundation

// Domain management for Sulla Desktop. NSFileProviderManager only accepts calls
// from the extension's containing app, so this tool ships at
// Sulla Desktop.app/Contents/MacOS/SullaFileProviderHelper, where Bundle.main
// resolves to the app. Main invokes it; it prints one JSON object and exits.
//   add --id <domain> --name <display name>
//   remove --id <domain>          (keeps unsynced edits; prints where)
//   status
//   signal --id <domain>          (working-set changed)

func emit(_ object: [String: Any], code: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(code)
}

func fail(_ message: String) -> Never { emit(["ok": false, "error": message], code: 1) }

func option(_ name: String) -> String? {
    let arguments = CommandLine.arguments
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
    return arguments[index + 1]
}

func waitFor<T>(_ start: (@escaping (T) -> Void) -> Void) -> T {
    let semaphore = DispatchSemaphore(value: 0)
    var value: T?
    start { value = $0; semaphore.signal() }
    if semaphore.wait(timeout: .now() + 25) == .timedOut { fail("File Provider did not answer in time") }
    return value!
}

func domainIdentifier() -> String {
    guard let id = option("--id"), id.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil else { fail("a valid --id is required") }
    return id
}

func domains() -> [NSFileProviderDomain] {
    let (found, error): ([NSFileProviderDomain], Error?) = waitFor { done in NSFileProviderManager.getDomainsWithCompletionHandler { done(($0, $1)) } }
    if let error { fail(error.localizedDescription) }
    return found
}

func existing(_ id: String) -> NSFileProviderDomain? {
    domains().first { $0.identifier.rawValue == id }
}

guard CommandLine.arguments.count >= 2 else { fail("usage: SullaFileProviderHelper add|remove|status|signal") }

switch CommandLine.arguments[1] {
case "add":
    let id = domainIdentifier()
    guard let name = option("--name"), !name.isEmpty, name.count <= 64, !name.contains("/") else { fail("a valid --name is required") }
    let domain = NSFileProviderDomain(identifier: NSFileProviderDomainIdentifier(rawValue: id), displayName: name)
    let error: Error? = waitFor { done in NSFileProviderManager.add(domain) { done($0) } }
    if let error { fail(error.localizedDescription) }
    emit(["ok": true, "identifier": id])
case "remove":
    let id = domainIdentifier()
    guard let domain = existing(id) else { emit(["ok": true, "identifier": id, "removed": false]) }
    // preserveDirtyUserData: edits not yet in Files are moved aside, never discarded.
    let (preserved, error): (URL?, Error?) = waitFor { done in NSFileProviderManager.remove(domain, mode: .preserveDirtyUserData) { done(($0, $1)) } }
    if let error { fail(error.localizedDescription) }
    emit(["ok": true, "identifier": id, "removed": true, "preservedLocation": preserved?.path ?? NSNull()])
case "status":
    emit(["ok": true, "domains": domains().map { ["identifier": $0.identifier.rawValue, "displayName": $0.displayName, "userEnabled": $0.userEnabled] }])
case "signal":
    let id = domainIdentifier()
    guard let domain = existing(id), let manager = NSFileProviderManager(for: domain) else { fail("domain is not registered") }
    let error: Error? = waitFor { done in manager.signalEnumerator(for: .workingSet) { done($0) } }
    if let error { fail(error.localizedDescription) }
    emit(["ok": true])
default:
    fail("unknown command")
}
