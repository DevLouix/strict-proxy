import Foundation
import Network
import NetworkExtension

#if canImport(Libbox)
import Libbox

/// Minimal production packet-tunnel host for the generated sing-box Libbox
/// framework. The framework is generated from the pinned upstream source by
/// `tool/build-libbox.sh` and must be linked to this extension target.
final class PacketTunnelProvider: NEPacketTunnelProvider, LibboxPlatformInterfaceProtocol, LibboxCommandServerHandlerProtocol {
    private var commandServer: LibboxCommandServer?
    private var networkSettings: NEPacketTunnelNetworkSettings?
    private let platform = StrictProxyPlatform()

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        guard let config = options?["configContent"] as? String, !config.isEmpty else {
            completionHandler(Self.error("Missing configContent"))
            return
        }

        do {
            let setup = LibboxSetupOptions()
            let container = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!
            setup.basePath = container.path
            setup.workingPath = container.appendingPathComponent("StrictProxy/Working", isDirectory: true).path
            setup.tempPath = container.appendingPathComponent("StrictProxy/Temp", isDirectory: true).path
            setup.logMaxLines = 300
            setup.appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"
            setup.appMarketingVersion = setup.appVersion
            setup.oomKillerEnabled = true

            var setupError: NSError?
            LibboxSetup(setup, &setupError)
            if let setupError { throw setupError }

            platform.tunnel = self
            var commandError: NSError?
            commandServer = LibboxNewCommandServer(platform, self, &commandError)
            if let commandError { throw commandError }
            try commandServer?.start()
            try commandServer?.startOrReloadService(config, options: LibboxOverrideOptions())
            completionHandler(nil)
        } catch {
            commandServer?.close()
            commandServer = nil
            completionHandler(error)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        try? commandServer?.closeService()
        commandServer?.close()
        commandServer = nil
        networkSettings = nil
        completionHandler()
    }

    // MARK: LibboxCommandServerHandlerProtocol

    func serviceStop() throws {
        try commandServer?.closeService()
    }

    func serviceReload() throws {
        // The Flutter host sends a fresh configuration by restarting the
        // provider. Libbox's command server still requires this callback.
    }

    func getSystemProxyStatus() throws -> LibboxSystemProxyStatus {
        let status = LibboxSystemProxyStatus()
        status.available = false
        status.enabled = false
        return status
    }

    func setSystemProxyEnabled(_ isEnabled: Bool) throws {}

