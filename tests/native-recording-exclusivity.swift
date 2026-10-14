import AppKit
import AVFoundation
import Foundation

func nativeUI(_ zh:String,_ en:String)->String { en }
struct RecordingCheckFailure:Error { let message:String }
func check(_ value:@autoclosure () throws->Bool,_ message:String) throws {
    guard try value() else { throw RecordingCheckFailure(message:message) }
    print("PASS " + message)
}

@main struct RecordingExclusivityChecks {
    @MainActor static func main() async throws {
        let mode=CommandLine.arguments[1],root=URL(fileURLWithPath:CommandLine.arguments[2])
        let folder=root.appendingPathComponent("quick-recordings"),id=UUID().uuidString.lowercased()
        let item=NativeQuickRecordingItem(id:id,title:"Synthetic recording exclusivity check",createdAt:Date(timeIntervalSince1970:1900000000),duration:1,transcript:"Original synthetic words",state:"ready")
        var archive=try NativeQuickRecordingArchive(directory:folder);try archive.replace([item])
        var onWrite:(()->Void)?,failWrite=false
        let store=NativeQuickRecordingStore(write:{data,url in
            try NativeQuickRecordingArchive.durableWrite(data,url)
            onWrite?()
            if failWrite { throw CocoaError(.fileWriteOutOfSpace) }
        })
        store.configure(directory:root);store.setVisible(true)

        // Exercise the actual AAC file pipeline with generated PCM, not a device.
        // No AVAudioEngine or permission API is constructed/called by this setup.
        let audioURL=folder.appendingPathComponent("recording-\(id).m4a")
        let format=AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!
        let pipeline=try NativeQuickRealtimeASRAudioPipeline(url:audioURL,inputFormat:format,onPCM:{_ in},onFailure:{})
        let pcm=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:4800)!;pcm.frameLength=4800
        for index in 0..<4800 {pcm.floatChannelData![0][index]=Float(sin(Double(index)*2*Double.pi*440/48000)*0.1)}
        pipeline.enqueue(pcm)
        let audioReceipt=await pipeline.finish()
        try check(audioReceipt.bytes>0 && !audioReceipt.interrupted,"generated PCM produced a closed nonempty synthetic M4A")
        let originalAudio=try Data(contentsOf:audioURL),originalManifest=try Data(contentsOf:folder.appendingPathComponent("index.json"))
        let audio=NativeQuickRealtimeASRAudio();audio.qaAttachSyntheticPipeline(pipeline)
        let session=NativeQuickRealtimeASRSession(factory:{_ in fatalError("The synthetic stop check must never create a network socket")})
        let final=NativeQuickASRSnapshot(phase:.completed,finalized:"Complete synthetic transcript",text:"Complete synthetic transcript")
        session.qaSetReceivedSnapshot(final)
        store.qaBindSyntheticRealtime(id:id,audio:audio,session:session)

        if mode.hasPrefix("partial") {
            store.qaInstallProductionRealtimeHandler()
            if mode=="partial-revoke" {onWrite={store.setAvailable(false)}}
            session.onChange?(final)
            let saved=try NativeQuickRecordingArchive(directory:folder)
            if mode=="partial-revoke" {
                try check(try Data(contentsOf:folder.appendingPathComponent("index.json"))==originalManifest,"late privacy revocation rejects the staged partial transcript")
                try check(store.transcriptDrafts[id]==final.text,"rejected partial text remains recoverable")
            } else {
                try check(saved.items.first?.transcript==final.text && saved.items.first?.transcriptionState=="partial","production onChange persists finalized provider text as partial")
                try check(store.items.first?.transcript==final.text,"partial commit publishes the same archive value")
            }
        } else {
            if mode=="stop-revoke" {onWrite={store.qaInvalidateRealtimeToken()}}
            if mode=="stop-write-failure" {failWrite=true}
            store.stop()
            for _ in 0..<1500 {if store.phase == .idle {break};try await Task.sleep(for:.milliseconds(2))}
            try check(store.phase == .idle,"real stopRealtime task completes without a device or GUI")
            let saved=try NativeQuickRecordingArchive(directory:folder)
            if mode=="stop-revoke" || mode=="stop-write-failure" {
                try check(try Data(contentsOf:folder.appendingPathComponent("index.json"))==originalManifest,"failed final commit retains the exact previous manifest")
                try check(store.transcriptDrafts[id]==final.text && store.error != nil,"uncommitted final text is retained as a retryable draft")
            } else {
                try check(saved.items.first?.state=="ready" && saved.items.first?.transcriptionState=="realtime","production stop persists final recording state")
                try check(saved.items.first?.transcript==final.text && saved.items.first?.duration==audioReceipt.duration,"exact final transcript and actual audio duration survive archive reopen")
                try check(store.items==saved.items && store.transcriptDrafts[id]==nil,"published store matches the committed final archive")
            }
        }
        try check(try Data(contentsOf:audioURL)==originalAudio,"metadata finalization preserves every original audio byte")
        try check(try FileManager.default.contentsOfDirectory(atPath:folder.path).allSatisfy{!$0.hasPrefix(".recording-index-")},"failed and successful commits leave no staging manifest")
        try check(NSApp==nil,"no App, microphone, real credentials or external service was opened")
        print("COMPLETED " + mode)
    }
}
