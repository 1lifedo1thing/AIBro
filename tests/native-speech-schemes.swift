import Foundation
import AVFoundation
func nativeUI(_ zh:String,_ en:String)->String{en}
enum AgendaError:LocalizedError{case message(String);var errorDescription:String?{if case .message(let s)=self{return s};return nil}}
final class SchemeWriteGate:@unchecked Sendable {
    private let lock=NSLock();private var fail=false
    func set(_ value:Bool){lock.lock();fail=value;lock.unlock()}
    func before(_ file:String)throws{lock.lock();let reject=fail && file=="api.sealed";lock.unlock();if reject{throw CocoaError(.fileWriteUnknown)}}
}
actor ProbeGate {
    var count=0,continuation:CheckedContinuation<NativeSpeechService.Response,Never>?
    func send(_ request:URLRequest)async->NativeSpeechService.Response {count+=1;return await withCheckedContinuation{continuation=$0}}
    func waiting()->Bool {continuation != nil}
    func release(){continuation?.resume(returning:.init(status:200,body:Data("{\"text\":\"\"}".utf8)));continuation=nil}
}
@main struct SpeechSchemeTests {
    @MainActor static var checks=0
    @MainActor static func check(_ condition:Bool,_ label:String){precondition(condition,label);checks+=1;print("PASS \(checks): \(label)")}
    @MainActor static func wait(_ predicate:()async->Bool)async {for _ in 0..<1000{if await predicate(){return};try? await Task.sleep(for:.milliseconds(2))};preconditionFailure("bounded wait expired")}
    @MainActor static func rejects(_ label:String,_ body:()async throws->Void)async {do{try await body();preconditionFailure(label)}catch{check(true,label)}}
    @MainActor static func main()async throws {
        setbuf(stdout,nil)
        let root=URL(fileURLWithPath:CommandLine.arguments[1]),directory=root.appendingPathComponent("Speech"),service="dev.aibro.qa.speech-schemes."+UUID().uuidString
        var a=NativeSpeechConfiguration();a.provider = .openAI;a.baseURL="https://speech.invalid/v1";a.model="synthetic-asr-a"
        let legacy=NativeCredentials(folder:directory,legacy:nil,service:service)
        _ = try legacy.call("api","save",["base":a.endpoint!.absoluteString,"model":String(decoding:JSONEncoder().encode(a),as:UTF8.self),"token":"SYNTHETIC-A"])
        let gate=SchemeWriteGate(),access=NativeSpeechCredentialAdapter.access(directory:directory,service:service,beforeCommit:{try gate.before($0)})
        let schemes=access.schemes!,initial=try await schemes.list()
        check(initial.selectedID=="default" && initial.schemes.count==1 && initial.schemes[0].configuration==a,"legacy single speech configuration is listed as the default scheme")
        let metadata=try legacy.call("api","profile-list",[:])
        check(!String(describing:metadata).contains("SYNTHETIC-A"),"public scheme metadata contains no secret")
        let settings=NativeSpeechSettings();settings.configure(owner:root,access:access);settings.setAvailable(true);await wait{!settings.busy}
        check(settings.selectedID=="default" && settings.configuration==a && settings.configured,"shared speech settings load the legacy active scheme")
        check(try await settings.connection().1=="SYNTHETIC-A","existing recording/composer/quick-voice connection API resolves the active scheme")
        var b=a;b.model="synthetic-asr-b"
        check(!(await settings.saveScheme(id:"second",name:"Second",configuration:b,key:"")),"a new scheme cannot borrow another scheme's Key even at the same endpoint")
        check(await settings.saveScheme(id:"second",name:"Second",configuration:b,key:"SYNTHETIC-B"),"save creates and activates an independently credentialed named scheme")
        check(settings.schemes.count==2 && settings.selectedID=="second" && settings.configuration==b,"both schemes survive creation and active metadata is coherent")
        check(try await settings.connection().1=="SYNTHETIC-B","active second scheme uses only its own Key")
        var changed=b;changed.language="en"
        check(await settings.saveScheme(id:"second",name:"Renamed",configuration:changed,key:""),"empty Key retains the same scheme at the same endpoint")
        check(try await settings.connection().1=="SYNTHETIC-B" && settings.schemes.first(where:{$0.id=="second"})?.name=="Renamed","rename and model metadata do not exchange credentials")
        var moved=changed;moved.baseURL="https://speech.invalid/other"
        let sealed=directory.appendingPathComponent("v2/api.sealed"),beforeMove=try Data(contentsOf:sealed)
        check(!(await settings.saveScheme(id:"second",name:"Moved",configuration:moved,key:"")),"endpoint changes on the same origin require a newly supplied Key")
        check(try Data(contentsOf:sealed)==beforeMove && settings.configuration==changed,"failed endpoint edit preserves ciphertext and active configuration")
        check(await settings.selectScheme("default"),"explicit switching restores an existing saved scheme")
        check(try await settings.connection().1=="SYNTHETIC-A" && settings.configuration==a,"switching back restores its matching Key and configuration")
        let exported=try legacy.exportSavedSpeech([:]),profile=exported["profile"] as! [String:Any]
        check(profile["model"] as? String==a.model && profile["apiKey"] as? String=="SYNTHETIC-A","connection sharing exports only the currently active saved speech scheme")
        let restarted=NativeSpeechSettings();restarted.configure(owner:root,access:NativeSpeechCredentialAdapter.access(directory:directory,service:service));restarted.setAvailable(true);await wait{!restarted.busy}
        check(restarted.schemes==settings.schemes && restarted.selectedID==settings.selectedID,"scheme catalog and selection survive a fresh worker/settings instance")
        let oldRevision=settings.catalogRevision
        _ = try await schemes.save("external","External",a,"SYNTHETIC-EXTERNAL",oldRevision)
        let externallySaved=try Data(contentsOf:sealed)
        check(!(await settings.selectScheme("second")),"stale catalog cannot overwrite another writer's selected scheme")
        check(try Data(contentsOf:sealed)==externallySaved,"CAS rejection preserves the other writer's exact saved state")
        await rejects("stale consumer cannot read a replacement active credential"){_ = try await settings.connection()}
        settings.setAvailable(false);settings.setAvailable(true);await wait{!settings.busy}
        check(settings.selectedID=="external","explicit reload recovers the current selection after stale-write rejection")
        check(!(await settings.saveScheme(id:"default",name:"Old draft",configuration:a,key:"SYNTHETIC-A",expectedRevision:oldRevision)),"an unsaved draft retains its old baseline after a reload instead of silently rebasing")
        check(!(await settings.testConnection(schemeID:"default",configuration:a,key:"SYNTHETIC-A",expectedRevision:oldRevision,transport:{_ in preconditionFailure("must not send")})),"stale draft cannot dispatch a connection test after a reload")
        gate.set(true);let beforeFailure=try Data(contentsOf:sealed)
        check(!(await settings.saveScheme(id:"failure",name:"Failure",configuration:b,key:"SYNTHETIC-FAILURE")),"atomic credential write failure is reported")
        check(try Data(contentsOf:sealed)==beforeFailure && settings.selectedID=="external","write failure preserves prior catalog and active Key")
        gate.set(false)
        check(await settings.removeScheme("external") && !settings.configured && settings.selectedID==nil && settings.schemes.count==2,"deleting active scheme disables speech without silently selecting another")
        await rejects("no active scheme cannot supply a connection"){_ = try await settings.connection()}
        await rejects("no active scheme cannot export an old shared credential"){_ = try legacy.exportSavedSpeech([:])}
        check(await settings.selectScheme("second"),"retained scheme can be selected explicitly after deletion")
        let beforeTest=try Data(contentsOf:sealed),beforeRevision=settings.catalogRevision
        let pass=await settings.testConnection(schemeID:"second",configuration:changed,key:"",transport:{request in
            precondition(request.url?.absoluteString==changed.endpoint?.absoluteString)
            precondition(request.value(forHTTPHeaderField:"Authorization")=="Bearer SYNTHETIC-B")
            precondition(request.timeoutInterval==30 && request.httpBody!.contains(NativeSpeechService.connectionTestAudio()))
            return .init(status:200,body:Data("{\"text\":\"\"}".utf8))
        })
        check(pass && settings.testResult != nil,"test uses the selected scheme Key and a valid synthetic-silence transcription response")
        check(try Data(contentsOf:sealed)==beforeTest && settings.catalogRevision==beforeRevision,"connection test does not save or activate draft settings")
        let audio=NativeSpeechService.connectionTestAudio()
        check(audio.count==32044 && audio.suffix(32000).allSatisfy{$0==0},"test audio is exactly one second of generated PCM silence; no microphone or library file")
        check(!(await settings.testConnection(schemeID:"new",configuration:changed,key:"",transport:{_ in preconditionFailure("must not send")})),"blank Key cannot test another scheme by falling back to active credentials")
        check(!(await settings.testConnection(schemeID:"second",configuration:moved,key:"",transport:{_ in preconditionFailure("must not send")})),"blank Key cannot test a changed endpoint")
        check(!(await settings.testConnection(schemeID:"second",configuration:changed,key:"",transport:{_ in .init(status:200,body:Data("<html>login</html>".utf8))})),"generic successful HTTP status is not claimed as a compatible speech API")
        check(!(await settings.testConnection(schemeID:"second",configuration:changed,key:"",transport:{_ in .init(status:401,body:Data("SYNTHETIC-SECRET private body".utf8))})) && !(settings.error ?? "").contains("SYNTHETIC"),"HTTP failure is safe and never displays secret or remote response text")
        var ali=NativeSpeechConfiguration();ali.baseURL="https://ali.invalid/compatible-mode/v1"
        try await NativeSpeechService.testConnection(configuration:ali,key:"SYNTHETIC-ALI",transport:{request in
            let body=try JSONSerialization.jsonObject(with:request.httpBody!) as! [String:Any]
            precondition(body["model"] as? String==ali.model && request.value(forHTTPHeaderField:"X-DashScope-SSE")=="disable")
            return .init(status:200,body:Data("{\"output\":{\"text\":\"\"}}".utf8))
        });check(true,"Alibaba probe uses the existing official non-streaming audio contract")
        await rejects("provider-shaped text response is required"){try await NativeSpeechService.testConnection(configuration:ali,key:"SYNTHETIC",transport:{_ in .init(status:200,body:Data("{\"text\":\"\"}".utf8))})}
        let pending=ProbeGate(),late=Task{await settings.testConnection(schemeID:"second",configuration:changed,key:"",transport:{await pending.send($0)})}
        await wait{await pending.waiting()};settings.clearTestResult();await pending.release()
        check(!(await late.value) && settings.testResult==nil && !settings.busy,"cancel rejects a late test response without republishing success")
        check(try Data(contentsOf:sealed)==beforeTest,"test success, rejection and cancellation all preserve the exact saved catalog")
        print("PASS: \(checks) speech scheme checks; temporary encrypted store and synthetic transport only")
    }
}
