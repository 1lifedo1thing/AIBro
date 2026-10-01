import Foundation
import Security
import Darwin

@main struct CredentialTests {
    static func main() throws {
        if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--worker" {
            let fake = FakeKeychain()
            let store = NativeCredentials(folder: URL(fileURLWithPath: CommandLine.arguments[2]), legacy: nil, service: "synthetic.aibro.tests", operations: fake.operations)
            for index in 0..<12 {
                _ = try store.call(index % 2 == 0 ? "api" : "embedding", "save", ["base": "https://example.invalid/v1", "token": "worker-" + CommandLine.arguments[3] + "-\(index)"])
            }
            check(fake.calls.isEmpty)
            return
        }
        let encrypted = Data(base64Encoded: try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))!
        let plain = try NativeCredentials.decryptLegacy(encrypted, password: Data("synthetic-password".utf8))
        check(plain == Data("synthetic credential record".utf8))
        check((try? NativeCredentials.decryptLegacy(encrypted, password: Data("wrong".utf8))) != plain)
        expectedError("不支持") { _ = try NativeCredentials.decryptLegacy(Data("v11unsupported".utf8), password: Data()) }
        check(try NativeCredentials.origin("https://example.com:443/v1") == "https://example.com")
        check(try NativeCredentials.origin("http://localhost:9900/v1") == "http://localhost:9900")
        expectedError("地址无效") { _ = try NativeCredentials.origin("https://user:password@example.com") }
        print("6 credential compatibility checks passed")
        try credentialFileTests()
        try disposableKeychainTests()
    }
}

