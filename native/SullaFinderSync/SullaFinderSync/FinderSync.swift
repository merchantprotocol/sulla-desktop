import Cocoa
import CoreServices
import Darwin
import FinderSync

private let syncAttribute = "io.sulla.files.sync-state"
private let appGroup = "group.io.sulla.desktop"

final class FinderSync: FIFinderSync {
    private var watchedRoot: URL?
    private var eventStream: FSEventStreamRef?
    private var visibleURLs = Set<URL>()

    override init() {
        super.init()
        if let configured = UserDefaults(suiteName: appGroup)?.string(forKey: "FilesRoot"), !configured.isEmpty {
            let root = URL(fileURLWithPath: configured, isDirectory: true).standardizedFileURL
            watchedRoot = root
            FIFinderSyncController.default().directoryURLs = [root]
            subscribe(to: root)
        } else {
            // Fail closed: the extension's sandbox home is not the user's home.
            FIFinderSyncController.default().directoryURLs = []
        }
        registerBadges()
    }

    private func registerBadges() {
        let controller = FIFinderSyncController.default()
        controller.setBadgeImage(badge(color: .systemGreen, symbol: "checkmark"), label: "Kept on this Mac", forBadgeIdentifier: "synced")
        controller.setBadgeImage(badge(color: .systemBlue, symbol: "arrow.triangle.2.circlepath"), label: "Syncing", forBadgeIdentifier: "syncing")
        controller.setBadgeImage(badge(color: .secondaryLabelColor, symbol: "icloud"), label: "Online only", forBadgeIdentifier: "online-only")
        controller.setBadgeImage(badge(color: .systemRed, symbol: "exclamationmark"), label: "Conflict", forBadgeIdentifier: "conflict")
        controller.setBadgeImage(badge(color: .systemGray, symbol: "questionmark"), label: "Sync state unavailable", forBadgeIdentifier: "unknown")
    }

    private func badge(color: NSColor, symbol: String) -> NSImage {
        let image = NSImage(size: NSSize(width: 16, height: 16))
        image.lockFocus()
        color.setFill(); NSBezierPath(ovalIn: NSRect(x: 1, y: 1, width: 14, height: 14)).fill()
        if let icon = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) {
            icon.withSymbolConfiguration(.init(pointSize: 9, weight: .bold))?.draw(in: NSRect(x: 3.5, y: 3.5, width: 9, height: 9))
        }
        image.unlockFocus(); image.isTemplate = false
        return image
    }

    override func requestBadgeIdentifier(for url: URL) {
        let target = url.standardizedFileURL
        guard isInsideWatchedRoot(target) else { return }
        visibleURLs.insert(target)
        DispatchQueue.global(qos: .utility).async {
            let state = self.badgeIdentifier(at: target)
            DispatchQueue.main.async {
                FIFinderSyncController.default().setBadgeIdentifier(state, for: url)
            }
        }
    }

    override func endObservingDirectory(at url: URL) {
        let directory = url.standardizedFileURL
        visibleURLs = Set(visibleURLs.filter { !isWithinDirectory($0, inside: directory) })
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        let controller = FIFinderSyncController.default()
        guard let target = controller.targetedURL() else { return nil }
        let selection = (controller.selectedItemURLs() ?? []).filter(isInsideWatchedRoot)
        let targets = selection.contains(target) ? selection : [target].filter(isInsideWatchedRoot)
        guard !targets.isEmpty else { return nil }
        let menu = NSMenu(title: "Sulla Files")
        if targets.count == 1 {
            add(menu, title: "Copy Sulla link", action: #selector(copyLink(_:)), targets: targets)
        }
        add(menu, title: targets.count > 1 ? "Share selected items with people…" : "Share with people…", action: #selector(share(_:)), targets: targets)
        add(menu, title: targets.count > 1 ? "Version history for selected items" : "Version history", action: #selector(history(_:)), targets: targets)
        menu.addItem(.separator())
        unavailable(menu, title: "Keep on this Mac — unavailable")
        unavailable(menu, title: "Free up space — unavailable")
        return menu
    }

    private func add(_ menu: NSMenu, title: String, action: Selector, targets: [URL]) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self; item.representedObject = targets; menu.addItem(item)
    }
    private func unavailable(_ menu: NSMenu, title: String) { let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item) }

    @objc private func copyLink(_ sender: NSMenuItem) { open(action: "copy-link", sender: sender) }
    @objc private func share(_ sender: NSMenuItem) { open(action: "share", sender: sender) }
    @objc private func history(_ sender: NSMenuItem) { open(action: "history", sender: sender) }
    private func open(action: String, sender: NSMenuItem) {
        guard let files = sender.representedObject as? [URL] else { return }
        for file in files.map(\.standardizedFileURL).filter(isInsideWatchedRoot) {
            guard var parts = URLComponents(string: "sulla://files/\(action)") else { continue }
            parts.queryItems = [URLQueryItem(name: "path", value: file.path)]
            if let url = parts.url { NSWorkspace.shared.open(url) }
        }
    }

    private func subscribe(to root: URL) {
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, clientInfo, _, _, _, _ in
            guard let clientInfo else { return }
            let instance = Unmanaged<FinderSync>.fromOpaque(clientInfo).takeUnretainedValue()
            DispatchQueue.main.async { instance.refreshVisibleBadges() }
        }
        guard let stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            [root.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.2,
            UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes)
        ) else { return }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.global(qos: .utility))
        guard FSEventStreamStart(stream) else {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            return
        }
        eventStream = stream
    }

    private func refreshVisibleBadges() {
        for url in visibleURLs { requestBadgeIdentifier(for: url) }
    }

    private func badgeIdentifier(at url: URL) -> String {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { return "unknown" }
        if !isDirectory.boolValue {
            return normalizedBadgeIdentifier(extendedAttribute(url: url, name: syncAttribute))
        }

        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return "unknown" }
        var states = Set<String>()
        for case let descendant as URL in enumerator {
            guard (try? descendant.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            states.insert(normalizedBadgeIdentifier(extendedAttribute(url: descendant, name: syncAttribute)))
            if states.contains("conflict") { return "conflict" }
        }
        if states.contains("syncing") { return "syncing" }
        if !states.isEmpty && states.isSubset(of: ["online-only"]) { return "online-only" }
        if states.contains("synced") { return "synced" }
        return "unknown"
    }

    private func normalizedBadgeIdentifier(_ value: String?) -> String {
        switch value {
        case "synced", "local", "kept": return "synced"
        case "syncing": return "syncing"
        case "online", "online-only": return "online-only"
        case "conflict", "error": return "conflict"
        default: return "unknown"
        }
    }

    private func isInsideWatchedRoot(_ url: URL) -> Bool {
        guard let watchedRoot else { return false }
        return isWithinDirectory(url, inside: watchedRoot)
    }

    private func isWithinDirectory(_ candidate: URL, inside directory: URL) -> Bool {
        let root = directory.standardizedFileURL.path
        let target = candidate.standardizedFileURL.path
        return target == root || target.hasPrefix(root + "/")
    }

    private func extendedAttribute(url: URL, name: String) -> String? {
        let length = getxattr(url.path, name, nil, 0, 0, 0)
        guard length > 0 else { return nil }
        var data = Data(count: length)
        let result = data.withUnsafeMutableBytes { getxattr(url.path, name, $0.baseAddress, length, 0, 0) }
        guard result == length else { return nil }
        return String(data: data, encoding: .utf8)
    }

    deinit {
        if let eventStream {
            FSEventStreamStop(eventStream)
            FSEventStreamInvalidate(eventStream)
            FSEventStreamRelease(eventStream)
        }
    }
}
