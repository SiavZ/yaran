/// Diagnostics: the sanitized local ring log the user can preview and share (iOS).
///
/// Entries live in memory and are mirrored to `Caches/diag.log`, one line each
/// (`<epoch ms>\t<level>\t<message>` with newlines escaped). The log is capped at 1 MiB and 7
/// days; the oldest entries go first. Every message passes `Sanitizer` before it is kept, so
/// neither memory nor disk ever holds a token, cookie or query string.
///
/// - Nothing leaves the device except through the user's share sheet (the plugin's export).
/// - The clock and file location are injectable for tests.
///
/// <module-headers:begin>
/// Uses:
/// YaranCore/Diagnostics
/// └── YaranCore/Sanitizer (inferred)
/// External: Foundation
///
/// Used by:
/// YaranCore/Diagnostics
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── YaranCore/PluginArguments (inferred)
/// ├── YaranCoreTests/PluginArgumentsTests (inferred)
/// ├── YaranSecureStorePlugin/DiagnosticsPlugin (inferred)
/// └── YaranSecureStorePlugin/SecureStorePlugin (inferred)
/// <module-headers:end>

import Foundation

public enum DiagnosticsLevel: String, Sendable, CaseIterable {
    case info, warn, error
}

public final class Diagnostics: @unchecked Sendable {
    public static let maxBytes = 1_048_576
    public static let maxAgeMs: Int64 = 7 * 24 * 60 * 60 * 1000

    public static let shared = Diagnostics(
        fileURL: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("diag.log")
    )

    private struct Entry {
        var timeMs: Int64
        var line: String
    }

    public let fileURL: URL
    private let now: () -> Int64
    private let mutex = NSLock()
    private var entries: [Entry] = []
    private var bytes = 0

    public init(fileURL: URL, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.fileURL = fileURL
        self.now = now
        let text = (try? String(contentsOf: fileURL, encoding: .utf8)) ?? ""
        for line in text.split(separator: "\n") {
            guard let tab = line.firstIndex(of: "\t"), let time = Int64(line[..<tab]) else { continue }
            add(Entry(timeMs: time, line: String(line)))
        }
        if prune() { rewrite() }
    }

    /// Sanitizes and keeps one entry, dropping whatever falls outside the caps.
    public func append(level: DiagnosticsLevel, message: String) {
        mutex.lock(); defer { mutex.unlock() }
        let clean = Sanitizer.sanitize(message)
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\t", with: "\\t")
        let time = now()
        let entry = Entry(timeMs: time, line: "\(time)\t\(level.rawValue)\t\(clean)")
        add(entry)
        if prune() {
            rewrite()
        } else if let handle = try? FileHandle(forWritingTo: fileURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data((entry.line + "\n").utf8))
        } else {
            rewrite()
        }
    }

    /// The log as readable text (ISO-8601 time, level, message), oldest first.
    public func read() -> String {
        mutex.lock(); defer { mutex.unlock() }
        let formatter = ISO8601DateFormatter()
        return entries.map { entry in
            let parts = entry.line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
            let date = formatter.string(from: Date(timeIntervalSince1970: Double(entry.timeMs) / 1000))
            return ([date] + parts.dropFirst().map(String.init)).joined(separator: " ")
        }.joined(separator: "\n")
    }

    /// Empties memory and disk ("Erase everything").
    public func clear() {
        mutex.lock(); defer { mutex.unlock() }
        entries = []
        bytes = 0
        try? FileManager.default.removeItem(at: fileURL)
    }

    private func add(_ entry: Entry) {
        entries.append(entry)
        bytes += entry.line.utf8.count + 1
    }

    /// Drops entries older than 7 days or beyond 1 MiB; returns whether anything went.
    private func prune() -> Bool {
        let cutoff = now() - Self.maxAgeMs
        var dropped = 0
        var size = bytes
        while dropped < entries.count,
              entries[dropped].timeMs < cutoff || size > Self.maxBytes {
            size -= entries[dropped].line.utf8.count + 1
            dropped += 1
        }
        guard dropped > 0 else { return false }
        entries.removeFirst(dropped)
        bytes = size
        return true
    }

    private func rewrite() {
        let text = entries.map { $0.line + "\n" }.joined()
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(text.utf8).write(to: fileURL, options: .atomic)
    }
}
