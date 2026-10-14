import Foundation
import Security
import CryptoKit

@main struct CredentialProfileTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-scheme-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var failWrite = false
        var operations = NativeCredentials.Operations()
        operations.copy = { _ in fatalError("Scheme operations must not enter Keychain") }
        operations.beforeCommit = { if failWrite && $0 == "api.sealed" { throw AgendaError.message("synthetic failure") } }
        let folder = root.appendingPathComponent("vault")
        let store = NativeCredentials(folder: folder, legacy: nil, service: "synthetic.schemes", operations: operations)
        let a = "https://example.invalid/v1", b = "https://example.invalid/v2"
        var count = 0
        func check(_ condition: @autoclosure () throws -> Bool) throws { guard try condition() else { fatalError("Check \(count+1) failed") }; count += 1 }
        func rejects(_ operation: () throws -> Void) { do { try operation(); fatalError("Expected rejection") } catch { count += 1 } }
        func list(_ channel: String = "api") throws -> [String: Any] { try store.call(channel, "profile-list", [:]) }
        func revision(_ channel: String = "api") throws -> Int { try list(channel)["revision"] as! Int }
        func save(_ id: String, _ token: String, base: String? = nil, channel: String = "api", settings: [String: Any] = [:]) throws {
            _ = try store.call(channel, "profile-save", ["id": id, "name": id, "base": base ?? a, "model": "synthetic-model", "token": token, "settings": settings, "expectedRevision": revision(channel)])
        }
        try check((try list()["profiles"] as! [[String: Any]]).isEmpty)
        try check(!FileManager.default.fileExists(atPath: folder.path))
        _ = try store.call("api", "save", ["base": a, "model": "legacy", "token": "synthetic-legacy"])
        try check(try list()["activeProfileID"] as? String == "default")
        try check(try revision() == 1)
        try save("second", "synthetic-second")
        try check((try list()["profiles"] as! [[String: Any]]).count == 2)
        try check(try store.call("api", "read", ["base": a])["token"] as? String == "synthetic-second")
        let meta = String(decoding: try JSONSerialization.data(withJSONObject: list()), as: UTF8.self)
        try check(!meta.contains("synthetic-second") && !meta.contains("synthetic-legacy"))
        rejects { try save("new-empty", "") }
        rejects { try save("second", "", base: b) }
        try save("second", "", base: a + "/")
        try check(try store.call("api", "profile-read", ["id": "second", "base": a, "expectedRevision": revision()])["token"] as? String == "synthetic-second")
        let stale = try revision() - 1
        rejects { _ = try store.call("api", "profile-select", ["id": "default", "expectedRevision": stale]) }
        rejects { _ = try store.call("api", "profile-read", ["id": "second", "base": a, "expectedRevision": stale]) }
        rejects { _ = try store.call("api", "profile-read", ["id": "second", "base": b]) }
        let sealedURL = folder.appendingPathComponent("v2/api.sealed")
        let before = try Data(contentsOf: sealedURL)
        failWrite = true
        rejects { try save("failed", "synthetic-failed") }
        try check(try Data(contentsOf: sealedURL) == before)
        try check(try list()["activeProfileID"] as? String == "second")
        failWrite = false
        _ = try store.call("api", "profile-select", ["id": "default", "expectedRevision": revision()])
        try check(try store.call("api", "read", ["base": a])["token"] as? String == "synthetic-legacy")
        _ = try store.call("api", "save", ["base": a, "model": "changed", "token": "synthetic-changed"])
        try check((try list()["profiles"] as! [[String: Any]]).count == 2)
        try check(try store.call("api", "profile-read", ["id": "second", "base": a])["token"] as? String == "synthetic-second")
        _ = try store.call("api", "remove", [:])
        try check(try list()["activeProfileID"] as? String == "")
        try check((try list()["profiles"] as! [[String: Any]]).count == 1)
        try save("local", "", channel: "embedding", settings: ["noKey": true, "dimensions": 384])
        try check(try store.call("embedding", "read", ["base": a])["token"] as? String == "")
        try check(try store.call("embedding", "profile-read", ["id": "local", "base": a])["token"] as? String == "")
        try check(try list()["activeProfileID"] as? String == "")
        rejects { try save("local", "", channel: "embedding", settings: ["noKey": false]) }
        rejects { try save("bad", "", settings: ["noKey": true]) }
        let restarted = NativeCredentials(folder: folder, legacy: nil, service: "synthetic.schemes", operations: operations)
        try check((try restarted.call("api", "profile-list", [:])["profiles"] as! [[String: Any]]).count == 1)
        let encrypted = try Data(contentsOf: sealedURL)
        try check(encrypted.range(of: Data("synthetic-second".utf8)) == nil)
        // No active scheme is not permission to mutate an inactive "default".
        let inactiveFolder = root.appendingPathComponent("inactive-default")
        let inactive = NativeCredentials(folder: inactiveFolder, legacy: nil, service: "synthetic.inactive-default", operations: operations)
        _ = try inactive.call("api", "save", ["base": a, "model": "legacy-A", "token": "synthetic-preserved-A"])
        _ = try inactive.call("api", "profile-save", ["id": "B", "name": "B", "base": a, "model": "B", "token": "synthetic-B", "expectedRevision": inactive.call("api", "profile-list", [:])["revision"]!])
        _ = try inactive.call("api", "profile-remove", ["id": "B", "expectedRevision": inactive.call("api", "profile-list", [:])["revision"]!])
        let beforeOldRemove = try inactive.call("api", "profile-list", [:])
        try check(beforeOldRemove["activeProfileID"] as? String == "")
        try check((beforeOldRemove["profiles"] as! [[String: Any]]).map { $0["id"] as! String } == ["default"])
        _ = try inactive.call("api", "remove", [:])
        let afterOldRemove = try inactive.call("api", "profile-list", [:])
        try check(afterOldRemove["activeProfileID"] as? String == "")
        try check(NSDictionary(dictionary: (afterOldRemove["profiles"] as! [[String: Any]])[0]).isEqual(to: (beforeOldRemove["profiles"] as! [[String: Any]])[0]))
        try check(try inactive.call("api", "profile-read", ["id": "default", "base": a])["token"] as? String == "synthetic-preserved-A")
        _ = try inactive.call("api", "save", ["base": b, "model": "new-C", "token": "synthetic-new-C"])
        let afterOldSave = try inactive.call("api", "profile-list", [:])
        let freshID = afterOldSave["activeProfileID"] as! String
        try check(!freshID.isEmpty && freshID != "default")
        try check((afterOldSave["profiles"] as! [[String: Any]]).count == 2)
        try check(try inactive.call("api", "profile-read", ["id": "default", "base": a])["token"] as? String == "synthetic-preserved-A")
        try check(try inactive.call("api", "profile-read", ["id": freshID, "base": b])["token"] as? String == "synthetic-new-C")
        let inactiveRestart = NativeCredentials(folder: inactiveFolder, legacy: nil, service: "synthetic.inactive-default", operations: operations)
        try check((try inactiveRestart.call("api", "profile-list", [:])["profiles"] as! [[String: Any]]).count == 2)
        // Seed a genuine pre-catalog encrypted envelope: no revision field on disk.
        // This only reads the synthetic key created under this test's temporary root.
        let oldFolder = root.appendingPathComponent("pre-catalog")
        let oldService = "synthetic.pre-catalog"
        let old = NativeCredentials(folder: oldFolder, legacy: nil, service: oldService, operations: operations)
        _ = try old.call("api", "save", ["base": a, "model": "old-A", "token": "synthetic-old-A"])
        let oldSealedURL = oldFolder.appendingPathComponent("v2/api.sealed")
        let oldKey = SymmetricKey(data: try Data(contentsOf: oldFolder.appendingPathComponent("v2/device-key.bin")))
        let aad = Data(("AI Bro credentials v2\u{0}" + oldService + "\u{0}api").utf8)
        let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: Data(contentsOf: oldSealedURL)), using: oldKey, authenticating: aad)
        var oldEnvelope = try JSONSerialization.jsonObject(with: plain) as! [String: Any]
        oldEnvelope.removeValue(forKey: "profileRevision")
        let oldCipher = try AES.GCM.seal(JSONSerialization.data(withJSONObject: oldEnvelope), using: oldKey, authenticating: aad).combined!
        try oldCipher.write(to: oldSealedURL)
        let beforeMigration = try Data(contentsOf: oldSealedURL)
        let oldRevision = try old.call("api", "profile-list", [:])["revision"] as! Int
        try check(oldRevision == 0)
        try check(try Data(contentsOf: oldSealedURL) == beforeMigration)
        let otherWindow = NativeCredentials(folder: oldFolder, legacy: nil, service: oldService, operations: operations)
        _ = try otherWindow.call("api", "save", ["base": a, "model": "old-B", "token": "synthetic-old-B"])
        try check(try old.call("api", "profile-list", [:])["revision"] as? Int == oldRevision + 1)
        let afterOldWrite = try Data(contentsOf: oldSealedURL)
        rejects { _ = try old.call("api", "profile-save", ["id": "default", "name": "stale-A", "base": a, "model": "stale", "token": "synthetic-stale", "expectedRevision": oldRevision]) }
        try check(try Data(contentsOf: oldSealedURL) == afterOldWrite)
        try check(try old.call("api", "profile-read", ["id": "default", "base": a, "expectedRevision": oldRevision + 1])["token"] as? String == "synthetic-old-B")
        _ = try otherWindow.call("api", "remove", [:])
        try check(try old.call("api", "profile-list", [:])["revision"] as? Int == oldRevision + 2)
        rejects { _ = try old.call("api", "profile-save", ["id": "default", "name": "deleted-A", "base": a, "model": "stale", "token": "synthetic-stale", "expectedRevision": oldRevision + 1]) }
        print("\(count) credential scheme checks passed")
    }
}