private final class FakeKeychain: @unchecked Sendable {
    var allowed = true, denied = false, calls: [String] = [], records: [String: Data] = [:]
    var failedCommit: String?, failSetOnCount = 0, setCount = 0
    var operations: NativeCredentials.Operations {
        var value = NativeCredentials.Operations()
        value.interaction = { (errSecSuccess, self.allowed) }
        value.setInteraction = {
            self.setCount += 1
            if self.setCount == self.failSetOnCount { return errSecNotAvailable }
            self.allowed = $0; self.calls.append($0 ? "ui:true" : "ui:false"); return errSecSuccess
        }
        value.copy = { query in
            check(!self.allowed, "Credential migration must never enable authentication UI")
            let channel = query[kSecAttrAccount as String] as? String ?? ""
            self.calls.append("read:" + channel)
            if self.denied { return (errSecInteractionNotAllowed, nil) }
            guard let bytes = self.records[channel] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, bytes)
        }
        value.beforeCommit = { name in
            if name == self.failedCommit { throw AgendaError.message("synthetic write failure") }
        }
        return value
    }
    func put(_ channel: String, token: String = "synthetic-old", base: String = "https://example.invalid/v1") throws {
        records[channel] = try JSONSerialization.data(withJSONObject: ["base": base, "origin": NativeCredentials.origin(base), "token": token, "model": "test-model"])
    }
}
private func check(_ condition: @autoclosure () throws -> Bool, _ message: String = "Check failed", file: StaticString = #filePath, line: UInt = #line) {
    do { let result = try condition(); precondition(result, message, file: file, line: line) }
    catch { fatalError("Unexpected operation failure: " + error.localizedDescription, file: file, line: line) }
}
private func expectedError(_ text: String, _ operation: () throws -> Void) {
    do { try operation(); fatalError("Expected " + text) }
    catch { check(error.localizedDescription.contains(text), "Unexpected error: " + error.localizedDescription) }
}
private func credentialFileTests() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-file-credentials-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let base = "https://example.invalid/v1", options: [String: Any] = ["base": "https://example.invalid/v1"]
    var groups = 0
    func store(_ fake: FakeKeychain, _ name: String, service: String = "synthetic.aibro.tests") -> NativeCredentials {
        NativeCredentials(folder: directory.appendingPathComponent(name), legacy: nil, service: service, operations: fake.operations)
    }
    func read(_ s: NativeCredentials, _ channel: String = "api") throws -> String {
        try s.call(channel, "read", options)["token"] as? String ?? ""
    }
    func save(_ s: NativeCredentials, _ token: String = "synthetic-new", _ channel: String = "api") throws {
        _ = try s.call(channel, "save", ["base": base, "token": token, "model": "test-model"])
    }
    do {
        let f = FakeKeychain(), s = store(f, "empty")
        let status = s.status("api")
        check(status["hasKey"] as? Bool == false && status["storage"] as? String == "none")
        check(f.calls.isEmpty && !FileManager.default.fileExists(atPath: s.folder.path)); groups += 1
    }
    do {
        let f = FakeKeychain(); f.denied = true
        let s = store(f, "roundtrip"); try save(s)
        check(try read(s) == "synthetic-new")
        let restarted = store(f, "roundtrip")
        check(try read(restarted) == "synthetic-new" && f.calls.isEmpty)
        let status = restarted.status("api")
        check(status["storage"] as? String == "encrypted-file" && status["hasKey"] as? Bool == true && status["requiresUnlock"] as? Bool == false)
        check(status["token"] == nil && status["needsReentry"] as? Bool == false)
        for name in ["device-key.bin", "api.sealed"] {
            let url = s.folder.appendingPathComponent("v2/" + name), attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
            check((try Data(contentsOf: url)).range(of: Data("synthetic-new".utf8)) == nil)
        }
        for url in [s.folder, s.folder.appendingPathComponent("v2")] {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        }
        check((try Data(contentsOf: s.folder.appendingPathComponent("v2/device-key.bin"))).count == 32); groups += 1
    }
    do {
        let f = FakeKeychain(); try f.put("api"); let s = store(f, "migration")
        check(try read(s) == "synthetic-old")
        check(f.calls == ["ui:false", "read:api", "ui:true"] && f.allowed)
        check(try read(store(f, "migration")) == "synthetic-old")
        check(f.calls.count == 3 && f.records["api"] != nil); groups += 1
    }
    do {
        let f = FakeKeychain(); try f.put("api"); f.denied = true; let s = store(f, "locked")
        expectedError("CREDENTIAL_REENTRY_REQUIRED") { _ = try read(s) }
        expectedError("CREDENTIAL_REENTRY_REQUIRED") { _ = try s.call("api", "unlock", options) }
        check(f.calls.filter { $0.hasPrefix("read:") }.count == 1 && f.allowed)
        check(s.status("api")["needsReentry"] as? Bool == true && s.status("api")["storage"] as? String == "legacy-keychain")
        _ = try s.call("api", "authorizeSave", ["base": base, "token": "replacement"])
        check(try read(s) == "replacement" && f.calls.count == 3 && f.records["api"] != nil); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "isolation"); try save(s, "chat"); try save(s, "embedding", "embedding")
        expectedError("另一个服务地址") { _ = try s.call("api", "read", ["base": "https://other.invalid/v1"]) }
        check(try read(s) == "chat" && read(s, "embedding") == "embedding")
        expectedError("校验或解密失败") { _ = try read(store(f, "isolation", service: "other.service")) }
        let chat = s.folder.appendingPathComponent("v2/api.sealed"), emb = s.folder.appendingPathComponent("v2/embedding.sealed")
        try Data(contentsOf: emb).write(to: chat)
        expectedError("校验或解密失败") { _ = try read(s) }; groups += 1
    }
    do {
        let f = FakeKeychain(); try f.put("api"); let s = store(f, "remove"); try save(s)
        _ = try s.call("api", "authorizeRemove", [:])
        check(try read(s).isEmpty && read(store(f, "remove")).isEmpty)
        check(s.status("api")["hasKey"] as? Bool == false && f.calls.isEmpty && f.records["api"] != nil)
        try save(s, "after-delete"); check(try read(s) == "after-delete"); groups += 1
    }
    do {
        let f = FakeKeychain(); try f.put("api"); let s = store(f, "remove-unmigrated")
        _ = try s.call("api", "remove", [:]); check(try read(store(f, "remove-unmigrated")).isEmpty)
        check(f.calls.isEmpty && f.records["api"] != nil); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "failure"); try save(s, "retained")
        let before = try Data(contentsOf: s.folder.appendingPathComponent("v2/api.sealed"))
        f.failedCommit = "api.sealed"
        expectedError("synthetic write failure") { try save(s, "must-not-replace") }
        expectedError("synthetic write failure") { _ = try s.call("api", "remove", [:]) }
        check(try read(s) == "retained" && read(store(f, "failure")) == "retained")
        check(try Data(contentsOf: s.folder.appendingPathComponent("v2/api.sealed")) == before)
        check(!(try FileManager.default.contentsOfDirectory(atPath: s.folder.appendingPathComponent("v2").path)).contains { $0.hasPrefix(".pending-") }); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "retain-empty"); try save(s, "retained")
        _ = try s.call("api", "save", ["base": base, "token": "", "model": "changed"])
        check(try read(s) == "retained" && s.status("api")["model"] as? String == "changed")
        expectedError("另一个服务地址") { _ = try s.call("api", "save", ["base": "https://other.invalid", "token": ""]) }; groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "tampered"); try save(s)
        let url = s.folder.appendingPathComponent("v2/api.sealed"); var bytes = try Data(contentsOf: url)
        bytes[bytes.count - 1] ^= 1; try bytes.write(to: url)
        expectedError("校验或解密失败") { _ = try read(s) }
        check(s.status("api")["available"] as? Bool == false && s.status("api")["storage"] as? String == "unavailable")
        check(f.calls.isEmpty); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "missing-key"); try save(s)
        try FileManager.default.removeItem(at: s.folder.appendingPathComponent("v2/device-key.bin"))
        expectedError("校验或解密失败") { _ = try read(s) }
        expectedError("加密密钥缺失") { try save(s, "new-value") }
        check(!FileManager.default.fileExists(atPath: s.folder.appendingPathComponent("v2/device-key.bin").path)); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "permissions"); try save(s)
        let url = s.folder.appendingPathComponent("v2/device-key.bin")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        expectedError("校验或解密失败") { _ = try read(s) }
        expectedError("0600") { try save(s) }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: s.folder.appendingPathComponent("v2").path)
        expectedError("0700") { _ = try read(s) }; groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "symlink"); try save(s)
        let url = s.folder.appendingPathComponent("v2/api.sealed"), target = directory.appendingPathComponent("untouched-target")
        try Data("untouched".utf8).write(to: target)
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createSymbolicLink(at: url, withDestinationURL: target)
        expectedError("符号链接") { _ = try read(s) }
        expectedError("符号链接") { try save(s) }
        check(try String(contentsOf: target, encoding: .utf8) == "untouched")
        let linked = store(f, "linked-directory")
        try FileManager.default.createSymbolicLink(at: linked.folder, withDestinationURL: s.folder)
        expectedError("符号链接") { try save(linked) }; groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "hardlink"); try save(s)
        let url = s.folder.appendingPathComponent("v2/device-key.bin")
        try FileManager.default.linkItem(at: url, to: directory.appendingPathComponent("hardlinked-key"))
        expectedError("校验或解密失败") { _ = try read(s) }
        expectedError("独立普通文件") { try save(s) }; groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "concurrent"); try save(s)
        DispatchQueue.concurrentPerform(iterations: 40) { index in
            let instance = store(f, "concurrent")
            try! save(instance, "concurrent-\(index)", index % 2 == 0 ? "api" : "embedding")
            check((try! read(instance)).hasPrefix("concurrent-") || (try! read(instance)) == "synthetic-new")
        }
        check(try read(s).hasPrefix("concurrent-") && read(s, "embedding").hasPrefix("concurrent-"))
        check(f.calls.isEmpty); groups += 1
    }
    do {
        let f = FakeKeychain(); try f.put("api"); f.failSetOnCount = 2; let s = store(f, "restore-failure")
        expectedError("CREDENTIAL_REENTRY_REQUIRED") { _ = try read(s) }
        check(s.status("api")["verified"] as? Bool == false)
        let denied = FakeKeychain(); denied.failSetOnCount = 1
        expectedError("CREDENTIAL_REENTRY_REQUIRED") { _ = try read(store(denied, "disable-failure")) }
        check(!denied.calls.contains { $0.hasPrefix("read:") }); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "multiple-processes")
        var workers = [Process]()
        for index in 0..<4 {
            let child = Process(); child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = ["--worker", s.folder.path, String(index)]
            try child.run(); workers.append(child)
        }
        for child in workers { child.waitUntilExit(); check(child.terminationStatus == 0) }
        check(try read(s).hasPrefix("worker-") && read(s, "embedding").hasPrefix("worker-")); groups += 1
    }
    do {
        let f = FakeKeychain(), s = store(f, "fifo"); try save(s)
        let url = s.folder.appendingPathComponent("v2/api.sealed")
        try FileManager.default.removeItem(at: url)
        check(mkfifo(url.path, 0o600) == 0)
        let started = Date()
        expectedError("独立普通文件") { _ = try read(s) }
        check(Date().timeIntervalSince(started) < 1); groups += 1
    }
    print("\(groups) encrypted-file credential groups passed; synthetic credentials and isolated temporary files only")
}