    private static func error(_ message: String) -> NSError {
        NSError(domain: "StrictProxyPacketTunnel", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private final class StrictProxyPlatform: NSObject, LibboxPlatformInterfaceProtocol {
    weak var tunnel: NEPacketTunnelProvider?
    private var networkMonitor: NWPathMonitor?

    func openTun(_ options: LibboxTunOptionsProtocol?, ret0_: UnsafeMutablePointer<Int32>?) throws {
        guard let options, let ret0_, let tunnel else { throw error("Invalid TUN options") }
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")
        settings.mtu = NSNumber(value: options.getMTU())

        let dnsIterator = try options.getDNSServerAddress()
        var dnsServers: [String] = []
        while dnsIterator.hasNext() { dnsServers.append(dnsIterator.next()) }
        if !dnsServers.isEmpty { settings.dnsSettings = NEDNSSettings(servers: dnsServers) }

        var v4Addresses: [String] = []
        var v4Masks: [String] = []
        let v4Iterator = options.getInet4Address()!
        while v4Iterator.hasNext() {
            let prefix = v4Iterator.next()!
            v4Addresses.append(prefix.address())
            v4Masks.append(prefix.mask())
        }
        if !v4Addresses.isEmpty {
            let v4 = NEIPv4Settings(addresses: v4Addresses, subnetMasks: v4Masks)
            let routes = options.getInet4RouteAddress()!
            var included: [NEIPv4Route] = []
            while routes.hasNext() {
                let prefix = routes.next()!
                included.append(NEIPv4Route(destinationAddress: prefix.address(), subnetMask: prefix.mask()))
            }
            if included.isEmpty { included = [NEIPv4Route.default()] }
            v4.includedRoutes = included
            settings.ipv4Settings = v4
        }

        var v6Addresses: [String] = []
        var v6Lengths: [NSNumber] = []
        let v6Iterator = options.getInet6Address()!
        while v6Iterator.hasNext() {
            let prefix = v6Iterator.next()!
            v6Addresses.append(prefix.address())
            v6Lengths.append(NSNumber(value: prefix.prefix()))
        }
        if !v6Addresses.isEmpty {
            let v6 = NEIPv6Settings(addresses: v6Addresses, networkPrefixLengths: v6Lengths)
            let routes = options.getInet6RouteAddress()!
            var included: [NEIPv6Route] = []
            while routes.hasNext() {
                let prefix = routes.next()!
                included.append(NEIPv6Route(destinationAddress: prefix.address(), networkPrefixLength: NSNumber(value: prefix.prefix())))
            }
            if included.isEmpty { included = [NEIPv6Route.default()] }
            v6.includedRoutes = included
            settings.ipv6Settings = v6
        }

        networkSettings = settings
        try awaitSetTunnelSettings(tunnel, settings)
        guard let fd = tunnel.packetFlow.value(forKeyPath: "socket.fileDescriptor") as? Int32 else {
            throw error("Network Extension did not expose a TUN file descriptor")
        }
        ret0_.pointee = fd
    }

    private func awaitSetTunnelSettings(_ tunnel: NEPacketTunnelProvider, _ settings: NEPacketTunnelNetworkSettings) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var settingError: Error?
        tunnel.setTunnelNetworkSettings(settings) { error in
            settingError = error
            semaphore.signal()
        }
        semaphore.wait()
        if let settingError { throw settingError }
    }

    func usePlatformAutoDetectControl() -> Bool { false }
    func autoDetectControl(_ fd: Int32) throws {}
    func useProcFS() -> Bool { false }

    func findConnectionOwner(_ ipProtocol: Int32, sourceAddress: String?, sourcePort: Int32, destinationAddress: String?, destinationPort: Int32) throws -> LibboxConnectionOwner {
        throw error("Connection owner lookup is unavailable in a packet tunnel")
    }

    func writeLog(_ message: String?) {
        guard let message else { return }
        NSLog("StrictProxy libbox: %@", message)
    }

    func startDefaultInterfaceMonitor(_ listener: LibboxInterfaceUpdateListenerProtocol?) throws {
        guard let listener else { return }
        let monitor = NWPathMonitor()
        networkMonitor = monitor
        monitor.pathUpdateHandler = { path in
            let iface = path.availableInterfaces.first
            listener.updateDefaultInterface(iface?.name ?? "", interfaceIndex: Int32(iface?.index ?? -1), isExpensive: path.isExpensive, isConstrained: path.isConstrained)
        }
        monitor.start(queue: DispatchQueue.global(qos: .utility))
    }

    func closeDefaultInterfaceMonitor(_ listener: LibboxInterfaceUpdateListenerProtocol?) throws {
        networkMonitor?.cancel()
        networkMonitor = nil
    }

    func getInterfaces() throws -> LibboxNetworkInterfaceIteratorProtocol {
        return NetworkInterfaceIterator(items: [])
    }

    func underNetworkExtension() -> Bool { true }
    func includeAllNetworks() -> Bool { false }
    func readWIFIState() -> LibboxWIFIState? { nil }
    func systemCertificates() -> LibboxStringIteratorProtocol? { nil }
    func clearDNSCache() {}
    func send(_ notification: LibboxNotification?) throws {}

    func localDNSTransport() -> LibboxLocalDNSTransportProtocol? { nil }
    func packageNameByUid(_ uid: Int32) throws -> String { throw error("Package lookup unavailable") }
    func uidByPackageName(_ packageName: String?) throws -> Int32 { throw error("UID lookup unavailable") }
    func lookupUser(_ username: String?) throws -> LibboxPlatformUser { throw error("User lookup unavailable") }
    func usePlatformShell() -> Bool { false }
    func checkPlatformShell() throws { throw error("Shell unavailable") }
    func openShellSession(_ user: LibboxPlatformUser?, command: String?, environ: LibboxStringIteratorProtocol?, term: String?, rows: Int32, cols: Int32) throws -> any LibboxShellSessionProtocol { throw error("Shell unavailable") }
    func readSystemSSHHostKey(_ error: NSErrorPointer) -> String { "" }
    func lookupSFTPServer(_ error: NSErrorPointer) -> String { "" }
    func tailscaleHostname() -> String { "StrictProxy" }
    func usePlatformBridge() -> Bool { false }
    func registerMyInterface(_ name: String?) {}
    func startNeighborMonitor(_ listener: LibboxNeighborUpdateListenerProtocol?) throws {}
    func closeNeighborMonitor(_ listener: LibboxNeighborUpdateListenerProtocol?) throws {}
    func connectSSHAgent(_ ret0_: UnsafeMutablePointer<Int32>?) throws { throw error("SSH agent unavailable") }

    private func error(_ message: String) -> NSError {
        NSError(domain: "StrictProxyPlatform", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

private final class NetworkInterfaceIterator: NSObject, LibboxNetworkInterfaceIteratorProtocol {
    private var items: [LibboxNetworkInterface]
    private var index = 0
    init(items: [LibboxNetworkInterface]) { self.items = items }
    func hasNext() -> Bool { index < items.count }
    func next() -> LibboxNetworkInterface? {
        guard hasNext() else { return nil }
        defer { index += 1 }
        return items[index]
    }
}
#else

/// The extension target must link the generated Libbox.xcframework.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        completionHandler(NSError(domain: "StrictProxyPacketTunnel", code: 3, userInfo: [NSLocalizedDescriptionKey: "Libbox.xcframework is missing"]))
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
#endif
