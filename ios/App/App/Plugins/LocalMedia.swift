import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// New selections retain document bookmarks, not media copies. Legacy imports stay readable.
/// Security-scoped access remains active while WebKit can request the playback URL.
@objc(LocalMedia)
public class LocalMedia: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "LocalMediaPlugin"
    public let jsName = "LocalMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeSource", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAccess", returnType: CAPPluginReturnPromise),
    ]
    private let listLock = NSLock()
    private var listWork: [String: NativeWork.Ticket] = [:]
    private var currentWork: NativeWork.Ticket?
    private var removeStandbyObserver: (() -> Void)?
    private func tracked(_ call: CAPPluginCall, requestId: String? = nil, _ action: @escaping () -> Void) {
        guard let ticket = NativeWork.shared.begin() else { call.reject("Player is in standby", "standby"); return }
        if let requestId {
            listLock.lock(); let previous = listWork.updateValue(ticket, forKey: requestId); listLock.unlock()
            previous?.cancelWork()
        }
        queue.async {
            self.currentWork = ticket
            defer {
                self.currentWork = nil
                if let requestId {
                    self.listLock.lock()
                    if self.listWork[requestId] === ticket { self.listWork[requestId] = nil }
                    self.listLock.unlock()
                }
                ticket.finish()
            }
            do { try ticket.check(); action() }
            catch { call.reject("Local media request cancelled") }
        }
    }
    private func checkWork() throws { try currentWork?.check() }
    private let queue = DispatchQueue(label: "ott.offline-media", qos: .userInitiated)
    private var pendingPicker: CAPPluginCall?
    private var pickingFolder = false
    private var replacingSource: String?
    // Access is balanced on disconnect/deinit, rather than before WebKit reads a URL.
    private var activeScopes: [String: URL] = [:]
    private struct LinkedItem: Codable {
        var id: String
        var name: String
        var path: String
        var mime: String
        var size: Int64
    }
    private struct Source: Codable {
        var id: String
        var name: String
        var kind: String
        var bookmark: Data
        var items: [LinkedItem]
        var excluded: [String]
    }
    deinit {
        removeStandbyObserver?()
        for url in activeScopes.values { url.stopAccessingSecurityScopedResource() }
    }
    private func sourceFile(_ id: String) throws -> URL {
        try directory().appendingPathComponent(id + ".source.json")
    }
    private func readMetadata(_ url: URL) throws -> Data? {
        try checkWork()
        let data = try? Data(contentsOf: url)
        // Keep the ticket through the synchronous read, then propagate
        // cancellation instead of treating it as a corrupt metadata file.
        try checkWork()
        return data
    }
    private func sources() throws -> [Source] {
        try checkWork()
        let root = try directory()
        let files = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        try checkWork()
        var result: [Source] = []
        for url in files {
            try checkWork()
            guard url.lastPathComponent.hasSuffix(".source.json"), regularPrivateFile(url, in: root),
                  let data = try readMetadata(url), data.count < 8 * 1024 * 1024,
                  let source = try? JSONDecoder().decode(Source.self, from: data),
                  UUID(uuidString: source.id) != nil else { continue }
            result.append(source)
        }
        try checkWork()
        return result.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
    private func save(_ source: Source) throws {
        let bytes = try JSONEncoder().encode(source)
        let file = try sourceFile(source.id)
        if let ticket = currentWork { try ticket.commit { try bytes.write(to: file, options: .atomic) } }
        else { try bytes.write(to: file, options: .atomic) }
    }
    private func release(_ id: String) {
        activeScopes.removeValue(forKey: id)?.stopAccessingSecurityScopedResource()
    }
    private func resolve(_ source: inout Source) throws -> URL {
        try checkWork()
        if let active = activeScopes[source.id] { return active }
        var stale = false
        let url = try URL(resolvingBookmarkData: source.bookmark, options: [.withoutUI],
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
        activeScopes[source.id] = url
        if stale {
            do {
                source.bookmark = try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)
                try save(source)
            } catch { release(source.id); throw error }
        }
        return url
    }
    private func mediaInfo(_ url: URL) -> (String, Int64)? {
        guard let type = UTType(filenameExtension: url.pathExtension.lowercased()),
              type.conforms(to: .movie) || type.conforms(to: .audio),
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize else { return nil }
        return (type.preferredMIMEType ?? "application/octet-stream", Int64(size))
    }
    private func child(_ path: String, root: URL) -> URL? {
        guard !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else { return nil }
        let url = path.isEmpty ? root : root.appendingPathComponent(path)
        let base = root.resolvingSymlinksInPath().standardizedFileURL.path
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard resolved == base || resolved.hasPrefix(base + "/") else { return nil }
        return url
    }
    private func refresh(_ source: inout Source, root: URL,
                         onItem: ((LinkedItem, URL) -> Void)? = nil,
                         onScan: (() -> Void)? = nil) throws {
        var indices: [String: Int] = [:]
        for (index, item) in source.items.enumerated() where indices[item.path] == nil { indices[item.path] = index }
        func append(_ path: String, _ url: URL) throws {
            try checkWork()
            guard !source.excluded.contains(path), let (mime, size) = mediaInfo(url) else { return }
            let item: LinkedItem
            if let index = indices[path] {
                source.items[index].name = String(url.lastPathComponent.prefix(256))
                source.items[index].mime = mime
                source.items[index].size = size
                item = source.items[index]
            } else {
                item = LinkedItem(id: UUID().uuidString.lowercased(), name: String(url.lastPathComponent.prefix(256)),
                                  path: path, mime: mime, size: size)
                indices[path] = source.items.count
                source.items.append(item)
            }
            onItem?(item, url)
        }
        if source.kind == "folder" {
            let rootValues = try root.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard rootValues.isDirectory == true, rootValues.isSymbolicLink != true else { throw CocoaError(.fileReadNoSuchFile) }
            guard let enumerator = FileManager.default.enumerator(at: root,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { throw CocoaError(.fileReadNoPermission) }
            var scanned = 0
            for case let url as URL in enumerator {
                try checkWork()
                scanned += 1
                onScan?()
                guard scanned <= 20_000 else { throw CocoaError(.fileReadTooLarge) }
                let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
                if values.isDirectory == true { continue }
                let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
                guard url.path.hasPrefix(prefix) else { continue }
                let relative = String(url.path.dropFirst(prefix.count))
                guard child(relative, root: root) != nil else { continue }
                try append(relative, url)
            }
        } else {
            guard mediaInfo(root) != nil else { throw CocoaError(.fileReadNoSuchFile) }
            onScan?()
            try append("", root)
        }
        // Keep absent records: the UI can explain a disconnected file instead of silently dropping it.
        try save(source)
    }

    private struct Entry: Codable {
        let id: String
        let name: String
        let filename: String
        let mime: String
    }
    private func directory() throws -> URL {
        var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                     appropriateFor: nil, create: true).appendingPathComponent("offline-media", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Video libraries can be large; they should not consume iCloud backups.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        return directory
    }
    private func regularPrivateFile(_ file: URL, in directory: URL) -> Bool {
        guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
              values.isRegularFile == true, values.isSymbolicLink != true else { return false }
        return file.resolvingSymlinksInPath().standardizedFileURL ==
            directory.resolvingSymlinksInPath().appendingPathComponent(file.lastPathComponent).standardizedFileURL
    }
    public override func load() {
        removeStandbyObserver = NativeWork.shared.onStandbyAsync { [weak self] done in
            guard let self else { done(); return }
            self.queue.async { [weak self] in
                defer { done() }
                guard let self else { return }
                for id in Array(self.activeScopes.keys) { self.release(id) }
            }
        }
        guard let ticket = NativeWork.shared.begin() else { return }
        queue.async {
            defer { ticket.finish() }
            guard (try? ticket.check()) != nil, let directory = try? self.directory(),
                  let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
            for file in files where file.pathExtension != "json" {
                guard (try? ticket.check()) != nil else { return }
                let id = file.deletingPathExtension().lastPathComponent
                if UUID(uuidString: id) != nil && !FileManager.default.fileExists(atPath: directory.appendingPathComponent(id + ".json").path) {
                    try? FileManager.default.removeItem(at: file)
                }
            }
        }
    }
    private func snapshot() throws -> [String: Any] {
        try checkWork()
        let directory = try directory()
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        try checkWork()
        var items: [[String: Any]] = []
        for metadata in files.filter({ $0.pathExtension == "json" }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            try checkWork()
            guard regularPrivateFile(metadata, in: directory),
                  let data = try readMetadata(metadata), let entry = try? JSONDecoder().decode(Entry.self, from: data),
                  UUID(uuidString: entry.id) != nil, !entry.filename.contains("/"),
                  entry.filename.hasPrefix(entry.id + ".") else { continue }
            let file = directory.appendingPathComponent(entry.filename)
            guard regularPrivateFile(file, in: directory),
                  let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
                  let size = attributes[.size] as? NSNumber,
                  let url = bridge?.portablePath(fromLocalURL: file) else { continue }
            items.append(["id": entry.id, "name": entry.name, "mime": entry.mime, "size": size.int64Value,
                          "url": url.absoluteString, "source": "imported", "sourceId": "", "available": true, "access": "granted"])
        }
        var sourceRows: [[String: Any]] = []
        for var source in try sources() {
            try checkWork()
            var root: URL?
            var granted = false
            do {
                let resolved = try resolve(&source)
                try refresh(&source, root: resolved)
                root = resolved
                granted = true
            } catch { release(source.id) }
            sourceRows.append(["id": source.id, "name": source.name, "kind": source.kind,
                               "available": granted, "access": granted ? "granted" : "required"])
            for item in source.items where !source.excluded.contains(item.path) {
                try checkWork()
                let url = root.flatMap { child(item.path, root: $0) }
                let exists = url.flatMap { mediaInfo($0) } != nil
                let portable = exists ? url.flatMap { bridge?.portablePath(fromLocalURL: $0) } : nil
                items.append(["id": item.id, "name": item.name, "mime": item.mime, "size": item.size,
                              "url": portable?.absoluteString ?? "", "source": "linked", "sourceId": source.id,
                              "directory": url?.deletingLastPathComponent().lastPathComponent ?? "",
                              "available": portable != nil, "access": granted ? "granted" : "required"])
            }
        }
        try checkWork()
        return ["available": true, "persistent": true, "storage": "device", "items": items, "sources": sourceRows,
                "directAccess": true, "folderAccess": true]
    }
    private func resolveSnapshot(_ call: CAPPluginCall) throws {
        let result = try snapshot()
        guard let ticket = currentWork else { throw URLError(.cancelled) }
        try ticket.commit { call.resolve(result) }
    }
    private func progressSnapshot(_ call: CAPPluginCall, requestId: String) throws {
        guard let ticket = currentWork else { throw URLError(.cancelled) }
        let directory = try directory()
        var saved = try sources()
        var items: [String: [String: Any]] = [:]
        var order: [String] = []
        var sourceRows: [[String: Any]] = saved.map { ["id": $0.id, "name": $0.name, "kind": $0.kind,
            "available": false, "access": "required"] }
        var scanned = 0
        let preferredId = call.getString("preferredId") ?? ""
        var preferredState = "pending"
        var lastPublish = Date.distantPast
        func catalog(_ scanning: Bool) -> [String: Any] {
            var result: [String: Any] = ["available": true, "persistent": true, "storage": "device",
                "directAccess": true, "folderAccess": true, "items": order.compactMap { items[$0] },
                "sources": sourceRows, "scanning": scanning, "scanned": scanned]
            if !scanning { result["total"] = scanned }
            if !preferredId.isEmpty { result["preferred"] = ["id": preferredId, "state": preferredState] }
            return result
        }
        func publish(_ force: Bool = false) throws {
            try checkWork()
            guard force || Date().timeIntervalSince(lastPublish) >= 0.25 else { return }
            lastPublish = Date()
            let value = catalog(true)
            try ticket.commit { self.notifyListeners("localMediaProgress", data: ["requestId": requestId, "catalog": value]) }
        }
        func append(_ row: [String: Any]) throws {
            guard let id = row["id"] as? String else { return }
            let first = !items.values.contains { $0["available"] as? Bool == true }
            if items[id] == nil { order.append(id) }
            items[id] = row
            if id == preferredId && row["available"] as? Bool == true { preferredState = "found" }
            try publish(first && row["available"] as? Bool == true)
        }
        func linked(_ item: LinkedItem, _ source: Source, _ url: URL?) -> [String: Any] {
            let portable = url.flatMap { mediaInfo($0) != nil ? bridge?.portablePath(fromLocalURL: $0) : nil }
            return ["id": item.id, "name": item.name, "mime": item.mime, "size": item.size,
                "url": portable?.absoluteString ?? "", "source": "linked", "sourceId": source.id,
                "directory": url?.deletingLastPathComponent().lastPathComponent ?? "", "available": portable != nil]
        }
        // Resolve only the saved item first. The rest of the directory is not
        // traversed until this result (including definitive absence) is published.
        if UUID(uuidString: preferredId) != nil {
            if let index = saved.firstIndex(where: { $0.items.contains { $0.id == preferredId } }),
               let item = saved[index].items.first(where: { $0.id == preferredId }) {
                do {
                    let root = try resolve(&saved[index])
                    sourceRows[index]["available"] = true; sourceRows[index]["access"] = "granted"
                    if let url = child(item.path, root: root) {
                        _ = try url.resourceValues(forKeys: [.isRegularFileKey])
                        try append(linked(item, saved[index], url))
                    }
                } catch {
                    let error = error as NSError
                    if error.domain == NSCocoaErrorDomain && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(error.code) {
                        preferredState = "missing"
                    }
                    try checkWork()
                }
            } else {
                let metadata = directory.appendingPathComponent(preferredId + ".json")
                if !FileManager.default.fileExists(atPath: metadata.path) { preferredState = "missing" }
                else if let data = try readMetadata(metadata), let entry = try? JSONDecoder().decode(Entry.self, from: data),
                        entry.id == preferredId, !entry.filename.contains("/"), entry.filename.hasPrefix(entry.id + ".") {
                    let file = directory.appendingPathComponent(entry.filename)
                    if !FileManager.default.fileExists(atPath: file.path) { preferredState = "missing" }
                    else if regularPrivateFile(file, in: directory), let info = mediaInfo(file), let url = bridge?.portablePath(fromLocalURL: file) {
                        try append(["id": entry.id, "name": entry.name, "mime": entry.mime, "size": info.1,
                            "url": url.absoluteString, "source": "imported", "sourceId": entry.id, "available": true])
                    }
                }
            }
        }
        try publish(true)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        for metadata in files where metadata.pathExtension == "json" && !metadata.lastPathComponent.hasSuffix(".source.json") {
            try checkWork()
            scanned += 1
            guard regularPrivateFile(metadata, in: directory), let data = try readMetadata(metadata),
                  let entry = try? JSONDecoder().decode(Entry.self, from: data), UUID(uuidString: entry.id) != nil,
                  !entry.filename.contains("/"), entry.filename.hasPrefix(entry.id + ".") else { continue }
            let file = directory.appendingPathComponent(entry.filename)
            if regularPrivateFile(file, in: directory), let info = mediaInfo(file), let url = bridge?.portablePath(fromLocalURL: file) {
                try append(["id": entry.id, "name": entry.name, "mime": entry.mime, "size": info.1,
                    "url": url.absoluteString, "source": "imported", "sourceId": entry.id, "available": true])
            }
            try publish()
        }
        for index in saved.indices {
            try checkWork()
            var source = saved[index]
            do {
                let root = try resolve(&source)
                sourceRows[index] = ["id": source.id, "name": source.name, "kind": source.kind, "available": true, "access": "granted"]
                let identity = source
                try refresh(&source, root: root, onItem: { item, url in
                    // The work ticket also owns progress delivery. A cancelled
                    // source never publishes a late snapshot into the new list.
                    try? append(linked(item, identity, url))
                }, onScan: { scanned += 1; try? publish() })
                for item in source.items where items[item.id] == nil && !source.excluded.contains(item.path) {
                    try append(linked(item, source, child(item.path, root: root)))
                }
            } catch {
                try checkWork()
                sourceRows[index] = ["id": source.id, "name": source.name, "kind": source.kind, "available": false, "access": "required"]
            }
        }
        try ticket.commit { call.resolve(catalog(false)) }
    }
    @objc func cancelList(_ call: CAPPluginCall) {
        listLock.lock(); let ticket = listWork[call.getString("requestId") ?? ""]; listLock.unlock()
        ticket?.cancelWork()
        call.resolve()
    }
    @objc func list(_ call: CAPPluginCall) {
        tracked(call, requestId: call.getString("requestId")) { [weak self] in
            guard let self else { call.reject("Local media unavailable"); return }
            do {
                if let requestId = call.getString("requestId"), !requestId.isEmpty { try self.progressSnapshot(call, requestId: requestId) }
                else { try self.resolveSnapshot(call) }
            } catch { call.reject("Local media unavailable") }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil else { call.reject("Invalid local media ID"); return }
        tracked(call) { [weak self] in
            guard let self else { call.reject("Local media unavailable"); return }
            do {
                for var source in try self.sources() {
                    if let item = source.items.first(where: { $0.id == id }) {
                        source.excluded.append(item.path)
                        source.items.removeAll { $0.id == id }
                        try self.save(source)
                        try self.resolveSnapshot(call)
                        return
                    }
                }
                let directory = try self.directory()
                let metadata = directory.appendingPathComponent(id + ".json")
                if FileManager.default.fileExists(atPath: metadata.path) {
                    let entry = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: metadata))
                    guard entry.filename.hasPrefix(id + "."), !entry.filename.contains("/") else {
                        call.reject("Invalid local media record"); return
                    }
                    try FileManager.default.removeItem(at: directory.appendingPathComponent(entry.filename))
                    try FileManager.default.removeItem(at: metadata)
                }
                try self.resolveSnapshot(call)
            } catch { call.reject("Unable to delete local media") }
        }
    }
    @objc func importFiles(_ call: CAPPluginCall) { presentPicker(call, folder: false) }
    @objc func importFolder(_ call: CAPPluginCall) { presentPicker(call, folder: true) }
    @objc func requestAccess(_ call: CAPPluginCall) {
        let id = call.getString("id")
        if let id, UUID(uuidString: id) == nil { call.reject("Unknown local media source"); return }
        tracked(call) {
            do {
                let saved = try self.sources()
                var target = id.flatMap { requested in saved.first { $0.id == requested } }
                if id == nil {
                    target = saved.first { savedSource in
                        var source = savedSource
                        do {
                            let root = try self.resolve(&source)
                            try self.refresh(&source, root: root)
                            return false
                        } catch { self.release(source.id); return true }
                    }
                }
                guard let source = target else {
                    if id != nil { call.reject("Unknown local media source") }
                    else { try self.resolveSnapshot(call) }
                    return
                }
                self.presentPicker(call, folder: source.kind == "folder", replacing: source.id)
            } catch { call.reject("Local media sources unavailable") }
        }
    }
    @objc func removeSource(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil else { call.reject("Invalid source ID"); return }
        tracked(call) {
            do {
                self.release(id)
                let file = try self.sourceFile(id)
                if FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
                try self.resolveSnapshot(call)
            } catch { call.reject("Unable to disconnect local media source") }
        }
    }
    private func presentPicker(_ call: CAPPluginCall, folder: Bool, replacing: String? = nil) {
        DispatchQueue.main.async {
            guard !NativeWork.shared.isStandby else { call.reject("Player is in standby", "standby"); return }
            guard self.pendingPicker == nil else { call.reject("A media picker is already open"); return }
            guard let presenter = self.bridge?.viewController else { call.reject("Media picker unavailable"); return }
            self.pendingPicker = call
            self.pickingFolder = folder
            self.replacingSource = replacing
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: folder ? [.folder] : [.movie, .audio], asCopy: false)
            picker.allowsMultipleSelection = !folder && replacing == nil
            picker.delegate = self
            presenter.present(picker, animated: true)
        }
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingPicker else { return }
        pendingPicker = nil
        replacingSource = nil
        list(call)
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPicker else { return }
        pendingPicker = nil
        let folder = pickingFolder
        let replacing = replacingSource
        replacingSource = nil
        guard urls.count <= 128 else { call.reject("Select at most 128 files at once"); return }
        tracked(call) {
            var created: [String] = []
            do {
                for url in urls {
                    try self.checkWork()
                    guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
                    defer { url.stopAccessingSecurityScopedResource() }
                    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard values.isSymbolicLink != true,
                          folder ? values.isDirectory == true : self.mediaInfo(url) != nil else {
                        throw CocoaError(.fileReadUnsupportedScheme)
                    }
                    var source = Source(id: replacing ?? UUID().uuidString.lowercased(), name: String(url.lastPathComponent.prefix(256)),
                                        kind: folder ? "folder" : "file",
                                        bookmark: try url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil),
                                        items: [], excluded: [])
                    if let replacing, let old = try self.sources().first(where: { $0.id == replacing }) {
                        source.items = old.items
                        source.excluded = old.excluded
                    }
                    try self.refresh(&source, root: url)
                    self.release(source.id)
                    if replacing == nil { created.append(source.id) }
                }
                try self.resolveSnapshot(call)
            } catch {
                for id in created {
                    self.release(id)
                    if let file = try? self.sourceFile(id) { try? FileManager.default.removeItem(at: file) }
                }
                call.reject("Unable to link media; select accessible local files or a folder")
            }
        }
    }
}
