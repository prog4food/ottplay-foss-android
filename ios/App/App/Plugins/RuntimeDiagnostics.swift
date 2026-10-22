import Capacitor
import Darwin
import Foundation
import UIKit

/// On-demand host-process observations, excluding WebKit's separate renderer processes.
@objc(RuntimeDiagnostics)
public class RuntimeDiagnostics: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RuntimeDiagnosticsPlugin"
    public let jsName = "RuntimeDiagnostics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
    ]
    private let startedAt = ProcessInfo.processInfo.systemUptime

    static func version(_ value: String?) -> Any {
        guard let value,
              let match = value.range(of: "^[A-Za-z0-9_.+-]{1,64}$", options: .regularExpression),
              match == value.startIndex..<value.endIndex else { return NSNull() }
        return value
    }

    static func number(_ metrics: inout [String: Any], _ key: String, _ value: Double) {
        if value.isFinite && value >= 0 && value <= 9007199254740991 {
            metrics[key] = value
        }
    }

    @objc func snapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("Runtime diagnostics owner was destroyed", "unavailable")
                return
            }
            let process = ProcessInfo.processInfo
            var metrics: [String: Any] = [:]
            // Only an interval within this producer is exported (privacy reason 35F9.1).
            // Raw system uptime requires a separately submitted visible bug report on iOS.
            Self.number(&metrics, "uptimeMs", (process.systemUptime - self.startedAt) * 1000)
            Self.number(&metrics, "systemTotalBytes", Double(process.physicalMemory))
            Self.number(&metrics, "logicalProcessors", Double(process.activeProcessorCount))
            Self.number(&metrics, "thermalState", Double(process.thermalState.rawValue))
            metrics["lowPower"] = process.isLowPowerModeEnabled
            if let scene = self.bridge?.viewController?.viewIfLoaded?.window?.windowScene {
                metrics["foreground"] = scene.activationState == .foregroundActive
            }

            var memory = task_vm_info_data_t()
            var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
            let result = withUnsafeMutablePointer(to: &memory) { pointer in
                pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
                }
            }
            if result == KERN_SUCCESS {
                Self.number(&metrics, "residentBytes", Double(memory.resident_size))
                Self.number(&metrics, "footprintBytes", Double(memory.phys_footprint))
            }
            let os = process.operatingSystemVersion
            call.resolve([
                "version": 1,
                "platform": "ios",
                "appVersion": Self.version(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String),
                "osVersion": Self.version("\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"),
                // WebKit has no supported independent package-version API on iOS.
                "webviewVersion": NSNull(),
                "metrics": metrics,
            ])
        }
    }
}
