import Foundation
import AppKit
import WebKit

extension Workspace {
    @MainActor func browserQA(_ destination:String) async throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-browser-fixture-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:directory)}
        let html="""
        <!doctype html><meta charset="utf-8"><title>AI Bro 浏览器验收</title>
        <style>body{font:20px system-ui;padding:32px;background:#f8faf9;color:#183c30}button,input{font:inherit;margin:10px;padding:12px}#result{background:#d9eee4;padding:20px}a{display:block;margin-top:24px}</style>
        <h1>真实网页操作</h1><label for="name">研究名称</label><input id="name" placeholder="输入研究名称"><button id="add">增加计数</button>
        <p id="result">计数：0</p><p id="typed">尚未输入</p><a href="/next.html">下一页</a>
        <script>let count=0;document.querySelector('#add').onclick=()=>document.querySelector('#result').textContent='计数：'+(++count);document.querySelector('#name').oninput=e=>document.querySelector('#typed').textContent='已填写：'+e.target.value;</script>
        """
        try html.write(to:directory.appendingPathComponent("index.html"),atomically:true,encoding:.utf8)
        try "<!doctype html><meta charset=\"utf-8\"><title>第二页</title><h1>第二页已到达</h1>".write(to:directory.appendingPathComponent("next.html"),atomically:true,encoding:.utf8)
        let server=Process(),pipe=Pipe();server.executableURL=URL(fileURLWithPath:"/usr/bin/python3")
        server.arguments=["-u","-c","import http.server,os,sys;os.chdir(sys.argv[1]);s=http.server.HTTPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler);print(s.server_port,flush=True);s.serve_forever()",directory.path]
        server.standardOutput=pipe;server.standardError=FileHandle.nullDevice;try server.run();defer {if server.isRunning {server.terminate()}}
        let bytes=await Task.detached{pipe.fileHandleForReading.availableData}.value
        guard let port=Int(String(decoding:bytes,as:UTF8.self).trimmingCharacters(in:.whitespacesAndNewlines)) else {throw BrowserFailure(code:"QA_SERVER",message:"测试网页服务没有启动")}
        let base="http://127.0.0.1:\(port)/",owner:[String:Any] = ["runId":"browser-qa-run","conversationId":"native-qa","projectId":"native-qa","browserPermission":"ask"]
        selection="agent";command("view","agent")
        var checks:[String]=[]
        func ensure(_ value:Bool,_ message:String) throws {guard value else{throw BrowserFailure(code:"QA_FAILED",message:message)};checks.append(message);try checks.joined(separator:"\n").write(toFile:destination+"-steps.txt",atomically:true,encoding:.utf8)}
        func until(_ predicate:()->Bool) async throws {for _ in 0..<160 {if predicate(){return};try await Task.sleep(nanoseconds:50_000_000)};throw BrowserFailure(code:"QA_TIMEOUT",message:"等待浏览器状态超时，最近检查："+(checks.last ?? "尚未执行")+"；标签状态："+self.browser.tabs.map{$0.runID+"="+$0.status}.joined(separator:","))}
        func call(_ values:[String:Any]) async throws -> [String:Any] {
            let value=try await web.callAsyncJavaScript("return await window.workstationDesktop.browser.request(request)",arguments:["request":values],in:nil,contentWorld:.page) as? [String:Any] ?? [:]
            if let error=value["error"] as? String {throw BrowserFailure(code:value["code"] as? String ?? "QA_BRIDGE",message:error)}
            return value
        }
        func permitted(_ values:[String:Any]) async throws -> [String:Any] {
            let task=Task {try await call(values)}
            try await until{self.browser.tabs.last?.pendingTitle.isEmpty == false}
            self.browser.tabs.last?.decide(true)
            return try await task.value
        }
        var open=owner;open["action"]="open";open["url"]=base
        let first=try await permitted(open)
        guard let tab=browser.tabs.last else{throw BrowserFailure(code:"QA_TAB",message:"没有浏览器标签")}
        let identity:[String:Any]=owner.merging(["sessionId":tab.sessionID,"tabId":tab.id]){_,new in new}
        func request(_ action:String,_ fields:[String:Any]=[:])->[String:Any] {identity.merging(["action":action]){_,new in new}.merging(fields){_,new in new}}
        try ensure(first["status"] as? String == "ready","open waits for approval and real navigation")
        try ensure(tab.web !== web && tab.web.configuration.userContentController.userScripts.count == 1,"owned browser has only its fixed DOM adapter")
        let bridgePresent=try await tab.web.evaluateJavaScript("typeof window.workstationDesktop !== 'undefined' || typeof window.webkit?.messageHandlers?.desktop !== 'undefined'") as? Bool ?? true
        try ensure(!bridgePresent,"remote page has no workspace/credentials bridge")
        try await until{tab.web.window != nil && tab.web.bounds.width > 100}
        let snap=try await call(request("snapshot"))
        let elements=snap["elements"] as? [[String:Any]] ?? []
        guard let input=elements.first(where:{$0["name"] as? String == "研究名称"})?["ref"] as? String else{throw BrowserFailure(code:"QA_REF",message:"快照缺少真实输入框")}
        _ = try await permitted(request("type",["snapshotId":snap["snapshotId"] ?? "","ref":input,"text":"多模态研究","browserPermission":"auto"]));let typed=try await call(request("snapshot"))
        try ensure((typed["text"] as? String ?? "").contains("已填写：多模态研究"),"type changes live page through input event")
        try ensure(tab.asksPermission,"request-approval policy cannot be overridden by an action")
        guard let button=(typed["elements"] as? [[String:Any]])?.first(where:{$0["name"] as? String == "增加计数"})?["ref"] as? String else{throw BrowserFailure(code:"QA_REF",message:"快照缺少真实按钮")}
        let click=request("click",["snapshotId":typed["snapshotId"] ?? "","ref":button])
        _ = try await permitted(click)
        do {_ = try await call(click);throw BrowserFailure(code:"QA_FAILED",message:"旧快照点击未被拦截") } catch let failure as BrowserFailure {try ensure(failure.code == "STALE_SNAPSHOT","consumed snapshot cannot repeat a side effect")}
        let shot=try await call(request("snapshot",["screenshot":true]))
        try ensure((shot["text"] as? String ?? "").contains("计数：1"),"click changed live DOM exactly once")
        guard let image=shot["imageDataUrl"] as? String,let data=Data(base64Encoded:String(image.split(separator:",",maxSplits:1).last ?? "")),let bitmap=NSBitmapImageRep(data:data) else{throw BrowserFailure(code:"QA_SCREENSHOT",message:"没有真实截图")}
        try ensure(bitmap.pixelsWide>100 && bitmap.pixelsHigh>100 && data.count>2000,"actual WKWebView screenshot contains rendered pixels")
        try data.write(to:URL(fileURLWithPath:destination+"-browser.jpg"))
        do {_ = try await call(request("snapshot").merging(["runId":"different-run"]){_,new in new});throw BrowserFailure(code:"QA_FAILED",message:"跨任务读取未被拒绝")}catch let failure as BrowserFailure{try ensure(failure.code == "WRONG_OWNER","cross-task access rejected")}
        let deniedTask=Task{try await call(request("navigate",["url":"http://localhost:\(port)/next.html"]))}
        try await until{!tab.pendingTitle.isEmpty};tab.decide(false)
        do {_ = try await deniedTask.value;throw BrowserFailure(code:"QA_FAILED",message:"新站点未审批就被打开")}catch let failure as BrowserFailure{try ensure(failure.code == "DENIED","new origin requires navigation approval")}
        let takeover=Task{try await call(request("takeover",["waitForResume":true]))}
        try await until{tab.paused}
        do {_ = try await call(request("snapshot"));throw BrowserFailure(code:"QA_FAILED",message:"接管中仍允许AI读取")}catch let failure as BrowserFailure{try ensure(failure.code == "HUMAN_TAKEOVER","human takeover blocks automated operations")}
        _ = try await tab.web.evaluateJavaScript("document.querySelector('#typed').textContent='人工完成'")
        tab.resume();_ = try await takeover.value
        let resumed=try await call(request("snapshot"))
        try ensure((resumed["text"] as? String ?? "").contains("人工完成"),"resume returns original task to changed page")
        let cancelled=Task{try await call(request("takeover",["waitForResume":true]))}
        try await until{tab.paused};tab.stop()
        do {_ = try await cancelled.value;throw BrowserFailure(code:"QA_FAILED",message:"停止未结束等待") }catch let failure as BrowserFailure {try ensure(failure.code == "CANCELLED","stop resolves pending handoff with cancellation")}
        var second=owner;second["runId"]="browser-cancel-open";second["action"]="open";second["url"]=base
        let pending=Task{try await call(second)};try await until{self.browser.tabs.last?.runID == "browser-cancel-open" && self.browser.tabs.last?.pendingTitle.isEmpty == false}
        var cancel=second;cancel["action"]="cancel";_ = try await call(cancel)
        do {_ = try await pending.value;throw BrowserFailure(code:"QA_FAILED",message:"初次打开仍在等待") }catch let failure as BrowserFailure {try ensure(failure.code == "CANCELLED","initial navigation cancels without session IDs")}
        if let origin {
            let blocked=try await tab.web.callAsyncJavaScript("return await fetch(target, {mode:'no-cors'}).then(()=>false,()=>true)",arguments:["target":origin.absoluteString+"api/state"],in:nil,contentWorld:.page) as? Bool ?? false
            try ensure(blocked,"remote page subresources cannot reach workspace service")
        }
        // A default run must finish navigation, input, click and a cross-origin
        // link without a driver ever accepting an approval on its behalf.
        var autoOwner=owner;autoOwner["runId"]="browser-auto-run";autoOwner.removeValue(forKey:"browserPermission")
        func autonomous(_ values:[String:Any]) async throws -> [String:Any] {
            var finished=false
            let task=Task {defer{finished=true};return try await call(values)}
            try await until{finished || self.browser.tabs.contains{$0.runID == "browser-auto-run" && !$0.pendingTitle.isEmpty}}
            if let waiting=self.browser.tabs.first(where:{$0.runID == "browser-auto-run" && !$0.pendingTitle.isEmpty}) {waiting.stop();_ = try? await task.value;throw BrowserFailure(code:"QA_AUTOMATION_PROMPT",message:"自动浏览意外请求审批")}
            return try await task.value
        }
        _ = try await autonomous(autoOwner.merging(["action":"open","url":base]){_,new in new})
        guard let autoTab=browser.tabs.last,autoTab.runID == "browser-auto-run" else{throw BrowserFailure(code:"QA_TAB",message:"自动浏览标签缺失")}
        let autoIdentity=autoOwner.merging(["sessionId":autoTab.sessionID,"tabId":autoTab.id]){_,new in new}
        func autoRequest(_ action:String,_ fields:[String:Any]=[:])->[String:Any] {autoIdentity.merging(["action":action]){_,new in new}.merging(fields){_,new in new}}
        try ensure(!autoTab.asksPermission && autoTab.pendingTitle.isEmpty,"default host policy opens without an approval prompt")
        let autoSnap=try await autonomous(autoRequest("snapshot")),autoElements=autoSnap["elements"] as? [[String:Any]] ?? []
        guard let autoInput=autoElements.first(where:{$0["name"] as? String == "研究名称"})?["ref"] as? String else{throw BrowserFailure(code:"QA_REF",message:"自动输入引用缺失")}
        _ = try await autonomous(autoRequest("type",["snapshotId":autoSnap["snapshotId"] ?? "","ref":autoInput,"text":"无需逐次批准"]))
        let autoTyped=try await autonomous(autoRequest("snapshot"))
        guard let autoButton=(autoTyped["elements"] as? [[String:Any]])?.first(where:{$0["name"] as? String == "增加计数"})?["ref"] as? String else{throw BrowserFailure(code:"QA_REF",message:"自动点击引用缺失")}
        _ = try await autonomous(autoRequest("click",["snapshotId":autoTyped["snapshotId"] ?? "","ref":autoButton,"browserPermission":"ask"]))
        let autoClicked=try await autonomous(autoRequest("snapshot"))
        try ensure((autoClicked["text"] as? String ?? "").contains("计数：1") && (autoClicked["text"] as? String ?? "").contains("无需逐次批准") && !autoTab.asksPermission,"automatic type and click change the real page; per-action policy cannot replace task policy")
        // Test a page-originated cross-origin navigation, not just host navigate.
        _ = try await autoTab.web.evaluateJavaScript("document.querySelector('a').href='http://localhost:\(port)/next.html'")
        let autoLinked=try await autonomous(autoRequest("snapshot"))
        guard let autoLink=(autoLinked["elements"] as? [[String:Any]])?.first(where:{$0["name"] as? String == "下一页"})?["ref"] as? String else{throw BrowserFailure(code:"QA_REF",message:"自动跳转引用缺失")}
        _ = try await autonomous(autoRequest("click",["snapshotId":autoLinked["snapshotId"] ?? "","ref":autoLink]))
        // A DOM click confirms dispatch; WebKit navigation starts asynchronously.
        try await until{(autoTab.web.url?.host == "localhost" && autoTab.web.title == "第二页" && autoTab.status == "ready") || !autoTab.pendingTitle.isEmpty}
        let autoNavigated=try await autonomous(autoRequest("snapshot"))
        try ensure((autoNavigated["text"] as? String ?? "").contains("第二页已到达") && autoTab.pendingTitle.isEmpty,"automatic cross-origin link navigation needs no extra approval")
        // Resize the actual native window while editing a live webpage. The
        // same WebKit document and focus must survive split/compact transitions.
        _ = try await autonomous(autoRequest("navigate",["url":base]))
        if let window=autoTab.web.window {
            let originalFrame=window.frame
            let persistentWeb=autoTab.web
            _ = try await autoTab.web.evaluateJavaScript("document.querySelector('#name').value='resize keeps draft';document.querySelector('#name').focus();window.__resizeMarker='kept'")
            window.setFrame(NSRect(x:originalFrame.minX,y:originalFrame.minY,width:1480,height:850),display:true)
            try await Task.sleep(nanoseconds:350_000_000)
            try ensure(autoTab.web.bounds.width >= 419 && web.bounds.width >= 559,"wide native layout preserves readable browser and conversation widths")
            window.setFrame(NSRect(x:originalFrame.minX,y:originalFrame.minY,width:980,height:760),display:true)
            try await Task.sleep(nanoseconds:350_000_000)
            try ensure(autoTab.web.bounds.width >= 600 && web.bounds.width < 5,"narrow native window gives the browser a full workspace panel")
            window.setFrame(NSRect(x:originalFrame.minX,y:originalFrame.minY,width:1480,height:850),display:true)
            try await Task.sleep(nanoseconds:350_000_000)
            let preserved=try await autoTab.web.evaluateJavaScript("window.__resizeMarker==='kept' && document.querySelector('#name').value==='resize keeps draft' && document.activeElement.id==='name'") as? Bool ?? false
            try ensure(autoTab.web === persistentWeb && preserved,"resizing preserves the actual browser document, draft and input focus")
            window.setFrame(originalFrame,display:true)
        }else{throw BrowserFailure(code:"QA_WINDOW",message:"浏览器未在原生窗口中显示")}
        let autoPause=Task{try await autonomous(autoRequest("takeover",["waitForResume":true]))}
        try await until{autoTab.paused}
        do {_ = try await call(autoRequest("snapshot"));throw BrowserFailure(code:"QA_FAILED",message:"自动浏览接管未阻断操作")}catch let failure as BrowserFailure{try ensure(failure.code == "HUMAN_TAKEOVER","automatic mode still respects human takeover")}
        autoTab.resume();_ = try await autoPause.value
        let autoStop=Task{try await call(autoRequest("takeover",["waitForResume":true]))};try await until{autoTab.paused};autoTab.stop()
        do {_ = try await autoStop.value;throw BrowserFailure(code:"QA_FAILED",message:"自动浏览停止未解除等待")}catch let failure as BrowserFailure{try ensure(failure.code == "CANCELLED","automatic mode stop still cancels a pending operation")}
        var loopPrompts=0
        let driver=Task { @MainActor in
            while !Task.isCancelled {
                if let current=self.browser.tabs.last,current.runID == "browser-loop-run",!current.pendingTitle.isEmpty {loopPrompts+=1;current.stop()}
                if let current=self.browser.tabs.last,current.runID == "browser-unscoped-cancel",!current.pendingTitle.isEmpty {_ = try? await self.web.evaluateJavaScript("globalThis.__browserLoopCancel?.()")}
                try? await Task.sleep(nanoseconds:50_000_000)
            }
        }
        defer{driver.cancel()}
        let loopScript=try String(contentsOf:root.appendingPathComponent("native/Resources/qa-browser-loop.js"),encoding:.utf8)
        let loop=try await web.callAsyncJavaScript(loopScript,arguments:["fixtureURL":base],in:nil,contentWorld:.page) as? [String:Any] ?? [:]
        try ensure(loopPrompts == 0,"full planner and scheduler browser loop completes with zero approval prompts")
        checks += loop["checks"] as? [String] ?? []
        try ensure((loop["turns"] as? Int)==6,"planner fixture reaches final answer after actual browser results")
        try await until{self.browser.tabs.last?.runID == "browser-unscoped-cancel" && self.browser.tabs.last?.status == "cancelled"}
        try ensure(browser.tabs.last?.pendingTitle.isEmpty == true,"unscoped cancellation clears the actual native approval")
        try checks.joined(separator:"\n").write(toFile:destination+"-browser.txt",atomically:true,encoding:.utf8)
        try "PASS".write(toFile:destination,atomically:true,encoding:.utf8)
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HOLD"] != "1" {NSApp.terminate(nil)}
    }
}
