import Capacitor
import Foundation
import Network

// Byte-based parser: TCP fragments need not align with headers, UTF-8, or JSON.
struct QueueHTTPRequest {
    let method: String
    let target: String
    let body: Data
    enum ParseResult { case incomplete, rejected(Int), request(QueueHTTPRequest) }
    static func parse(_ bytes: Data, token: String) -> ParseResult {
        guard bytes.count <= 73728 else { return .rejected(413) }
        guard let separator = bytes.range(of: Data("\r\n\r\n".utf8)) else {
            return bytes.count > 8192 ? .rejected(431) : .incomplete
        }
        guard separator.upperBound <= 8192,
              let header = String(data: bytes[..<separator.lowerBound], encoding: .ascii) else { return .rejected(431) }
        let lines = header.components(separatedBy: "\r\n")
        let first = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[2] == "HTTP/1.1" || first[2] == "HTTP/1.0",
              (lines.first?.utf8.count ?? 0) <= 2048, lines.count <= 33 else { return .rejected(400) }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { return .rejected(400) }
            let key = line[..<colon].lowercased()
            guard headers[key] == nil else { return .rejected(400) }
            headers[key] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        let supplied = Array((headers["authorization"] ?? "").utf8)
        let expected = Array("Bearer \(token)".utf8)
        guard supplied.count == expected.count else { return .rejected(401) }
        var difference: UInt8 = 0
        for index in expected.indices { difference |= supplied[index] ^ expected[index] }
        guard difference == 0 else { return .rejected(401) }
        guard headers["transfer-encoding"] == nil else { return .rejected(400) }
        let rawLength = headers["content-length"] ?? "0"
        guard !rawLength.isEmpty, rawLength.allSatisfy({ $0.isASCII && $0.isNumber }),
              let length = Int(rawLength), length >= 0 else { return .rejected(400) }
        guard length <= 65536 else { return .rejected(413) }
        let end = separator.upperBound + length
        guard bytes.count >= end else { return .incomplete }
        return .request(QueueHTTPRequest(method: String(first[0]), target: String(first[1]), body: bytes[separator.upperBound..<end]))
    }
}

struct CommandEntry {
    let data: [String: Any]
    let timestamp: TimeInterval
    let bytes: Int
}

