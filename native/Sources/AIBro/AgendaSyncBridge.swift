import Foundation

/// Versioned, content-free status metadata; successful payloads remain private to reconciliation.
enum AgendaSyncPhase: String {
    case read, write, verify, acknowledge
    var label: String {
        switch self {
        case .read: return "读取"
        case .write: return "保存"
        case .verify: return "核对"
        case .acknowledge: return "写入确认"
        }
    }
}

struct AgendaSyncBridgeIssue: Error, LocalizedError {
    let status: String
    let reason: String
    let phase: AgendaSyncPhase
    var errorType = "Error"

    static let deferredReasons: Set<String> = ["hydrating", "saving", "busy", "conflict", "trash_paused", "stale_snapshot"]
    static let errorReasons: Set<String> = ["storage_failed", "storage_disconnected", "invalid_batch", "invalid_identifier", "invalid_note", "duplicate_identifier", "rollback_failed", "unexpected"]
    static let errorTypes: Set<String> = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "AbortError", "QuotaExceededError"]

    var errorDescription: String? { message }
    var message: String {
        if status == "deferred" {
            switch reason {
            case "hydrating": return "正在载入本机工作区，日程稍后对齐"
            case "saving": return "正在保存本机工作区，日程稍后对齐"
            case "busy": return "本机工作区正在处理操作，日程稍后对齐"
            case "conflict": return "本机工作区有保存冲突，请先选择保留版本"
            case "trash_paused": return "正在处理回收站，日程稍后对齐"
            case "stale_snapshot": return "日程内容已更新，正在重新核对"
            default: break
            }
        }
        let detail: String
        switch reason {
        case "storage_failed": detail = "本机数据库暂时无法保存"
        case "storage_disconnected": detail = "与本机数据库连接中断"
        case "invalid_batch": detail = "日程保存批次无效"
        case "invalid_identifier": detail = "日程标识无效"
        case "invalid_note": detail = "日程记录格式无效"
        case "duplicate_identifier": detail = "日程标识重复"
        case "rollback_failed": detail = "保存失败后的恢复未完成，请检查本机工作区"
        case "invalid_response": detail = "本机工作区返回了不兼容的数据"
        case "disk_full": detail = "磁盘空间不足"
        case "permission_denied": detail = "没有本机文件写入权限"
        case "transport": detail = "本机工作区连接异常"
        default: detail = "本机工作区发生未预期错误"
        }
        // errorType is either an allowlisted JS type or a numeric Cocoa/WebKit code.
        return "日程本机对齐未完成：\(detail)（\(phase.label) · \(errorType)）"
    }

    static func invalid(_ phase: AgendaSyncPhase) -> Self {
        .init(status: "error", reason: "invalid_response", phase: phase)
    }
    static func native(_ error: Error, phase: AgendaSyncPhase) -> Self {
        if let issue = error as? Self { return issue }
        let ns = error as NSError
        let domain = ns.domain == NSCocoaErrorDomain ? "Cocoa" : ns.domain == "WKErrorDomain" ? "WebKit" : "Native"
        let reason: String
        if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError { reason = "disk_full" }
        else if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteNoPermissionError { reason = "permission_denied" }
        else { reason = "transport" }
        // NSError userInfo may contain a URL, JavaScript source or a document body.
        return .init(status: "error", reason: reason, phase: phase, errorType: "\(domain) \(ns.code)")
    }
}

struct AgendaSyncBridgeResponse: Decodable {
    let version: Int
    let stage: String
    let status: String
    let reason: String?
    let errorType: String?
    let notes: [String: String]?
    let accepted: [String]?

    static func decode(_ value: Any?, phase: AgendaSyncPhase) throws -> Self {
        guard let raw = value as? String,
              let response = try? JSONDecoder().decode(Self.self, from: Data(raw.utf8)),
              response.version == 1,
              response.stage == (phase == .verify ? "read" : phase.rawValue) else { throw AgendaSyncBridgeIssue.invalid(phase) }
        switch response.status {
        case "ready":
            guard response.reason == nil, response.errorType == nil,
                  phase == .write ? (response.accepted != nil && response.notes == nil) : (response.notes != nil && response.accepted == nil) else { throw AgendaSyncBridgeIssue.invalid(phase) }
        case "deferred", "error":
            guard response.notes == nil, response.accepted == nil, let reason = response.reason,
                  response.status == "deferred" ? AgendaSyncBridgeIssue.deferredReasons.contains(reason) : AgendaSyncBridgeIssue.errorReasons.contains(reason),
                  response.errorType == nil || AgendaSyncBridgeIssue.errorTypes.contains(response.errorType!) else { throw AgendaSyncBridgeIssue.invalid(phase) }
            throw AgendaSyncBridgeIssue(status: response.status, reason: reason, phase: phase, errorType: response.errorType ?? "Error")
        default: throw AgendaSyncBridgeIssue.invalid(phase)
        }
        return response
    }
}
