import Foundation
import WebKit

extension Workspace {
    func requestAgendaSync() {
        guard ready,!agendaSyncRunning else{return}
        agendaSyncRunning=true
        Task { @MainActor in
            defer {agendaSyncRunning=false}
            var phase=AgendaSyncPhase.read
            do {
                let raw = try await web.callAsyncJavaScript("return await window.NativeAgendaSync.read()",arguments:[:],in:nil,contentWorld:.page)
                let notes = try AgendaSyncBridgeResponse.decode(raw,phase:phase).notes!
                let plan=AgendaWire.plan(events:agenda.events,receipts:agenda.syncReceipts,notes:notes)
                agendaSyncConflicts=plan.conflicts
                let writes=plan.changes.filter{$0.writeNote != nil}
                var acknowledged=Set<String>()
                if !writes.isEmpty {
                    phase = .write
                    let batch:[[String:Any]]=writes.map{["id":$0.noteID,"expected":$0.expectedNote as Any? ?? NSNull(),"note":$0.writeNote!]}
                    let raw = try await web.callAsyncJavaScript("return await window.NativeAgendaSync.write(changes)",arguments:["changes":batch],in:nil,contentWorld:.page)
                    let accepted = try AgendaSyncBridgeResponse.decode(raw,phase:phase).accepted!
                    guard Set(accepted).isSubset(of:Set(writes.map(\.noteID))) else {throw AgendaSyncBridgeIssue.invalid(phase)}
                    acknowledged=Set(accepted)
                }
                // Pulls refer to the exact read snapshot. If notes changed during a write,
                // do not acknowledge the old snapshot; the next pass will read it again.
                phase = .verify
                let verifiedRaw=try await web.callAsyncJavaScript("return await window.NativeAgendaSync.read()",arguments:[:],in:nil,contentWorld:.page)
                let verified=try AgendaSyncBridgeResponse.decode(verifiedRaw,phase:phase).notes!
                let accepted=try plan.changes.filter{change in
                    if change.writeNote != nil{return acknowledged.contains(change.noteID)}
                    return try AgendaWire.stamp(verified[change.noteID]) == change.expectedNote
                }
                phase = .acknowledge
                if !accepted.isEmpty {try agenda.acknowledgeSync(accepted)}
                agendaSyncStatus = !plan.warnings.isEmpty ? plan.warnings.joined(separator:"；") : !plan.conflicts.isEmpty ? "有 \(plan.conflicts.count) 条日程需要选择保留版本" : accepted.count < plan.changes.count ? "日程内容已更新，正在重新核对" : "日程已与本机工作区对齐"
            } catch {agendaSyncStatus=AgendaSyncBridgeIssue.native(error,phase:phase).message}
        }
    }
    func resolveAgendaSync(_ conflict:AgendaSyncConflict,useRemote:Bool) {
        do{try agenda.resolveSync(conflict,useRemote:useRemote);agendaSyncConflicts.removeAll{$0.id==conflict.id};requestAgendaSync()}
        catch{agendaSyncStatus=error.localizedDescription}
    }
}
