#!/usr/bin/swift
import AppKit
import Darwin
import Foundation
import CryptoKit

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

func install(_ source: URL, updateVersion: String? = nil) throws {
    let files = FileManager.default
    let identifier = "dev.edgeworkbench.desktop"
    let directory = URL(fileURLWithPath: "/Applications", isDirectory: true)
    let target = directory.appendingPathComponent("Dashledge.app")
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

    if let version = updateVersion {
        guard Bundle(url: staged)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version else {
            throw InstallError("Downloaded app version does not match the release.")
        }
        try run("/usr/sbin/spctl", ["--assess", "--type", "execute", staged.path])
        if let installed = Bundle(url: target)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
           installed.compare(version, options: .numeric) != .orderedAscending {
            throw InstallError("Dashledge \(installed) is already installed.")
        }
    }

    let cardPath = "Contents/Resources/rundmd-default.imgc"
    let oldCard = target.appendingPathComponent(cardPath)
    if files.fileExists(atPath: oldCard.path) && !files.fileExists(atPath: staged.appendingPathComponent(cardPath).path) {
        let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent(identifier, isDirectory: true)
        let saved = support.appendingPathComponent("rundmd-default.imgc")
        if !files.fileExists(atPath: saved.path) && !files.fileExists(atPath: support.appendingPathComponent("rundmd.img").path) {
            try files.createDirectory(at: support, withIntermediateDirectories: true)
            try Data(contentsOf: oldCard, options: .mappedIfSafe).write(to: saved, options: .atomic)
        }
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
        guard app.terminate() || !isRunning(app) else { throw InstallError("Could not quit the running Dashledge.") }
    }
    let deadline = Date().addingTimeInterval(15)
    while running.contains(where: isRunning) {
        guard Date() < deadline else { throw InstallError("Timed out waiting for Dashledge to quit.") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }

    // An atomic exchange leaves the old bundle in staging until the new one opens.
    let flags = UInt32(replacing ? RENAME_SWAP : RENAME_EXCL)
    guard renamex_np(staged.path, target.path, flags) == 0 else {
        let error = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        if replacing { try? run("/usr/bin/open", ["-g", target.path]) }
        throw error
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

func update(_ version: String) throws {
    guard version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil else {
        throw InstallError("Invalid stable release version.")
    }
    let files = FileManager.default
    let support = try files.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        .appendingPathComponent("dev.edgeworkbench.desktop", isDirectory: true)
    try files.createDirectory(at: support, withIntermediateDirectories: true)
    let lock = Darwin.open(support.appendingPathComponent("update.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard lock >= 0 else { throw InstallError("Could not open the update lock.") }
    defer { Darwin.close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw InstallError("Another Dashledge update is in progress.") }
    let work = files.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try files.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? files.removeItem(at: work) }
    let tag = "v\(version)"
    let asset = "Dashledge-\(tag)-macOS-arm64.zip"
    let base = "https://github.com/dgruhin-hrizn/dashledge/releases/download/\(tag)/"
    func download(_ name: String) throws -> URL {
        let dest = work.appendingPathComponent(name)
        try run("/usr/bin/curl", ["--disable", "--fail", "--silent", "--show-error", "--location",
                                  "--proto", "=https", "--proto-redir", "=https", "--retry", "2",
                                  "--connect-timeout", "20", "--max-time", "900", "--output", dest.path, base + name])
        return dest
    }
    let checksum = try String(contentsOf: download(asset + ".sha256"), encoding: .utf8)
    let archive = try download(asset)
    let bytes = try Data(contentsOf: archive, options: .mappedIfSafe)
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    guard checksum.trimmingCharacters(in: .whitespacesAndNewlines) == "\(digest)  \(asset)" else {
        throw InstallError("Downloaded archive failed checksum verification.")
    }
    let extracted = work.appendingPathComponent("unpacked", isDirectory: true)
    try run("/usr/bin/ditto", ["-x", "-k", archive.path, extracted.path])
    try install(extracted.appendingPathComponent("Dashledge.app"), updateVersion: version)
}

do {
    let args = CommandLine.arguments
    if args.count == 3 && args[1] == "--update" {
        try update(args[2])
    } else if args.count == 2 {
        try install(URL(fileURLWithPath: args[1]))
    } else {
        throw InstallError("Expected a signed app path or --update <version>.")
    }
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
