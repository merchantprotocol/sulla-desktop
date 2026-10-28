// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import FileProvider

/// Directory enumerators list one container; the working set follows the Files
/// journal (sync anchor = per-collection journal seq, minted by main).
final class SullaEnumerator: NSObject, NSFileProviderEnumerator {
    private let container: NSFileProviderItemIdentifier
    private let queue: DispatchQueue
    private let pageSize = 200

    init(container: NSFileProviderItemIdentifier, queue: DispatchQueue) {
        self.container = container
        self.queue = queue
    }

    func invalidate() {}

    func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
        queue.async {
            do {
                // The working set starts from the collections; journal changes fill in the rest.
                let id = self.container == .workingSet ? "root" : SullaItem.wire(self.container)
                let items = (try RelayClient.shared.call("list", ["id": id])["items"] as? [[String: Any]] ?? []).map(SullaItem.init)
                let start = Self.offset(page)
                let end = min(start + self.pageSize, items.count)
                if start < end { observer.didEnumerate(Array(items[start..<end])) }
                observer.finishEnumerating(upTo: end < items.count ? NSFileProviderPage(withUnsafeBytes(of: Int64(end).bigEndian) { Data($0) }) : nil)
            } catch {
                observer.finishEnumeratingWithError(error.asFileProviderError)
            }
        }
    }

    func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
        queue.async {
            guard self.container == .workingSet else {
                // Replicated domains read changes from the working set; directories re-list on demand.
                observer.finishEnumeratingChanges(upTo: anchor, moreComing: false)
                return
            }
            do {
                guard let token = String(data: anchor.rawValue, encoding: .utf8) else { throw NSFileProviderError(.syncAnchorExpired) }
                let result = try RelayClient.shared.call("changes", ["token": token])
                let updated = (result["updated"] as? [[String: Any]] ?? []).map(SullaItem.init)
                let deleted = (result["deleted"] as? [String] ?? []).map(SullaItem.identifier)
                if !updated.isEmpty { observer.didUpdate(updated) }
                if !deleted.isEmpty { observer.didDeleteItems(withIdentifiers: deleted) }
                let next = NSFileProviderSyncAnchor(Data((result["token"] as? String ?? token).utf8))
                observer.finishEnumeratingChanges(upTo: next, moreComing: result["more"] as? Bool ?? false)
            } catch {
                observer.finishEnumeratingWithError(error.asFileProviderError)
            }
        }
    }

    func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
        queue.async {
            guard let token = try? RelayClient.shared.call("anchor")["token"] as? String else { completionHandler(nil); return }
            completionHandler(NSFileProviderSyncAnchor(Data(token.utf8)))
        }
    }

    private static func offset(_ page: NSFileProviderPage) -> Int {
        let data = page.rawValue
        if data == NSFileProviderPage.initialPageSortedByName as Data || data == NSFileProviderPage.initialPageSortedByDate as Data || data.count != 8 { return 0 }
        return Int(data.withUnsafeBytes { Int64(bigEndian: $0.loadUnaligned(as: Int64.self)) })
    }
}
