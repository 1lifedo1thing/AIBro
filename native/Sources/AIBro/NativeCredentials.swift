import Foundation
import Security
import CommonCrypto
import CryptoKit
import Darwin

/// Local, authenticated encrypted storage. The random encryption key stays in the
/// same private native directory; this avoids Keychain authentication dependencies,
/// but does not protect against another process running as this macOS user.
final class NativeCredentials: @unchecked Sendable {
    private static let lock = NSRecursiveLock()
    struct Operations {
        // Legacy migration is read-only, always with system authentication UI disabled.
        var copy: ([String: Any]) -> (OSStatus, Data?) = { query in
            var item: CFTypeRef?
            let result = SecItemCopyMatching(query as CFDictionary, &item)
            return (result, item as? Data)
        }
        var interaction: () -> (OSStatus, Bool) = {
            var allowed: DarwinBoolean = false
            return (SecKeychainGetUserInteractionAllowed(&allowed), allowed.boolValue)
        }
        var setInteraction: (Bool) -> OSStatus = { SecKeychainSetUserInteractionAllowed($0) }
        // Fault injection for isolated durability tests; called before atomic rename.
        var beforeCommit: (String) throws -> Void = { _ in }
    }
    private let operations: Operations
    private var blocked = Set<String>()
    let folder: URL
    let legacy: URL?
    let service: String
    init(folder: URL, legacy: URL?, service: String, operations: Operations = Operations()) {
        self.folder = folder; self.legacy = legacy; self.service = service; self.operations = operations
    }
    private func failure(_ text: String) -> Error { AgendaError.message("[CREDENTIAL_STORAGE_ERROR] " + text) }
    private func reentry() -> Error {
        AgendaError.message("[CREDENTIAL_REENTRY_REQUIRED] 旧 Key 无法静默读取。请重新粘贴 API Key，保存到本机加密文件后即可使用，无需输入登录密码。原钥匙串记录未改动。")
    }
    private func legacyFile(_ channel: String) -> URL? {
        legacy?.appendingPathComponent(channel == "api" ? "credentials/api.json" : "embedding-credentials/api.json")
    }
    private func query(_ channel: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: channel,
         kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    }
    static func origin(_ base: String) throws -> String {
        guard base.utf8.count <= 8192, let u = URLComponents(string: base), ["https", "http"].contains(u.scheme?.lowercased() ?? ""),
              let host = u.host, !host.isEmpty, u.user == nil, u.password == nil, u.fragment == nil else {
            throw AgendaError.message("API 地址无效。")
        }
        let scheme = u.scheme!.lowercased(), port = u.port
        return scheme + "://" + host.lowercased() + (port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ? "" : ":\(port!)")
    }

