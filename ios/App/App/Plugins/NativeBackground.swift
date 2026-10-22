import Foundation
import Capacitor

/// Tracks work through actual completion, including non-interruptible filesystem calls.
final class NativeWork {
    static let shared = NativeWork()
    private let lock = NSLock()
    private var standby = UserDefaults.standard.bool(forKey: "ott-background-standby")
    private var pending: [UUID: Ticket] = [:]
    private var stops: [UUID: (@escaping () -> Void) -> Void] = [:]
    private var draining: Set<UUID> = []
    var isStandby: Bool { lock.lock(); defer { lock.unlock() }; return standby }
    var snapshot: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["standby": standby, "pending": pending.count + draining.count,
                "quiescent": standby && pending.isEmpty && draining.isEmpty]
    }
    final class Ticket {
        fileprivate let id = UUID()
        fileprivate var cancelled = false
        fileprivate var finished = false
        fileprivate var cancel: (() -> Void)?
        func check() throws {
            let owner = NativeWork.shared
            owner.lock.lock(); defer { owner.lock.unlock() }
            if cancelled || finished { throw URLError(.cancelled) }
        }
        func commit<T>(_ action: () throws -> T) throws -> T {
            let owner = NativeWork.shared
            owner.lock.lock(); defer { owner.lock.unlock() }
            if cancelled || finished { throw URLError(.cancelled) }
            return try action()
        }
        func cancelWith(_ action: @escaping () -> Void) {
            let owner = NativeWork.shared
            owner.lock.lock()
            let now = cancelled && !finished
            if !finished && !cancelled { cancel = action }
            owner.lock.unlock()
            if now { action() }
        }
        func cancelWork() {
            let owner = NativeWork.shared
            owner.lock.lock()
            let action = !cancelled && !finished ? cancel : nil
            cancelled = true
            cancel = nil
            owner.lock.unlock()
            action?()
        }
        func finish() {
            let owner = NativeWork.shared
            owner.lock.lock(); defer { owner.lock.unlock() }
            finished = true; cancel = nil; owner.pending[id] = nil
        }
    }
    func begin() -> Ticket? {
        lock.lock(); defer { lock.unlock() }
        guard !standby else { return nil }
        let ticket = Ticket(); pending[ticket.id] = ticket
        return ticket
    }
    @discardableResult func onStandby(_ action: @escaping () -> Void) -> () -> Void {
        onStandbyAsync { done in action(); done() }
    }
    // Called under lock so no observer can see zero before async cleanup is queued.
    private func cleanup(_ action: @escaping (@escaping () -> Void) -> Void) -> () -> Void {
        let id = UUID()
        draining.insert(id)
        return { action {
            self.lock.lock(); self.draining.remove(id); self.lock.unlock()
        } }
    }
    @discardableResult func onStandbyAsync(_ action: @escaping (@escaping () -> Void) -> Void) -> () -> Void {
        let id = UUID()
        lock.lock(); stops[id] = action; let now = standby ? cleanup(action) : nil; lock.unlock()
        now?()
        return { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.stops[id] = nil; self.lock.unlock()
        }
    }
    func setStandby(_ value: Bool) {
        lock.lock()
        guard standby != value else { lock.unlock(); return }
        standby = value
        var actions: [() -> Void] = []
        if value {
            for ticket in pending.values where !ticket.cancelled && !ticket.finished {
                ticket.cancelled = true
                if let cancel = ticket.cancel { actions.append(cancel) }
                ticket.cancel = nil
            }
            actions += stops.values.map { cleanup($0) }
        }
        lock.unlock()
        actions.forEach { $0() }
    }
}

@objc(NativeBackground)
public class NativeBackground: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBackgroundPlugin"
    public let jsName = "NativeBackground"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setStandby", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]
    @objc func setStandby(_ call: CAPPluginCall) {
        guard let value = call.getBool("standby") else { call.reject("standby must be a boolean"); return }
        UserDefaults.standard.set(value, forKey: "ott-background-standby")
        NativeWork.shared.setStandby(value)
        call.resolve(NativeWork.shared.snapshot)
    }
    @objc func status(_ call: CAPPluginCall) { call.resolve(NativeWork.shared.snapshot) }
}
