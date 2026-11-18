/// The files another app handed to yaran on iOS (G5), held in the app's private caches.
///
/// iOS delivers a shared file ("Open in yaran" from the share sheet) as a file URL, either
/// inside the app's own `Documents/Inbox` or under a security scope. Each one is moved into
/// `Library/Caches/shared-inbox`, which the Files app never shows, so no Documents folder is
/// ever exposed. At most `maxFiles` are kept; the rest, and anything that is not a regular
/// file, count as dropped. JS hears a count and a state, never a URL or a name. The page's own
/// file input receives them through `WKUIDelegate.runOpenPanelWith`, public on iOS 18.4 and
/// later; below that `intake` refuses with `unsupported_os` and deletes the copies at once.
///
/// - Main thread in practice; file work is synchronous and bounded by the cap.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/ShareInbox
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/MachineViewPlugin (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// └── MachineViewCoreTests/ShareBatchTests (inferred)
/// <module-headers:end>
import Foundation

public enum ShareEvent: Equatable {
    /// `batch` names the held share: its private folder's random UUID, unrelated to the files.
    case files(count: Int, dropped: Int, batch: String)
    case refused(reason: String)

    public var jsObject: [String: Any] {
        switch self {
        case let .files(count, dropped, batch): return ["kind": "files", "count": count, "dropped": dropped, "batch": batch]
        case .refused(let reason): return ["kind": "refused", "reason": reason]
        }
    }

    /// Whether this is the event telling of the share `batch`.
    public func tells(_ batch: String) -> Bool {
        if case let .files(_, _, own) = self { return own == batch }
        return false
    }
}

/// What a compare-and-take or compare-and-discard of a named share found.
public enum ShareClaim: Equatable {
    case taken([URL])
    /// Another share is held now; it was left exactly as it was.
    case changed
    case none
}

/// The user-facing share commands (`open({shareBatch})`, `discardShare({batch})`): each acts only
/// on the share it names, in one step on the main thread, so a share that arrived after the press
/// is never taken or discarded in its place. The plugin maps a failure to its rejection code.
@MainActor
public enum ShareCommand {
    public enum Failure: String, Error { case invalidArguments = "invalid_arguments", shareChanged = "share_changed", noShare = "no_share" }

    /// A batch id as JS hands it back: a UUID, the only shape the inbox mints.
    nonisolated public static func valid(_ batch: String?) -> Bool { batch.map { $0.count == 36 && UUID(uuidString: $0) != nil } ?? false }

    public static func open(_ inbox: ShareInbox, batch: String) -> Result<[URL], Failure> {
        guard valid(batch) else { return .failure(.invalidArguments) }
        switch inbox.take(batch: batch) {
        case .taken(let files): return .success(files)
        case .changed: return .failure(.shareChanged)
        case .none: return .failure(.noShare)
        }
    }

    /// Discards `batch` and, with it, its event if that has not been told; another share and its event stay.
    public static func discard(_ inbox: ShareInbox, batch: String?, waiting: inout ShareEvent?) -> Failure? {
        guard let batch, valid(batch) else { return .invalidArguments }
        switch inbox.discard(batch: batch) {
        case .changed: return .shareChanged
        case .taken:
            if waiting?.tells(batch) == true { waiting = nil }
            return nil
        case .none: return nil
        }
    }
}

public final class ShareInbox {
    public static let maxFiles = 10
    private let dir: URL
    private let files: FileManager
    public private(set) var held: [URL] = []
    /// The held share's id: its batch folder's name, a random UUID. Nil when nothing is held.
    public private(set) var batch: String?

    /// The app's own `Documents/Inbox`, where iOS puts an "Open in" copy; nothing else is deleted as incoming.
    private let incomingRoot: URL

    public init(dir: URL, incomingRoot: URL, files: FileManager = .default) {
        (self.dir, self.incomingRoot, self.files) = (dir, incomingRoot, files)
    }

    /// The production inbox: private caches, excluded from backup by being caches.
    public static func appInbox() -> ShareInbox {
        let fm = FileManager.default
        let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let documents = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return ShareInbox(dir: caches.appendingPathComponent("shared-inbox", isDirectory: true),
                          incomingRoot: documents.appendingPathComponent("Inbox", isDirectory: true))
    }

    /// Takes the shared file URLs into a batch of their own; `supported` is whether this OS can
    /// hand files to the page. A batch still held (never given to a window) is replaced.
    public func intake(_ urls: [URL], supported: Bool) -> ShareEvent {
        discard()
        let incoming = urls.filter(\.isFileURL)
        guard !incoming.isEmpty else { return .refused(reason: "no_files") }
        guard supported else {
            incoming.forEach(removeIfInbox)
            return .refused(reason: "unsupported_os")
        }
        let id = UUID().uuidString
        let batch = dir.appendingPathComponent(id, isDirectory: true)
        var dropped = urls.count - incoming.count
        for (index, url) in incoming.enumerated() {
            guard held.count < Self.maxFiles, let copy = copyIn(url, into: batch, slot: index) else {
                dropped += 1
                removeIfInbox(url)
                continue
            }
            held.append(copy)
            removeIfInbox(url)
        }
        guard !held.isEmpty else { return .refused(reason: "no_files") }
        self.batch = id
        return .files(count: held.count, dropped: dropped, batch: id)
    }

    /// Hands the held files to a window, which owns them from now on: they stay on disk, so the
    /// page can still read them while it uploads, until that window calls `remove`.
    func take() -> [URL] {
        let out = held
        held = []
        batch = nil
        return out
    }

    /// `take`, only if `named` is still the held share; otherwise nothing changes.
    public func take(batch named: String) -> ShareClaim {
        guard let batch, !held.isEmpty else { return .none }
        return batch == named ? .taken(take()) : .changed
    }

    /// `discard`, only if `named` is still the held share; otherwise nothing changes.
    public func discard(batch named: String) -> ShareClaim {
        guard let batch, !held.isEmpty else { return .none }
        guard batch == named else { return .changed }
        discard()
        return .taken([])
    }

    public var count: Int { held.count }

    /// Forgets the held batch and deletes it; batches already given to a window are theirs.
    func discard() {
        remove(held)
        held = []
        batch = nil
    }

    /// Deletes the batches `owned` files came in, and only ones inside this inbox: a path from
    /// anywhere else, or the inbox itself, is never deleted.
    public func remove(_ owned: [URL]) {
        let root = dir.standardizedFileURL.path + "/"
        let batches = Set(owned.compactMap { url -> String? in
            let path = url.standardizedFileURL.path
            guard path.hasPrefix(root), let first = path.dropFirst(root.count).split(separator: "/").first,
                  UUID(uuidString: String(first)) != nil else { return nil }
            return root + first
        })
        for batch in batches { try? files.removeItem(atPath: batch) }
    }

    private func copyIn(_ url: URL, into batch: URL, slot: Int) -> URL? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { return nil }
        // One folder per file keeps the original name (the page uploads it under that name).
        let slotDir = batch.appendingPathComponent(String(slot), isDirectory: true)
        let target = slotDir.appendingPathComponent(url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent)
        do {
            try files.createDirectory(at: slotDir, withIntermediateDirectories: true)
            try files.copyItem(at: url, to: target)
            return target
        } catch {
            return nil
        }
    }

    /// iOS's own copy in `Documents/Inbox` is removed, so nothing lingers in Documents.
    /// Deletes iOS's own copy, and only that: a regular file (not a symlink) whose real location
    /// is inside the app's real `Documents/Inbox`. A path that merely contains "Documents/Inbox",
    /// or a link out of it, is someone else's file and stays.
    private func removeIfInbox(_ url: URL) {
        guard url.isFileURL,
              let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey]),
              values.isSymbolicLink != true, values.isRegularFile == true else { return }
        let root = incomingRoot.resolvingSymlinksInPath().standardizedFileURL.path + "/"
        let real = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard real.hasPrefix(root) else { return }
        try? files.removeItem(atPath: real)
    }
}
