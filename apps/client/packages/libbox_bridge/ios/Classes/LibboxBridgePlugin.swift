import Flutter
import Foundation
import NetworkExtension
#if canImport(Libbox)
import Libbox
#endif

/// Host-side manager for the iOS Packet Tunnel Network Extension.
///
/// The extension is a separate signed target. The generated Libbox framework is
/// linked by Xcode after `tool/build-libbox.sh` has produced it.
public final class LibboxBridgePlugin: NSObject, FlutterPlugin {
    private static let channelName = "strict_proxy/libbox"
    private var channel: FlutterMethodChannel?
    private var manager: NETunnelProviderManager?
    private var statusObserver: NSObjectProtocol?

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = LibboxBridgePlugin()
        let channel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
        instance.channel = channel
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    deinit {
        if let statusObserver {
            NotificationCenter.default.removeObserver(statusObserver)
        }
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "initialize":
            loadOrCreateManager { [weak self] error in
                if let error {
                    result(FlutterError(code: "vpn_initialize_failed", message: error.localizedDescription, details: nil))
                    return
                }
                if let connection = self?.manager?.connection {
                    self?.observeStatus(connection)
                }
                self?.emit("disconnected")
                result(nil)
            }
        case "isAvailable":
#if canImport(Libbox)
            result(true)
#else
            result(false)
#endif
        case "start":
            guard
                let arguments = call.arguments as? [String: Any],
                let config = arguments["config"] as? String,
                !config.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else {
                result(FlutterError(code: "invalid_config", message: "A non-empty sing-box configuration is required", details: nil))
                return
            }
            start(config: config, result: result)
        case "stop":
            manager?.connection.stopVPNTunnel()
            result(nil)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func loadOrCreateManager(completion: @escaping (Error?) -> Void) {
        NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, error in
            if let error {
                completion(error)
                return
            }
            if let manager = managers?.first {
                self?.manager = manager
                completion(nil)
                return
            }

            let manager = NETunnelProviderManager()
            manager.localizedDescription = "StrictProxy"
            let configuration = NETunnelProviderProtocol()
            configuration.providerBundleIdentifier = self?.extensionBundleIdentifier ?? "com.strictproxy.client.PacketTunnel"
            configuration.serverAddress = "StrictProxy"
            manager.protocolConfiguration = configuration
            manager.isEnabled = true
            manager.saveToPreferences { error in
                self?.manager = manager
                completion(error)
            }
        }
    }

    private func start(config: String, result: @escaping FlutterResult) {
        loadOrCreateManager { [weak self] error in
            if let error {
                result(FlutterError(code: "vpn_profile_failed", message: error.localizedDescription, details: nil))
                return
            }
            guard
                let self,
                let manager = self.manager,
                let tunnel = manager.protocolConfiguration as? NETunnelProviderProtocol
            else {
                result(FlutterError(code: "vpn_profile_missing", message: "Network Extension profile unavailable", details: nil))
                return
            }

            self.observeStatus(manager.connection)
            self.emit("connecting")
            tunnel.providerConfiguration = ["configContent": config]
            manager.protocolConfiguration = tunnel
            manager.isEnabled = true
            manager.saveToPreferences { saveError in
                if let saveError {
                    result(FlutterError(code: "vpn_profile_save_failed", message: saveError.localizedDescription, details: nil))
                    return
                }
                do {
                    try manager.connection.startVPNTunnel(options: ["configContent": config as NSString])
                    result(nil)
                } catch {
                    let message = error.localizedDescription
                    self.emit("error", message: message)
                    result(FlutterError(code: "vpn_start_failed", message: message, details: nil))
                }
            }
        }
    }

    private func observeStatus(_ connection: NEVPNConnection) {
        if let statusObserver {
            NotificationCenter.default.removeObserver(statusObserver)
        }
        statusObserver = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange,
            object: connection,
            queue: .main,
        ) { [weak self, weak connection] _ in
            guard let self, let connection else { return }
            switch connection.status {
            case .connecting, .reasserting:
                self.emit("connecting")
            case .connected:
                self.emit("connected")
            case .disconnecting:
                self.emit("disconnecting")
            case .disconnected, .invalid:
                self.emit("disconnected")
            @unknown default:
                self.emit("error", message: "Unknown Network Extension state")
            }
        }
    }

    private var extensionBundleIdentifier: String? {
        Bundle.main.object(forInfoDictionaryKey: "StrictProxyPacketTunnelBundleIdentifier") as? String
    }

    private func emit(_ state: String, message: String? = nil) {
        DispatchQueue.main.async { [weak self] in
            if let message {
                self?.channel?.invokeMethod("state", arguments: ["state": state, "message": message])
            } else {
                self?.channel?.invokeMethod("state", arguments: state)
            }
        }
    }
}
