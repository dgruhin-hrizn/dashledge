#!/usr/bin/swift
import AppKit
import Darwin
import Foundation

struct InstallError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

func run(_ command: String, _ arguments: [String]) throws {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: command)
    task.arguments = arguments
    try task.run()
    task.waitUntilExit()
    guard task.terminationStatus == 0 else {
        throw InstallError("\(command) exited with status \(task.terminationStatus).")
    }
}

func install(_ source: URL) throws {
    let files = FileManager.default
    let identifier = "dev.edgeworkbench.desktop"
    let directory = URL(fileURLWithPath: "/Applications", isDirectory: true)
    let target = directory.appendingPathComponent("Edge Workbench.app")
    let replacing = files.fileExists(atPath: target.path)
    if replacing {
        let isLink = try target.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink
        guard isLink == false, Bundle(url: target)?.bundleIdentifier == identifier else {
            throw InstallError("Another item already occupies \(target.path).")
        }
    }

    let staging = directory.appendingPathComponent(".edge-workbench-" + UUID().uuidString)
    try files.createDirectory(at: staging, withIntermediateDirectories: false,
                              attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(at: staging) }
    let staged = staging.appendingPathComponent(target.lastPathComponent)
    try run("/usr/bin/ditto", [source.path, staged.path])
    let signer = #"anchor apple generic and certificate leaf[subject.OU] = "K5K2SPTZVV" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"#
    for (path, id) in [(staged.path, identifier), (staged.appendingPathComponent("Contents/Resources/runtime/node").path, "node")] {
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", "=identifier \"\(id)\" and \(signer)", path])
    }

    // Command-line AppKit can keep reporting a running app after its process exits.
    func isRunning(_ app: NSRunningApplication) -> Bool {
        let pid = app.processIdentifier
        guard pid > 0, !app.isTerminated else { return false }
        return kill(pid, 0) == 0 || errno != ESRCH
    }

    // Quit every running copy, including the older one launched from dist.
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
    for app in running where isRunning(app) {
        guard app.terminate() || !isRunning(app) else { throw InstallError("Could not quit the running Edge Workbench.") }
    }
    let deadline = Date().addingTimeInterval(15)
    while running.contains(where: isRunning) {
        guard Date() < deadline else { throw InstallError("Timed out waiting for Edge Workbench to quit.") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }

    // An atomic exchange leaves the old bundle in staging until the new one opens.
    let flags = UInt32(replacing ? RENAME_SWAP : RENAME_EXCL)
    guard renamex_np(staged.path, target.path, flags) == 0 else {
        throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    do {
        try run("/usr/bin/open", ["-g", target.path])
    } catch {
        if replacing, renamex_np(staged.path, target.path, UInt32(RENAME_SWAP)) == 0 {
            try? run("/usr/bin/open", ["-g", target.path])
        }
        throw error
    }
    print("Installed and opened \(target.path)")
}

do {
    guard CommandLine.arguments.count == 2 else {
        throw InstallError("Usage: install-mac.swift <path-to-signed-app>")
    }
    try install(URL(fileURLWithPath: CommandLine.arguments[1]))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
