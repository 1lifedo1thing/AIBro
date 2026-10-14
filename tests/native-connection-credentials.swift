import Foundation
import CryptoKit
import Darwin

private func check(_ value: @autoclosure () throws -> Bool, _ name: String) throws {
    guard try value() else { throw NSError(domain: "SyntheticConnectionCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }
}
private func rejects(_ name: String, _ body: () throws -> Void) throws {
    do { try body() } catch { return }
    throw NSError(domain: "SyntheticConnectionCheck", code: 2, userInfo: [NSLocalizedDescriptionKey: name])
}
private let binding: [String: Any] = ["serverOrigin": "https://synthetic.example", "accountId": "synthetic_account"]
private let origin = "https://synthetic.example"
private func session(_ generation: Int = 1, account: String = "synthetic_account", usable: Bool = true) -> [String: Any] {
    ["serverUrl": "http://127.0.0.1:48999/synthetic-prefix", "account": ["id": account], "device": ["id": "synthetic_session"],
     "accessToken": "synthetic-cloud-token-never-real", "credentialStorage": "protected-file", "autoSync": true,
     "connectionSession": ["version": 1, "generation": NativeConnectionSession.encode(Data(repeating: UInt8(generation), count: 32)), "usable": usable, "serverOrigin": origin]]
}
private func writeSession(_ root: URL, _ value: [String: Any]) throws {
    let directory = root.appendingPathComponent("cloud-sync")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = directory.appendingPathComponent("cloud-session.json")
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
}
private func localValue() throws -> [String: Any] {
    let privateKey = P256.KeyAgreement.PrivateKey(), publicBytes = privateKey.publicKey.x963Representation
    let pub: [String: Any] = ["crv": "P-256", "kty": "EC", "x": NativeConnectionSession.encode(publicBytes.subdata(in: 1..<33)), "y": NativeConnectionSession.encode(publicBytes.subdata(in: 33..<65))]
    var key = pub; key["d"] = NativeConnectionSession.encode(privateKey.rawRepresentation)
    let fingerprint = NativeConnectionSession.digest(try JSONSerialization.data(withJSONObject: pub, options: [.sortedKeys]))
    return ["format": "aibro.connection-sync-local.v1", "binding": binding, "role": "owner", "device": ["publicJwk": pub, "privateJwk": key, "fingerprint": fingerprint, "secret": NativeConnectionSession.encode(Data(repeating: 8, count: 32))],
        "trustedOwner": ["publicJwk": pub, "fingerprint": fingerprint], "registeredSessionId": "synthetic_session", "status": "owner", "epoch": 1, "revision": 1, "profiles": [:], "activeProfiles": [:], "pending": NSNull(), "trustedRecipients": [:]]
}
private func fence(_ store: NativeCredentials, _ sessions: NativeConnectionSession) throws -> [String: Any] {
    try store.connectionCall("sessionSnapshot", [:], session: sessions)["session"] as! [String: Any]
}
private func read(_ store: NativeCredentials, _ sessions: NativeConnectionSession, _ f: [String: Any], _ b: [String: Any] = binding) throws -> [String: Any] {
    try store.connectionCall("read", ["binding": b, "sessionFence": f], session: sessions)
}
private func save(_ store: NativeCredentials, _ sessions: NativeConnectionSession, _ f: [String: Any], _ version: Int, _ value: Any, access: NativeConnectionAccess? = nil) throws -> Bool {
    try store.connectionCall("compareAndSwap", ["binding": binding, "sessionFence": f, "expectedRevision": version, "value": value], session: sessions, access: access)["swapped"] as! Bool
}
private func line(_ file: FileHandle) throws -> String {
    var data = Data()
    while let byte = try file.read(upToCount: 1), !byte.isEmpty { if byte == Data([10]) { break }; data.append(byte) }
    return String(decoding: data, as: UTF8.self)
}
private func logoutProcess(_ root: URL) throws -> (Process, Pipe, Pipe) {
    let child = Process(), input = Pipe(), output = Pipe()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    child.arguments = ["-u", "-c", """
import os,fcntl,sys
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
print('waiting',flush=True)
fcntl.flock(fd,fcntl.LOCK_EX)
print('locked',flush=True)
sys.stdin.read(1)
os.unlink('cloud-session.json',dir_fd=fd)
os.fsync(fd)
fcntl.flock(fd,fcntl.LOCK_UN)
os.close(fd)
print('done',flush=True)
""", root.appendingPathComponent("cloud-sync").path]
    child.standardInput = input; child.standardOutput = output; child.standardError = Pipe()
    try child.run(); return (child, input, output)
}

@main struct NativeConnectionCredentialTests {
    static func main() throws {
        if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--reopen" {
            let root=URL(fileURLWithPath:CommandLine.arguments[2]),sessions=NativeConnectionSession(dataDirectory:URL(fileURLWithPath:CommandLine.arguments[2]))
            let store=NativeCredentials(folder:root.appendingPathComponent("native-credentials"),legacy:nil,service:"synthetic.connection.native")
            let oldFence=try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:Any]
            try rejects("prior process fence") { _ = try read(store,sessions,oldFence) }
            try check((try read(store,sessions,fence(store,sessions)))["revision"] as? Int64 == 2,"durable new-process reopen")
            print("new-process reopen passed");return
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-native-connection-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        try writeSession(root, session())
        let sessions = NativeConnectionSession(dataDirectory: root)
        var legacyReads = 0, failWrites = false, before: (() throws -> Void)?
        var operations = NativeCredentials.Operations()
        operations.copy = { _ in legacyReads += 1; return (errSecItemNotFound, nil) }
        operations.beforeCommit = { name in if name == "connections.sealed" { if failWrites { throw NativeConnectionSession.invalid() }; try before?() } }
        let store = NativeCredentials(folder: root.appendingPathComponent("native-credentials"), legacy: nil, service: "synthetic.connection.native", operations: operations)
        let f = try fence(store, sessions), value = try localValue()
        let snapshot = try store.connectionCall("sessionSnapshot", [:], session: sessions)
        let serialized = String(decoding: try JSONSerialization.data(withJSONObject: snapshot), as: UTF8.self)
        try check(!serialized.contains("synthetic-cloud-token") && !serialized.contains("accessToken"), "snapshot excludes token")
        try check((try read(store, sessions, f))["revision"] as? Int64 == 0, "empty read")
        try check(try save(store, sessions, f, 0, value), "first bundle CAS")
        try check(!(try save(store, sessions, f, 0, value)), "stale CAS")
        let sealedURL = root.appendingPathComponent("native-credentials/v2/connections.sealed")
        let saved = try Data(contentsOf: sealedURL)
        try check(saved.range(of: Data("synthetic-cloud-token".utf8)) == nil && saved.range(of: Data("privateJwk".utf8)) == nil, "sealed only")
        let reopened = NativeCredentials(folder: store.folder, legacy: nil, service: store.service)
        try check((try read(reopened, sessions, f))["revision"] as? Int64 == 1, "new native store reads durable bundle")
        print("PASS isolated snapshot, sealed bundle, CAS and reopen")

        var autoOnly = session(); autoOnly["autoSync"] = false; try writeSession(root, autoOnly)
        try check((try fence(store, sessions))["nativeFence"] as? String == f["nativeFence"] as? String, "preference preserves auth fence")
        try writeSession(root, session(2))
        try rejects("same-token generation ABA") { _ = try save(store, sessions, f, 1, value) }
        let fresh = try fence(store, sessions)
        try writeSession(root, session(3, usable: false))
        try rejects("401 unusable session") { _ = try read(store, sessions, fresh) }
        try writeSession(root, session(4, account: "other_account"))
        let other = try fence(store, sessions)
        try rejects("cross account") { _ = try read(store, sessions, other) }
        try check((try read(store, sessions, other, ["serverOrigin": origin, "accountId": "other_account"]))["value"] is NSNull, "no cross-account plaintext")
        try writeSession(root, session(5)); let current = try fence(store, sessions)
        let gate = NativeConnectionAccess.Gate(), lease = gate.capture(); gate.invalidate()
        try rejects("revoked page lease") { _ = try save(store, sessions, current, 1, value, access: lease) }
        try check(try Data(contentsOf: sealedURL) == saved, "rejected fences change no bytes")
        print("PASS account, same-token ABA, unusable session and WK lease")

        failWrites = true
        try rejects("injected pre-rename failure") { _ = try save(store, sessions, current, 1, value) }; failWrites = false
        try check(try Data(contentsOf: sealedURL) == saved, "write failure preserves ciphertext")
        var malformed = value; malformed["extra"] = "not-accepted"
        try rejects("unknown envelope field") { _ = try save(store, sessions, current, 1, malformed) }
        var oversized = value
        oversized["pending"] = ["operation": "commit", "payload": ["opId": "synthetic_op", "expectedEpoch": 1, "expectedRevision": 1, "profiles": [String(repeating: "x", count: 4 * 1024 * 1024)]], "candidate": [:]]
        try rejects("4 MiB aggregate limit") { _ = try save(store, sessions, current, 1, oversized) }
        try check(try Data(contentsOf: sealedURL) == saved, "invalid schema preserves ciphertext")
        print("PASS failure rollback, strict envelope and aggregate bound")

        try rejects("no legacy export") { _ = try store.exportSavedAPI(["apiFormat": "responses"]) }
        try check(legacyReads == 0, "no Keychain reads")
        _ = try store.call("api", "save", ["base": "https://synthetic-provider.example/v1", "token": "synthetic-export-key", "model": "synthetic-model"])
        let exported = try store.exportSavedAPI(["apiFormat": "responses"])
        try check((exported["profile"] as? [String: Any])?["apiKey"] as? String == "synthetic-export-key", "complete saved profile")
        let options: [String: Any] = ["apiFormat": "responses", "sourceDigest": exported["sourceDigest"]!]
        try check(try store.exportSavedAPI(options, verify: true)["valid"] as? Bool == true, "unchanged source")
        _ = try store.call("api", "save", ["base": "https://synthetic-provider.example/v1", "token": "synthetic-updated-key", "model": "synthetic-model"])
        try rejects("changed source digest") { _ = try store.exportSavedAPI(options, verify: true) }
        try rejects("unknown export purpose") { _ = try store.exportSavedAPI(["apiFormat": "embeddings"]) }
        try check(legacyReads == 0, "export never migrates")
        print("PASS full saved API export, source verification and purpose boundary")

        // CAS wins first: the independent Python logout must wait on the same
        // directory inode until credential rename and directory fsync complete.
        var child: (Process, Pipe, Pipe)?
        before = {
            child = try logoutProcess(root)
            try check(try line(child!.2.fileHandleForReading) == "waiting", "logout attempting lock")
            let fd = child!.2.fileHandleForReading.fileDescriptor, flags = fcntl(fd, F_GETFL)
            _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK); usleep(50000)
            var byte: UInt8 = 0
            try check(Darwin.read(fd, &byte, 1) == -1 && errno == EAGAIN, "logout still blocked while CAS owns lock")
            _ = fcntl(fd, F_SETFL, flags)
        }
        try check(try save(store, sessions, current, 1, value), "CAS before logout")
        before = nil
        try check(try line(child!.2.fileHandleForReading) == "locked", "logout acquired after CAS")
        try child!.1.fileHandleForWriting.write(contentsOf: Data([10])); child!.0.waitUntilExit()
        try check(child!.0.terminationStatus == 0, "logout exits")
        try rejects("logged out read") { _ = try read(store, sessions, current) }
        print("PASS cross-process CAS-first linearization")

        // Logout wins first: a queued Swift CAS sees removal after acquiring
        // the lock and cannot restore or write the old credential snapshot.
        try writeSession(root, session(6)); let last = try fence(store, sessions)
        let protectedBytes = try Data(contentsOf: sealedURL), logout = try logoutProcess(root)
        _ = try line(logout.2.fileHandleForReading); try check(try line(logout.2.fileHandleForReading) == "locked", "logout owns lock")
        let done = DispatchSemaphore(value: 0); var accepted = false
        DispatchQueue.global().async { accepted = (try? save(store, sessions, last, 2, value)) == true; done.signal() }
        usleep(50000)
        try logout.1.fileHandleForWriting.write(contentsOf: Data([10])); logout.0.waitUntilExit()
        try check(done.wait(timeout: .now() + 5) == .success && !accepted, "logout blocks old CAS")
        try check(try Data(contentsOf: sealedURL) == protectedBytes, "logout-first changes no vault bytes")
        print("PASS cross-process logout-first linearization")

        try writeSession(root, session(7)); let sessionPath = root.appendingPathComponent("cloud-sync/cloud-session.json")
        let duplicate = root.appendingPathComponent("hardlink")
        try FileManager.default.linkItem(at: sessionPath, to: duplicate)
        try rejects("hardlinked session") { _ = try fence(store, sessions) }
        try FileManager.default.removeItem(at: duplicate)
        let moved = root.appendingPathComponent("moved-session")
        try FileManager.default.moveItem(at: sessionPath, to: moved); try FileManager.default.createSymbolicLink(at: sessionPath, withDestinationURL: moved)
        try rejects("symlink session") { _ = try fence(store, sessions) }
        try FileManager.default.removeItem(at: sessionPath); try FileManager.default.moveItem(at: moved, to: sessionPath)
        let keyURL = root.appendingPathComponent("native-credentials/v2/device-key.bin"), oldKey = try Data(contentsOf: keyURL)
        try FileManager.default.removeItem(at: root.appendingPathComponent("native-credentials/v2/api.sealed"))
        try FileManager.default.removeItem(at: keyURL)
        let freshFence = try fence(store, sessions)
        try rejects("missing key cannot create over connections ciphertext") { _ = try save(store, sessions, freshFence, 0, value) }
        try rejects("old API channel cannot replace missing key over connections-only vault") {
            _ = try store.call("api","save",["base":"https://synthetic-provider.example/v1","model":"synthetic","token":"synthetic-replacement"])
        }
        try check(!FileManager.default.fileExists(atPath: keyURL.path), "no replacement device key")
        try oldKey.write(to: keyURL); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
        try check((try read(store, sessions, freshFence))["revision"] as? Int64 == 2, "old ciphertext still readable")
        let restart=Process(),input=Pipe(),output=Pipe()
        restart.executableURL=URL(fileURLWithPath:CommandLine.arguments[0]);restart.arguments=["--reopen",root.path]
        restart.standardInput=input;restart.standardOutput=output;restart.standardError=Pipe()
        try restart.run();try input.fileHandleForWriting.write(contentsOf:JSONSerialization.data(withJSONObject:freshFence));try input.fileHandleForWriting.close()
        restart.waitUntilExit();try check(restart.terminationStatus==0,"new-process storage and fence check")
        try check(try line(output.fileHandleForReading)=="new-process reopen passed","new-process receipt")
        print("PASS no-follow/hardlink and missing-key preservation")
        print("Native connection credential isolation: 7 groups passed; no real credentials or App launch")
    }
}
