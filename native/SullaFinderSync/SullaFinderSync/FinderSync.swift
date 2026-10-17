import Cocoa
import Darwin
import FinderSync

private let syncAttribute = "io.sulla.files.sync-state"

final class FinderSync: FIFinderSync {
    override init() {
        super.init()
        FIFinderSyncController.default().directoryURLs = [FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("sulla/Files", isDirectory: true)]
        registerBadges()
    }

    private func registerBadges() {
        let controller = FIFinderSyncController.default()
        controller.setBadgeImage(badge(color: .systemGreen, symbol: "checkmark"), label: "Kept on this Mac", forBadgeIdentifier: "synced")
        controller.setBadgeImage(badge(color: .systemBlue, symbol: "arrow.triangle.2.circlepath"), label: "Syncing", forBadgeIdentifier: "syncing")
        controller.setBadgeImage(badge(color: .secondaryLabelColor, symbol: "icloud"), label: "Online only", forBadgeIdentifier: "online-only")
        controller.setBadgeImage(badge(color: .systemRed, symbol: "exclamationmark"), label: "Conflict", forBadgeIdentifier: "conflict")
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
        let state = extendedAttribute(url: url, name: syncAttribute) ?? "synced"
        FIFinderSyncController.default().setBadgeIdentifier(state, for: url)
    }

    override func menu(for menuKind: FIMenuKind) -> NSMenu? {
        guard let target = FIFinderSyncController.default().targetedURL() else { return nil }
        let menu = NSMenu(title: "Sulla Files")
        add(menu, title: "Share with Sulla", action: #selector(share(_:)), target: target)
        add(menu, title: "Version history", action: #selector(history(_:)), target: target)
        menu.addItem(.separator())
        add(menu, title: "Keep on this Mac", action: #selector(keep(_:)), target: target)
        add(menu, title: "Make online only", action: #selector(onlineOnly(_:)), target: target)
        return menu
    }

    private func add(_ menu: NSMenu, title: String, action: Selector, target: URL) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self; item.representedObject = target; menu.addItem(item)
    }

    @objc private func share(_ sender: NSMenuItem) { open(action: "share", sender: sender) }
    @objc private func history(_ sender: NSMenuItem) { open(action: "history", sender: sender) }
    @objc private func keep(_ sender: NSMenuItem) { open(action: "keep", sender: sender) }
    @objc private func onlineOnly(_ sender: NSMenuItem) { open(action: "online-only", sender: sender) }

    private func open(action: String, sender: NSMenuItem) {
        guard let file = sender.representedObject as? URL, var parts = URLComponents(string: "sulla://files/\(action)") else { return }
        parts.queryItems = [URLQueryItem(name: "path", value: file.path)]
        if let url = parts.url { NSWorkspace.shared.open(url) }
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
