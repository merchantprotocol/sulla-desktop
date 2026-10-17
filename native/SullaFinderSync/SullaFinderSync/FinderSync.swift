import Cocoa
import Darwin
import FinderSync

private let syncAttribute = "io.sulla.files.sync-state"
private let appGroup = "group.io.sulla.desktop"

final class FinderSync: FIFinderSync {
    private var watchedRoot: URL?
    private var directorySource: DispatchSourceFileSystemObject?
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
        visibleURLs.insert(url.standardizedFileURL)
        let state = extendedAttribute(url: url, name: syncAttribute) ?? "unknown"
        FIFinderSyncController.default().setBadgeIdentifier(state, for: url)
    }

    override func endObservingDirectory(at url: URL) {
        visibleURLs = Set(visibleURLs.filter { !$0.path.hasPrefix(url.standardizedFileURL.path) })
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        let controller = FIFinderSyncController.default()
        guard let target = controller.targetedURL() else { return nil }
        let selection = controller.selectedItemURLs() ?? []
        let targets = selection.contains(target) ? selection : [target]
        let menu = NSMenu(title: "Sulla Files")
        add(menu, title: targets.count > 1 ? "Review sharing for selected items" : "Share with Sulla", action: #selector(share(_:)), targets: targets)
        add(menu, title: targets.count > 1 ? "Version history for selected items" : "Version history", action: #selector(history(_:)), targets: targets)
        menu.addItem(.separator())
        unavailable(menu, title: "Keep on this Mac — unavailable")
        unavailable(menu, title: "Make online only — unavailable")
        return menu
    }

    private func add(_ menu: NSMenu, title: String, action: Selector, targets: [URL]) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self; item.representedObject = targets; menu.addItem(item)
    }
    private func unavailable(_ menu: NSMenu, title: String) { let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item) }

    @objc private func share(_ sender: NSMenuItem) { open(action: "share", sender: sender) }
    @objc private func history(_ sender: NSMenuItem) { open(action: "history", sender: sender) }
    private func open(action: String, sender: NSMenuItem) {
        guard let files = sender.representedObject as? [URL] else { return }
        for file in files {
            guard var parts = URLComponents(string: "sulla://files/\(action)") else { continue }
            parts.queryItems = [URLQueryItem(name: "path", value: file.path)]
            if let url = parts.url { NSWorkspace.shared.open(url) }
        }
    }

    private func subscribe(to root: URL) {
        let descriptor = open(root.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .attrib, .rename], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            for url in self.visibleURLs { self.requestBadgeIdentifier(for: url) }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume(); directorySource = source
    }

    private func extendedAttribute(url: URL, name: String) -> String? {
        let length = getxattr(url.path, name, nil, 0, 0, 0)
        guard length > 0 else { return nil }
        var data = Data(count: length)
        let result = data.withUnsafeMutableBytes { getxattr(url.path, name, $0.baseAddress, length, 0, 0) }
        guard result == length else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
