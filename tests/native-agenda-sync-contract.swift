import Foundation
import WebKit

// Replace only transport/storage side effects. Compile the actual response decoder,
// AgendaWire planner and Workspace reconciliation method to exercise their contract.
@MainActor final class ScriptedAgendaWeb {
    var replies: [Result<Any?, Error>] = []
    var calls = 0
    func callAsyncJavaScript(_ body: String, arguments: [String:Any], in frame: WKFrameInfo?, contentWorld: WKContentWorld) async throws -> Any? {
        calls += 1
        precondition(!replies.isEmpty, "Unexpected transport call")
        return try replies.removeFirst().get()
    }
}
@MainActor final class AgendaAckSpy {
    var events: [AgendaEvent] = []
    var syncReceipts: [String:AgendaSyncReceipt] = [:]
    var acknowledged: [AgendaSyncChange] = []
    var failure: Error?
    func acknowledgeSync(_ changes: [AgendaSyncChange]) throws {
        if let failure { throw failure }
        acknowledged.append(contentsOf: changes)
    }
    func resolveSync(_ conflict: AgendaSyncConflict, useRemote: Bool) throws {}
}
@MainActor final class Workspace {
    var ready = true
    var agendaSyncRunning = false
    var web = ScriptedAgendaWeb()
    var agenda = AgendaAckSpy()
    var agendaSyncStatus = ""
    var agendaSyncConflicts: [AgendaSyncConflict] = []
}