@objc(MobileCommandQueue)
public class MobileCommandQueue: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileCommandQueuePlugin"
    public let jsName = "MobileCommandQueue"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isRunning", returnType: CAPPluginReturnPromise),
    ]
    private let queue = DispatchQueue(label: "MobileCommandQueue.queue", qos: .background)
    private var listener: NWListener?
    private var isRunningFlag = true
    private var boundPort: UInt16 = 0
    private var token: String?
    private var pendingStart: CAPPluginCall?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private var deadlines: [ObjectIdentifier: DispatchWorkItem] = [:]
    private var deviceCommands: [String: [CommandEntry]] = [:]
    private var broadcastCommands: [CommandEntry] = []

    public override func load() { /* Internal queue only; no listening socket. */ }

    private func status() -> [String: Any] {
        ["running": isRunningFlag, "port": boundPort, "httpEnabled": boundPort != 0]
    }

    @objc func start(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { call.reject("Queue owner released"); return }
            guard call.getBool("httpEnabled") == true else {
                self.isRunningFlag = true
                call.resolve(self.status())
                return
            }
            let token = call.getString("token") ?? ""
            guard token.range(of: "^[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil else {
                call.reject("HTTP control requires a random token of 32-256 URL-safe characters"); return
            }
            if self.listener != nil {
                if self.token != token { call.reject("Stop HTTP control before changing its token") }
                else if self.pendingStart != nil { call.reject("HTTP control is starting") }
                else { call.resolve(self.status()) }
                return
            }
            let env = ProcessInfo.processInfo.environment["OTTPLAY_QUEUE_PORT"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var ports = Array(UInt16(18081)...UInt16(18090))
            if !env.isEmpty {
                guard let port = UInt16(env), port > 0 else { call.reject("Invalid command queue port"); return }
                ports = [port]
            }
            self.pendingStart = call
            self.token = token
            self.startListener(ports: ports)
        }
    }

    private func startListener(ports: [UInt16]) {
        guard let port = ports.first, let endpointPort = NWEndpoint.Port(rawValue: port) else {
            pendingStart?.reject("No loopback command queue port available")
            pendingStart = nil; token = nil; return
        }
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpointPort)
            let current = try NWListener(using: parameters)
            listener = current
            current.stateUpdateHandler = { [weak self, weak current] state in
                guard let self, let current, self.listener === current else { return }
                switch state {
                case .ready:
                    self.boundPort = port; self.isRunningFlag = true
                    self.pendingStart?.resolve(self.status()); self.pendingStart = nil
                case .failed:
                    current.cancel(); self.listener = nil; self.boundPort = 0
                    if self.pendingStart != nil { self.startListener(ports: Array(ports.dropFirst())) }
                    else { self.closeClients(); self.token = nil }
                default: break
                }
            }
            current.newConnectionHandler = { [weak self] connection in self?.accept(connection) ?? connection.cancel() }
            current.start(queue: queue)
        } catch { listener = nil; startListener(ports: Array(ports.dropFirst())) }
    }

    private func closeClients() {
        deadlines.values.forEach { $0.cancel() }; deadlines.removeAll()
        clients.values.forEach { $0.cancel() }; clients.removeAll()
    }
    private func close(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        deadlines.removeValue(forKey: id)?.cancel()
        clients.removeValue(forKey: id)
        connection.cancel()
    }
    @objc func stop(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { call.resolve(); return }
            self.listener?.cancel(); self.listener = nil
            self.closeClients()
            self.pendingStart?.reject("HTTP control stopped"); self.pendingStart = nil
            self.token = nil; self.boundPort = 0; self.isRunningFlag = false
            self.deviceCommands.removeAll(); self.broadcastCommands.removeAll()
            call.resolve()
        }
    }
    @objc func isRunning(_ call: CAPPluginCall) {
        queue.async { [weak self] in call.resolve(self?.status() ?? ["running": false, "port": 0, "httpEnabled": false]) }
    }

    private func enqueue(_ raw: [String: Any], deviceId: String) -> Int? {
        guard deviceId.count <= 128, let bytes = try? JSONSerialization.data(withJSONObject: raw), bytes.count <= 65536 else { return nil }
        let timestamp = Date().timeIntervalSince1970
        for id in Array(deviceCommands.keys) {
            deviceCommands[id] = deviceCommands[id]?.filter { $0.timestamp > timestamp - 60 }
            if deviceCommands[id]?.isEmpty == true { deviceCommands.removeValue(forKey: id) }
        }
        broadcastCommands.removeAll { $0.timestamp <= timestamp - 60 }
        let storedBytes = broadcastCommands.reduce(0) { $0 + $1.bytes } + deviceCommands.values.reduce(0) { total, entries in
            total + entries.reduce(0) { $0 + $1.bytes }
        }
        guard storedBytes + bytes.count + 64 <= 1024 * 1024 else { return nil }
        var value = raw; value["ts"] = timestamp
        let entry = CommandEntry(data: value, timestamp: timestamp, bytes: bytes.count + 64)
        if deviceId.isEmpty {
            broadcastCommands.append(entry)
            if broadcastCommands.count > 100 { broadcastCommands.removeFirst(broadcastCommands.count - 50) }
            return broadcastCommands.count
        }
        guard deviceCommands[deviceId] != nil || deviceCommands.count < 128 else { return nil }
        var entries = deviceCommands[deviceId] ?? []
        entries.append(entry)
        if entries.count > 50 { entries.removeFirst(entries.count - 25) }
        deviceCommands[deviceId] = entries
        return entries.count
    }
    private func drain(_ deviceId: String) -> [[String: Any]] {
        let entries: [CommandEntry]
        if deviceId.isEmpty { entries = broadcastCommands; broadcastCommands.removeAll() }
        else { entries = deviceCommands.removeValue(forKey: deviceId) ?? [] }
        let cutoff = Date().timeIntervalSince1970 - 60
        return entries.filter { $0.timestamp > cutoff }.map { $0.data }
    }
    @objc func post(_ call: CAPPluginCall) {
        guard let data = call.getObject("data") else { call.reject("No data provided"); return }
        let deviceId = call.getString("deviceId") ?? ""
        queue.async { [weak self] in
            guard let count = self?.enqueue(data, deviceId: deviceId) else { call.reject("Invalid or oversized command"); return }
            call.resolve(["queued": count])
        }
    }
    @objc func get(_ call: CAPPluginCall) {
        let deviceId = call.getString("deviceId") ?? ""
        guard deviceId.count <= 128 else { call.reject("Invalid device ID"); return }
        queue.async { [weak self] in call.resolve(["commands": self?.drain(deviceId) ?? []]) }
    }

    private func accept(_ connection: NWConnection) {
        guard clients.count < 8, let token else { connection.cancel(); return }
        let id = ObjectIdentifier(connection)
        clients[id] = connection
        let deadline = DispatchWorkItem { [weak self, weak connection] in
            if let connection { self?.close(connection) }
        }
        deadlines[id] = deadline
        queue.asyncAfter(deadline: .now() + 5, execute: deadline)
        connection.start(queue: queue)
        receive(connection, accumulated: Data(), token: token)
    }
    private func receive(_ connection: NWConnection, accumulated: Data, token: String) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            guard let self, self.clients[ObjectIdentifier(connection)] != nil else { connection.cancel(); return }
            guard error == nil, let data, !data.isEmpty else { self.close(connection); return }
            var bytes = accumulated; bytes.append(data)
            switch QueueHTTPRequest.parse(bytes, token: token) {
            case .incomplete:
                if complete { self.respond(connection, status: 400, body: ["error": "Incomplete request"]) }
                else { self.receive(connection, accumulated: bytes, token: token) }
            case .rejected(let status): self.respond(connection, status: status, body: ["error": "Request rejected"])
            case .request(let request): self.process(request, connection: connection)
            }
        }
    }
    private func process(_ request: QueueHTTPRequest, connection: NWConnection) {
        let path = request.target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        let query = request.target.split(separator: "?", maxSplits: 1).dropFirst().first.map(String.init) ?? ""
        let deviceId = query.split(separator: "&").first { $0.hasPrefix("device_id=") }
            .map { String($0.dropFirst(10)).replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? "" } ?? ""
        guard deviceId.count <= 128 else { respond(connection, status: 400, body: ["error": "Invalid device ID"]); return }
        if request.method == "GET", ["/api/webhook/health", "/webhook/health"].contains(path) {
            respond(connection, status: 200, body: ["status": "ok", "backend": "capacitor", "port": boundPort])
        } else if request.method == "GET", ["/api/webhook/commands", "/webhook/poll"].contains(path) {
            respond(connection, status: 200, body: drain(deviceId))
        } else if request.method == "POST", ["/api/webhook/commands", "/webhook/notify"].contains(path) {
            guard let raw = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let count = enqueue(raw, deviceId: deviceId) else { respond(connection, status: 400, body: ["error": "Invalid command"]); return }
            respond(connection, status: 200, body: ["queued": count, "status": "ok"])
        } else { respond(connection, status: 404, body: ["error": "Not found"]) }
    }
    private func respond(_ connection: NWConnection, status: Int, body: Any) {
        guard let json = try? JSONSerialization.data(withJSONObject: body) else { close(connection); return }
        var response = Data("HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: \(json.count)\r\n\r\n".utf8)
        response.append(json)
        connection.send(content: response, completion: .contentProcessed { [weak self] _ in self?.close(connection) })
    }
    deinit { listener?.cancel(); deadlines.values.forEach { $0.cancel() }; clients.values.forEach { $0.cancel() } }
}
