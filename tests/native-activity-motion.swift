// Compile with production WebGlassHost.swift; isolated nonpersistent WebKit.
// This does not load the workspace server, saved state, credentials or provider.
import AppKit
import WebKit

@main @MainActor final class MotionQA:NSObject,NSApplicationDelegate,WKNavigationDelegate {
    var window:NSWindow!
    var web:WKWebView!
    var host:WebGlassHost!
    var checks:[String]=[]
    var observations:[[String:Any]]=[]
    var skipped:[String]=[]
    var running=false
    let output=URL(fileURLWithPath:(CommandLine.arguments.count>2 ? CommandLine.arguments[2]:Bundle.main.object(forInfoDictionaryKey:"QAReport") as! String))
    let root=URL(fileURLWithPath:(CommandLine.arguments.count>1 ? CommandLine.arguments[1]:Bundle.main.object(forInfoDictionaryKey:"QARepo") as! String))
    static func main(){let delegate=MotionQA();let app=NSApplication.shared;app.delegate=delegate;app.setActivationPolicy(.regular);app.run()}
    func applicationDidFinishLaunching(_ notification:Notification){
        let config=WKWebViewConfiguration();config.websiteDataStore = .nonPersistent()
        config.userContentController.addUserScript(WKUserScript(source:"window.__aibroPresentationVisible=false;",injectionTime:.atDocumentStart,forMainFrameOnly:true))
        web=WKWebView(frame:.zero,configuration:config);web.navigationDelegate=self
        host=WebGlassHost(web:web);host.setSurfaceVisible(true)
        window=NSWindow(contentRect:NSRect(x:100,y:100,width:780,height:480),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title="AI Bro · 独立动效验收";window.contentView=host;window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        do {
            let progress=try String(contentsOf:root.appendingPathComponent("app/agent-progress.js"),encoding:.utf8)
            let controller=try String(contentsOf:root.appendingPathComponent("app/activity-motion.js"),encoding:.utf8)
            let kit=try String(contentsOf:root.appendingPathComponent("app/halaska-ui.js"),encoding:.utf8)
            let css=try String(contentsOf:root.appendingPathComponent("app/activity-motion.css"),encoding:.utf8)
            let nativeCSS=try String(contentsOf:root.appendingPathComponent("native/Resources/workspace.css"),encoding:.utf8)
            let html="""
            <!doctype html><html><meta charset="utf-8"><style>\(nativeCSS)\(css)
            body{display:block!important;margin:28px!important;background:#f4faf6;color:#183b2e;font:16px system-ui}
            #surface{padding:20px;border:1px solid #abc;margin-top:20px}#elapsed{margin-left:20px}</style><body class="aibro-native"><h1>独立 WebKit 动效验收</h1><p>合成状态，不连接用户工作区或模型。</p><div id="surface"><span id="orb"></span><span id="elapsed">4 秒</span></div>
            <script>\(kit)</script><script>\(progress)</script><script>\(controller)</script>
            <script>const sync=()=>document.body.classList.toggle('native-background-render',document.hidden||window.__aibroPresentationVisible===false);sync();addEventListener('aibro:presentation-visibility',sync);document.addEventListener('visibilitychange',sync);
            const orb=HalaskaUI.mount(document.querySelector('#orb'),'Orb',{variant:'pulse',size:24});
            document.querySelector('#elapsed').dataset.progressStart=Date.now()-4500;
            window.qa=()=>({host:window.__aibroPresentationVisible,documentHidden:document.hidden,controller:ActivityMotion.inspect(),elapsed:document.querySelector('#elapsed').textContent,expected:AgentProgress.duration(Number(document.querySelector('#elapsed').dataset.progressStart)),motion:[...document.querySelectorAll('[data-halaska-orb] span')].map(n=>({name:getComputedStyle(n).animationName,state:getComputedStyle(n).animationPlayState})).filter(x=>x.name!=='none')});</script></body></html>
            """
            web.loadHTMLString(html,baseURL:nil)
        } catch {finish(error)}
        Task{try? await Task.sleep(nanoseconds:45_000_000_000);if running{finish(NSError(domain:"QA timeout",code:1))}}
    }
    func webView(_ webView:WKWebView,didCommit navigation:WKNavigation!){host.publishPresentationVisibility(force:true)}
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
        host.publishPresentationVisibility(force:true)
        guard !running else{return};running=true
        Task{do{try await verify();finish(nil)}catch{finish(error)}}
    }
    func value(_ expression:String) async throws -> Any {try await web.evaluateJavaScript(expression) ?? NSNull()}
    func ensure(_ value:Bool,_ name:String) throws {guard value else{throw NSError(domain:name,code:1)};checks.append(name)}
    func until(_ expression:String) async throws {
        for _ in 0..<100 {if (try await value(expression)) as? Bool == true{return};try await Task.sleep(nanoseconds:40_000_000)}
        try? await capture("timeout")
        observations.append(["native": ["visible":host.presentationVisible,"windowVisible":window.isVisible,"occluded": !window.occlusionState.contains(.visible),"hidden":host.isHiddenOrHasHiddenAncestor,"bounds":NSStringFromRect(host.bounds)]])
        throw NSError(domain:"Timed out: "+expression,code:1)
    }
    func capture(_ name:String) async throws {
        let state=try await value("qa()") as? [String:Any] ?? [:];observations.append(["name":name,"state":state])
    }
    func verify() async throws {
        try await until("qa().host===true && qa().controller.visibleClocks===1 && qa().motion.length>0 && qa().motion.every(x=>x.state==='running')")
        try ensure(true,"visible native window starts production Kit motion and one display clock");try await capture("visible")
        host.setSurfaceVisible(false)
        try await until("qa().host===false && !qa().controller.timerActive && qa().motion.every(x=>x.state==='paused')")
        let ticks=try await value("qa().controller.ticks") as? Int
        try await Task.sleep(nanoseconds:1_200_000_000)
        try ensure((try await value("qa().controller.ticks") as? Int)==ticks,"opacity-hidden native surface has no elapsed wakeups");try await capture("surface hidden")
        host.setSurfaceVisible(true)
        try await until("qa().host===true && qa().controller.visibleClocks===1 && qa().elapsed===qa().expected")
        try ensure(true,"reopening retained native surface catches up wall time")
        // A non-key window is still visible; focus alone must not suspend it.
        let small=NSWindow(contentRect:NSRect(x:920,y:100,width:180,height:140),styleMask:[.titled],backing:.buffered,defer:false)
        small.title="独立焦点检查";small.makeKeyAndOrderFront(nil);try await Task.sleep(nanoseconds:200_000_000)
        try ensure(!window.isKeyWindow && host.presentationVisible,"visible non-key workspace keeps its presentation active")
        small.orderOut(nil);window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        window.performMiniaturize(nil)
        try await Task.sleep(nanoseconds:300_000_000)
        if window.isMiniaturized {
            try await until("qa().host===false && !qa().controller.timerActive")
            try ensure(true,"minimizing actual NSWindow pauses controller");try await capture("minimized")
            window.deminiaturize(nil);window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
            try await until("qa().host===true && qa().controller.timerActive")
            try ensure(true,"restoring actual NSWindow resumes controller")
        } else {
            skipped.append("NSWindow.miniaturize was a no-op in this isolated executable; actual miniaturization has not been runtime verified")
        }
        window.orderOut(nil)
        try await until("qa().host===false && !qa().controller.timerActive")
        try ensure(true,"ordering native window out pauses presentation")
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
        try await Task.sleep(nanoseconds:300_000_000)
        if host.presentationVisible {
            try await until("qa().host===true && qa().controller.timerActive")
            try ensure(true,"revealing actual NSWindow resumes presentation")
        } else {
            skipped.append("After orderFront the test window remained occluded; actual window reveal is not verified in this fixture")
            try await until("qa().host===false && !qa().controller.timerActive")
        }
        host.setSurfaceVisible(false)
        try await until("!qa().controller.timerActive")
        _=try await value("orb.unmount();document.querySelector('#elapsed').removeAttribute('data-progress-start');document.querySelector('#elapsed').textContent='已完成'")
        host.setSurfaceVisible(true)
        try await until("qa().controller.tracked===0")
        try ensure(try await value("!qa().controller.timerActive && qa().elapsed==='已完成'") as? Bool == true,"terminal state received while hidden removes all live indicators and clock subscriptions")
        try await capture("completed")
    }
    func finish(_ error:Error?){
        let report:[String:Any]=["checks":checks,"skipped":skipped,"passed":checks.count,"observations":observations,"error":error?.localizedDescription ?? NSNull(),"userWorkspaceLoaded":false,"modelCalls":0,"fixture":"Production WebGlassHost, ActivityMotion and Halaska Orb in isolated nonpersistent WKWebView"]
        if let data=try? JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:output)}
        window?.orderOut(nil);exit(error == nil ? 0:1)
    }
}