@main struct AgendaStatusTests {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ pass: Bool, _ name: String) { precondition(pass, name); count += 1 }
        let fixtures = try JSONDecoder().decode([String:String].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        func issue(_ raw: Any?, phase: AgendaSyncPhase = .read) -> AgendaSyncBridgeIssue? {
            do { _ = try AgendaSyncBridgeResponse.decode(raw,phase:phase); return nil }
            catch { return error as? AgendaSyncBridgeIssue }
        }
        func envelope(_ stage: String = "read", _ fields: [String:Any]) throws -> String {
            var result: [String:Any] = ["version":1,"stage":stage]
            result.merge(fields) {_,new in new}
            return String(decoding:try JSONSerialization.data(withJSONObject:result),as:UTF8.self)
        }
        func run(_ model: Workspace, _ replies: [String]) async {
            model.web.replies = replies.map { .success($0) }
            model.requestAgendaSync()
            for _ in 0..<1000 where model.agendaSyncRunning { await Task.yield() }
            precondition(!model.agendaSyncRunning, "reconciliation never released its busy flag")
        }
        check(try AgendaSyncBridgeResponse.decode(fixtures["read"],phase:.read).notes?["a"] != nil,"JS read payload survives actual Swift decoding")
        check(try AgendaSyncBridgeResponse.decode(fixtures["write"],phase:.write).accepted == ["a"],"JS write ACK survives actual Swift decoding")
        for reason in ["hydrating","saving","busy","conflict"] {
            let value = issue(fixtures[reason])
            check(value?.status == "deferred" && value?.reason == reason,"known wait remains distinct: " + reason)
            check(!(value?.message.contains("异常") ?? true),"expected wait is not an exception")
        }
        check(issue(fixtures["disconnected"],phase:.write)?.message.contains("与本机数据库连接中断") == true,"known storage failure keeps actionable business reason")
        check(issue(fixtures["read"],phase:.write)?.reason == "invalid_response","wrong stage is rejected")
        check(issue(try envelope("read",["status":"ready"]))?.reason == "invalid_response","missing notes is invalid, never an empty successful snapshot")
        check(issue("{invalid}")?.reason == "invalid_response","malformed transport is rejected")
        check(issue(try envelope("read",["status":"deferred","reason":"private-note-body"]))?.reason == "invalid_response","arbitrary reason cannot leak into UI")
        check(issue(try envelope("read",["status":"error","reason":"unexpected","errorType":"private-note-body"]))?.reason == "invalid_response","arbitrary exception type is rejected")
        check(issue(try envelope("read",["status":"deferred","reason":"saving","notes":["private":"body"]]))?.reason == "invalid_response","wait must not carry private payload")
        let nativeError=NSError(domain:"WKErrorDomain",code:4,userInfo:[NSLocalizedDescriptionKey:"private-key-and-document-body"])
        let nativeIssue=AgendaSyncBridgeIssue.native(nativeError,phase:.verify)
        check(!nativeIssue.message.contains("private") && nativeIssue.message.contains("WebKit 4") && nativeIssue.message.contains("核对"),"transport reports safe stage/code instead of raw JavaScript text")
        check(AgendaSyncBridgeIssue.native(NSError(domain:NSCocoaErrorDomain,code:NSFileWriteOutOfSpaceError),phase:.acknowledge).message.contains("磁盘空间不足"),"native out-of-space reason retained")

        let recovery=Workspace()
        for reason in ["hydrating","saving"] {
            await run(recovery,[fixtures[reason]!])
            check(recovery.agenda.acknowledged.isEmpty,"waiting never acknowledges")
            check(recovery.agendaSyncStatus == issue(fixtures[reason])?.message,"actual owner renders precise wait")
        }
        await run(recovery,[fixtures["empty"]!,fixtures["empty"]!])
        check(recovery.agendaSyncStatus == "日程已与本机工作区对齐","next scheduled call clears wait with local-only success")
        check(recovery.web.calls == 4,"wait calls stopped early; success still verifies snapshot")

        let pull=Workspace()
        await run(pull,[fixtures["read"]!,fixtures["read"]!])
        check(pull.agenda.acknowledged.count == 1,"verified pull gets one acknowledgement")
        let stalePull=Workspace()
        await run(stalePull,[fixtures["read"]!,fixtures["empty"]!])
        check(stalePull.agenda.acknowledged.isEmpty && stalePull.agendaSyncStatus.contains("重新核对"),"changed verification snapshot cannot be acknowledged or shown complete")
        let deferredVerify=Workspace()
        await run(deferredVerify,[fixtures["read"]!,fixtures["saving"]!])
        check(deferredVerify.agenda.acknowledged.isEmpty && deferredVerify.agendaSyncStatus.contains("正在保存"),"saving at verify phase never acknowledges old read")
        let malformedVerify=Workspace()
        await run(malformedVerify,[fixtures["read"]!,try envelope("read",["status":"ready"])])
        check(malformedVerify.agenda.acknowledged.isEmpty && malformedVerify.agendaSyncStatus.contains("核对"),"malformed verification cannot silently become empty notes")

        var event=AgendaEvent();event.id="mobile:a";event.title="Native synthetic"
        let acceptedA=try envelope("write",["status":"ready","accepted":["a"]])
        let omittedA=try envelope("write",["status":"ready","accepted":[]])
        let push=Workspace();push.agenda.events=[event]
        await run(push,[fixtures["empty"]!,acceptedA,fixtures["empty"]!])
        check(push.agenda.acknowledged.count == 1,"exact write ACK is retained")
        let omitted=Workspace();omitted.agenda.events=[event]
        await run(omitted,[fixtures["empty"]!,omittedA,fixtures["empty"]!])
        check(omitted.agenda.acknowledged.isEmpty && omitted.agendaSyncStatus.contains("重新核对"),"unacknowledged write remains pending")
        let invalidACK=Workspace();invalidACK.agenda.events=[event]
        await run(invalidACK,[fixtures["empty"]!,try envelope("write",["status":"ready","accepted":["other"]])])
        check(invalidACK.agenda.acknowledged.isEmpty && invalidACK.agendaSyncStatus.contains("不兼容"),"ACK cannot mention an unsubmitted note")
        let saveFailed=Workspace();saveFailed.agenda.events=[event]
        await run(saveFailed,[fixtures["empty"]!,fixtures["disconnected"]!])
        check(saveFailed.agenda.acknowledged.isEmpty && saveFailed.agendaSyncStatus.contains("连接中断"),"write error returns its actual failure reason without ACK")
        let ackFailed=Workspace();ackFailed.agenda.failure=NSError(domain:NSCocoaErrorDomain,code:NSFileWriteOutOfSpaceError)
        await run(ackFailed,[fixtures["read"]!,fixtures["read"]!])
        check(ackFailed.agenda.acknowledged.isEmpty && ackFailed.agendaSyncStatus.contains("写入确认") && ackFailed.agendaSyncStatus.contains("磁盘空间不足"),"native receipt persistence failure is never success")
        print("PASS: \(count) native agenda status and reconciliation checks")
    }
}