private func disposableKeychainTests() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-legacy-migration-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    var original: DarwinBoolean = false
    check(SecKeychainGetUserInteractionAllowed(&original) == errSecSuccess)
    check(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess)
    defer { _ = SecKeychainSetUserInteractionAllowed(original.boolValue) }
    var searchList: CFArray?; check(SecKeychainCopySearchList(&searchList) == errSecSuccess)
    var keychain: SecKeychain?
    let password = "synthetic-disposable-password", filename = directory.appendingPathComponent("fixture.keychain").path
    let created = filename.withCString { path in password.withCString { secret in SecKeychainCreate(path, UInt32(password.utf8.count), secret, false, nil, &keychain) } }
    check(created == errSecSuccess)
    guard let keychain else { fatalError("Missing disposable keychain") }
    defer { _ = SecKeychainDelete(keychain); _ = SecKeychainSetSearchList(searchList!) }
    let service = "synthetic.aibro.migration." + UUID().uuidString, base = "https://example.invalid/v1"
    let bytes = try JSONSerialization.data(withJSONObject: ["base": base, "origin": NativeCredentials.origin(base), "token": "synthetic-temporary-key", "model": "fixture"])
    let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "api", kSecValueData as String: bytes, kSecUseKeychain as String: keychain]
    check(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)
    var operations = NativeCredentials.Operations()
    operations.copy = { source in
        var query = source; query[kSecMatchSearchList as String] = [keychain]
        var item: CFTypeRef?; let result = SecItemCopyMatching(query as CFDictionary, &item)
        return (result, item as? Data)
    }
    let folder = directory.appendingPathComponent("storage")
    check(SecKeychainLock(keychain) == errSecSuccess)
    let locked = NativeCredentials(folder: folder, legacy: nil, service: service, operations: operations), started = Date()
    expectedError("CREDENTIAL_REENTRY_REQUIRED") { _ = try locked.call("api", "unlock", ["base": base]) }
    check(Date().timeIntervalSince(started) < 3)
    check(password.withCString { SecKeychainUnlock(keychain, UInt32(password.utf8.count), $0, true) } == errSecSuccess)
    let migrator = NativeCredentials(folder: folder, legacy: nil, service: service, operations: operations)
    check(try migrator.call("api", "read", ["base": base])["token"] as? String == "synthetic-temporary-key")
    check(SecKeychainLock(keychain) == errSecSuccess)
    let restarted = NativeCredentials(folder: folder, legacy: nil, service: service, operations: operations)
    check(try restarted.call("api", "read", ["base": base])["token"] as? String == "synthetic-temporary-key")
    _ = try restarted.call("api", "remove", [:])
    check(password.withCString { SecKeychainUnlock(keychain, UInt32(password.utf8.count), $0, true) } == errSecSuccess)
    var lookup = add; lookup.removeValue(forKey: kSecUseKeychain as String); lookup.removeValue(forKey: kSecValueData as String)
    lookup[kSecMatchSearchList as String] = [keychain]; lookup[kSecReturnData as String] = true
    var preserved: CFTypeRef?; check(SecItemCopyMatching(lookup as CFDictionary, &preserved) == errSecSuccess && preserved as? Data == bytes)
    var after: DarwinBoolean = true; check(SecKeychainGetUserInteractionAllowed(&after) == errSecSuccess && !after.boolValue)
    print("1 disposable macOS Keychain migration group passed; local file works while legacy Keychain is locked, original item preserved")
}