    // Open the trusted parent once, then use directory-relative, no-follow operations.
    // In particular, never resolve a symlink at the credential directory or its files.
    private func directory(create: Bool) throws -> Int32? {
        let parent = folder.deletingLastPathComponent().resolvingSymlinksInPath()
        let p = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard p >= 0 else { throw failure("无法打开本机凭据的父目录，已有凭据未改动。") }
        defer { Darwin.close(p) }
        func child(_ parentFD: Int32, _ name: String) throws -> Int32? {
            if create && mkdirat(parentFD, name, 0o700) != 0 && errno != EEXIST {
                throw failure("无法创建本机凭据目录，已有凭据未改动。")
            }
            let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if fd < 0 && errno == ENOENT && !create { return nil }
            guard fd >= 0 else { throw failure("本机凭据目录不可访问或为符号链接。") }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
                Darwin.close(fd); throw failure("本机凭据目录必须由当前用户拥有，权限为 0700。")
            }
            return fd
        }
        guard let root = try child(p, folder.lastPathComponent) else { return nil }
        defer { Darwin.close(root) }
        return try child(root, "v2")
    }
    private func withStore<T>(create: Bool, _ body: (Int32?) throws -> T) throws -> T {
        guard let fd = try directory(create: create) else { return try body(nil) }
        defer { Darwin.close(fd) }
        // Lock the already verified directory inode. A separate lock file would
        // add an unnecessary creation race when two app processes start together.
        while flock(fd, LOCK_EX) != 0 {
            if errno == EINTR { continue }
            throw failure("无法锁定本机凭据目录（\(errno)）。")
        }
        defer { _ = flock(fd, LOCK_UN) }
        return try body(fd)
    }
    private func verifyFile(_ fd: Int32) throws {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_mode & 0o777 == 0o600, info.st_nlink == 1 else {
            throw failure("本机凭据文件必须是当前用户拥有的独立普通文件，权限为 0600。")
        }
    }
    private func readFile(_ name: String, at directory: Int32) throws -> Data? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw failure("本机凭据文件不可访问或为符号链接。") }
        defer { Darwin.close(fd) }
        try verifyFile(fd)
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size <= 131072 else { throw failure("本机凭据文件格式无效。") }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw failure("本机凭据文件读取失败。") }
            if count == 0 { break }
            result.append(contentsOf: buffer.prefix(count))
            guard result.count <= 131072 else { throw failure("本机凭据文件格式无效。") }
        }
        return result
    }
    private func atomicWrite(_ data: Data, name: String, at directory: Int32) throws {
        // Reject a replaced, insecure or linked destination before writing anything.
        _ = try readFile(name, at: directory)
        let temporary = ".pending-" + UUID().uuidString
        let fd = openat(directory, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw failure("无法保存本机凭据，原记录已保留。") }
        defer { Darwin.close(fd); _ = unlinkat(directory, temporary, 0) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure("本机凭据写入失败，原记录已保留。") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw failure("本机凭据未能持久保存，原记录已保留。") }
        try operations.beforeCommit(name)
        guard renameat(directory, temporary, directory, name) == 0 else { throw failure("本机凭据替换失败，原记录已保留。") }
        guard fsync(directory) == 0 else { throw failure("本机凭据已写入，但目录持久化未确认；请重试。") }
    }
    private func encryptionKey(at directory: Int32, create: Bool) throws -> SymmetricKey {
        if let bytes = try readFile("device-key.bin", at: directory) {
            guard bytes.count == 32 else { throw failure("本机加密密钥格式无效，凭据未改动。") }
            return SymmetricKey(data: bytes)
        }
        // Never replace a missing encryption key while old ciphertext still exists.
        guard create, try readFile("api.sealed", at: directory) == nil, try readFile("embedding.sealed", at: directory) == nil else {
            throw failure("本机加密密钥缺失，已有凭据无法读取。")
        }
        let key = SymmetricKey(size: .bits256)
        try atomicWrite(key.withUnsafeBytes { Data($0) }, name: "device-key.bin", at: directory)
        return key
    }
    private func authenticatedData(_ channel: String) -> Data { Data(("AI Bro credentials v2\u{0}" + service + "\u{0}" + channel).utf8) }
    private func localRecord(_ channel: String, at directory: Int32?) throws -> [String: Any]? {
        guard let directory, let sealed = try readFile(channel + ".sealed", at: directory) else { return nil }
        do {
            let key = try encryptionKey(at: directory, create: false)
            let plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: authenticatedData(channel))
            guard let envelope = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
                  envelope["version"] as? Int == 2, envelope["channel"] as? String == channel else { throw failure("凭据内容无效。") }
            return envelope
        } catch { throw failure("本机凭据校验或解密失败，已有文件未改动。") }
    }
    private func writeRecord(_ channel: String, _ record: [String: Any]?, at directory: Int32) throws {
        let key = try encryptionKey(at: directory, create: true)
        var envelope: [String: Any] = ["version": 2, "channel": channel, "removed": record == nil]
        if let record { envelope["record"] = record }
        let plaintext = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        guard let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: authenticatedData(channel)).combined else { throw failure("本机凭据加密失败。") }
        try atomicWrite(sealed, name: channel + ".sealed", at: directory)
    }
    private func legacyBytes(_ url: URL) throws -> Data? {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw reentry() }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_nlink == 1, info.st_size <= 131072 else { throw reentry() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw reentry() }
            if count == 0 { break }
            result.append(contentsOf: buffer.prefix(count))
            guard result.count <= 131072 else { throw reentry() }
        }
        return result
    }
    private func legacyMetadata(_ channel: String) -> [String: Any] {
        guard let bytes = try? legacyBytes(folder.appendingPathComponent(channel + ".json")) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]) ?? [:]
    }
    private func statusValue(_ channel: String) -> [String: Any] {
        do {
            if let envelope = try withStore(create: false, { try localRecord(channel, at: $0) }) {
                let record = envelope["record"] as? [String: Any], hasKey = envelope["removed"] as? Bool != true && !(record?["token"] as? String ?? "").isEmpty
                return ["available": hasKey, "hasKey": hasKey, "verified": hasKey, "requiresUnlock": false,
                        "storage": "encrypted-file", "backend": "encrypted-file", "legacyLocked": false, "needsReentry": false,
                        "base": record?["base"] as? String ?? "", "model": record?["model"] as? String ?? ""]
            }
        } catch {
            return ["available": false, "hasKey": true, "verified": false, "requiresUnlock": false,
                    "storage": "unavailable", "backend": "encrypted-file", "legacyLocked": false, "needsReentry": false,
                    "error": error.localizedDescription, "base": "", "model": ""]
        }
        let m = legacyMetadata(channel)
        let old = m["removed"] as? Bool != true && (m["hasKey"] as? Bool == true || legacyFile(channel).map { FileManager.default.fileExists(atPath: $0.path) } == true || blocked.contains(channel))
        return ["available": false, "hasKey": old, "verified": false, "requiresUnlock": false,
                "storage": old ? "legacy-keychain" : "none", "backend": "encrypted-file", "legacyLocked": old, "needsReentry": old,
                "base": m["base"] as? String ?? "", "model": m["model"] as? String ?? ""]
    }
    func status(_ channel: String) -> [String: Any] {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard ["api", "embedding"].contains(channel) else { return ["available": false, "hasKey": false] }
        return statusValue(channel)
    }
    private func validate(_ record: [String: Any], origin: String) throws -> [String: Any] {
        guard let base = record["base"] as? String, try Self.origin(base) == origin,
              record["origin"] as? String == origin, let token = record["token"] as? String, !token.isEmpty,
              token.utf8.count <= 16384, !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw AgendaError.message("已保存的 Key 属于另一个服务地址或格式无效，未提供给当前地址。")
        }
        return record
    }
    private func legacyRecord(_ channel: String) throws -> [String: Any]? {
        guard legacyMetadata(channel)["removed"] as? Bool != true else { return nil }
        if blocked.contains(channel) { throw reentry() }
        let (readStatus, original) = operations.interaction()
        guard readStatus == errSecSuccess, operations.setInteraction(false) == errSecSuccess else { blocked.insert(channel); throw reentry() }
        let outcome = Result<[String: Any]?, Error> { () throws -> [String: Any]? in
            let (result, bytes) = operations.copy(query(channel))
            if result == errSecSuccess, let bytes {
                guard let record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw reentry() }
                return record
            }
            guard result == errSecItemNotFound else { throw reentry() }
            guard let file = legacyFile(channel), let raw = try legacyBytes(file) else {
                if legacyMetadata(channel)["hasKey"] as? Bool == true { throw reentry() }
                return nil
            }
            let envelope = try JSONSerialization.jsonObject(with: raw) as? [String: Any]
            guard let value = envelope?["ciphertext"] as? String, let encrypted = Data(base64Encoded: value) else { throw reentry() }
            let old: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ai-workstation Safe Storage", kSecAttrAccount as String: "ai-workstation", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            let (status, password) = operations.copy(old)
            guard status == errSecSuccess, let password else { throw reentry() }
            return try JSONSerialization.jsonObject(with: Self.decryptLegacy(encrypted, password: password)) as? [String: Any]
        }
        guard operations.setInteraction(original) == errSecSuccess else { blocked.insert(channel); throw reentry() }
        switch outcome {
        case .success(let value): return value
        case .failure: blocked.insert(channel); throw reentry()
        }
    }
    private func record(_ channel: String, origin: String, at directory: Int32) throws -> [String: Any]? {
        if let envelope = try localRecord(channel, at: directory) {
            if envelope["removed"] as? Bool == true { return nil }
            guard let record = envelope["record"] as? [String: Any] else { throw failure("本机凭据内容无效。") }
            return try validate(record, origin: origin)
        }
        guard let old = try legacyRecord(channel) else { return nil }
        let checked = try validate(old, origin: origin)
        try writeRecord(channel, checked, at: directory)
        blocked.remove(channel)
        return checked
    }
    static func decryptLegacy(_ encrypted: Data, password: Data) throws -> Data {
        guard encrypted.prefix(3) == Data("v10".utf8) else { throw AgendaError.message("不支持此旧版凭据加密格式。") }
        var key = [UInt8](repeating: 0, count: 16); let salt = Array("saltysalt".utf8)
        let derivation = password.withUnsafeBytes { p in CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.bindMemory(to: Int8.self).baseAddress, password.count, salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, &key, key.count) }
        let cipher = Data(encrypted.dropFirst(3)), iv = [UInt8](repeating: 32, count: 16)
        var output = [UInt8](repeating: 0, count: cipher.count + 16), length = 0
        let result = cipher.withUnsafeBytes { p in CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding), key, key.count, iv, p.baseAddress, cipher.count, &output, output.count, &length) }
        guard derivation == kCCSuccess, result == kCCSuccess else { throw AgendaError.message("无法解密旧版凭据；旧文件未改动。") }
        return Data(output.prefix(length))
    }
    func call(_ channel: String, _ action: String, _ options: [String: Any]) throws -> [String: Any] {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard ["api", "embedding"].contains(channel) else { throw AgendaError.message("未知凭据类型") }
        guard ["status", "read", "unlock", "save", "authorizeSave", "remove", "authorizeRemove"].contains(action) else { throw AgendaError.message("未知凭据操作") }
        if action == "status" { return statusValue(channel) }
        let result: [String: Any]? = try withStore(create: true) { fd in
            guard let fd else { throw failure("本机凭据目录不可用。") }
            if action == "remove" || action == "authorizeRemove" {
                // A durable tombstone suppresses both native and old Electron records.
                // Do not modify or delete old Keychain items, even on explicit removal.
                try writeRecord(channel, nil, at: fd); blocked.remove(channel); return nil
            }
            let base = (options["base"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines), origin = try Self.origin(base)
            if action == "read" || action == "unlock" {
                let saved = try record(channel, origin: origin, at: fd)
                if action == "unlock" { return nil }
                return ["base": saved?["base"] as? String ?? base, "token": saved?["token"] as? String ?? "", "model": saved?["model"] as? String ?? ""]
            }
            var token = (options["token"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                guard let old = try record(channel, origin: origin, at: fd) else { throw AgendaError.message("请填写当前服务的 API Key。") }
                token = old["token"] as? String ?? ""
            }
            let model = options["model"] as? String ?? ""
            guard !token.isEmpty, token.utf8.count <= 16384, !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains), model.count <= 512 else { throw AgendaError.message("Key 或模型格式无效") }
            let value: [String: Any] = ["base": base, "token": token, "model": model, "origin": origin]
            try writeRecord(channel, value, at: fd); blocked.remove(channel); return nil
        }
        return result ?? statusValue(channel)
    }
}
