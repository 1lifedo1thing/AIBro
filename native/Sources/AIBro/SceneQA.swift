import Foundation
import AppKit
import WebKit

/// One visual QA step: where to go, which appearance, and optional page script.
struct NativeQAScene:Decodable {
    let name:String
    let selection:String?
    let action:String?
    let appearance:String?
    let js:String?
    let width:Double?
    let height:Double?
    let settle:Double?
    /// Seconds of screen video to record while `js` runs (motion review).
    let record:Double?
}

extension Workspace {
    /// Visual QA only. Steps the synthetic workspace through scenes listed in a
    /// JSON file. After each scene it publishes the window number and waits for
    /// an external capture: the QA shell owns Screen Recording permission, this
    /// isolated bundle does not. The window image includes AppKit glass.
    func sceneQA(_ destination:String) async throws {
        guard let file=ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_SCENES"],
              Bundle.main.bundleIdentifier?.contains("qa") == true else {throw CocoaError(.featureUnsupported)}
        let scenes=try JSONDecoder().decode([NativeQAScene].self,from:Data(contentsOf:URL(fileURLWithPath:file)))
        guard let window=web.window else {throw CocoaError(.validationMissingMandatoryProperty)}
        var report:[[String:String]]=[]
        for scene in scenes {
            if let width=scene.width,let height=scene.height {window.setContentSize(NSSize(width:width,height:height))}
            if let appearance=scene.appearance {setAppearance(appearance)}
            // A recorded scene navigates only after the recording has started,
            // so the video shows the transition rather than its end state.
            let recorded=scene.record != nil
            if !recorded {
                if let target=scene.selection {selection=target}
                if scene.action == "settings" {openWorkspaceSettings()}
            }
            try await Task.sleep(nanoseconds:700_000_000)
            // Motion review: ask the capture shell to start recording this
            // window, wait until it has started, then trigger the animation.
            if let seconds=scene.record {
                let started=destination+"-rec-ack-"+scene.name
                try "\(scene.name) \(window.windowNumber) \(seconds)".write(toFile:destination+"-record.txt",atomically:true,encoding:.utf8)
                for _ in 0..<100 {if FileManager.default.fileExists(atPath:started){break};try await Task.sleep(nanoseconds:100_000_000)}
                if let target=scene.selection {selection=target}
                if scene.action == "settings" {openWorkspaceSettings()}
            }
            var result="null"
            if let script=scene.js {
                do {result=String(describing:try await web.callAsyncJavaScript(script,arguments:[:],in:nil,contentWorld:.page) ?? "null")}
                catch {result="error: \(error.localizedDescription)"}
            }
            try await Task.sleep(nanoseconds:UInt64((max(scene.settle ?? 0.8,scene.record ?? 0))*1_000_000_000))
            let ack=destination+"-ack-"+scene.name
            try "\(scene.name) \(window.windowNumber)".write(toFile:destination+"-scene.txt",atomically:true,encoding:.utf8)
            for _ in 0..<600 {if FileManager.default.fileExists(atPath:ack){break};try await Task.sleep(nanoseconds:100_000_000)}
            report.append(["name":scene.name,"result":result,"captured":FileManager.default.fileExists(atPath:ack) ? "yes":"no"])
        }
        let bytes=try JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys])
        try bytes.write(to:URL(fileURLWithPath:destination+"-scenes.json"),options:.atomic)
        try "PASS".write(toFile:destination,atomically:true,encoding:.utf8)
        if ProcessInfo.processInfo.environment["AIBRO_NATIVE_QA_HOLD"] != "1" {NSApp.terminate(nil)}
    }
}
