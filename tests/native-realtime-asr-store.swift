import Foundation
func nativeUI(_ zh:String,_ en:String)->String {en}
@main struct ASRStoreChecks {
 @MainActor static func main() throws {
    var count=0
    func check(_ condition:Bool,_ message:String) throws {guard condition else{throw NSError(domain:message,code:1)};count+=1;print("PASS \(message)")}
    let root=URL(fileURLWithPath:CommandLine.arguments[1]),fm=FileManager.default
    try fm.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    let workspace=root.appendingPathComponent("workspace"),folder=workspace.appendingPathComponent("quick-recordings")
    var archive=try NativeQuickRecordingArchive(directory:folder)
    let id=UUID().uuidString.lowercased(),original=Data("synthetic retained audio bytes".utf8)
    let item=NativeQuickRecordingItem(id:id,title:"Synthetic class",createdAt:Date(),duration:12,transcript:"Interrupted cloud transcript",state:"ready",transcriptionState:"partial")
    try archive.replace([item]);let audio=try archive.audioURL(for:id,mustExist:false);try original.write(to:audio)
    let store=NativeQuickRecordingStore();store.configure(directory:workspace)
    let credentials=root.appendingPathComponent("asr-credentials")
    let access=NativeQuickASRCredentialAdapter.access(directory:credentials,service:"dev.aibro.synthetic.asr")
    store.configureRealtime(owner:workspace,access:access)
    try check(!store.realtimeSettings.configured && !store.realtimeSettings.configuration.enabled,"new credential adapter loads disabled without recording or contacting a service")
    store.beginRealtimeSettings();var draft=store.realtimeSettingsDraft!;draft.configuration.enabled=true;draft.key="synthetic-asr-key-not-real";store.updateRealtimeSettings(draft)
    try check(store.hasEditor && !store.flushForQuit(),"configuration draft joins real store navigation and quit guards")
    store.setAvailable(false)
    try check(store.items.isEmpty && !store.saveRealtimeSettings() && store.realtimeSettingsDraft?.key==draft.key,"privacy hides recordings and retains unsaved settings without writing them")
    try check(!fm.fileExists(atPath:credentials.path),"opening and revoking settings makes no credential files")
    store.setAvailable(true)
    try check(store.saveRealtimeSettings() && !store.hasEditor && store.flushForQuit(),"explicit save commits settings and removes the quit blocker")
    let reloaded=NativeQuickASRCredentialAdapter.access(directory:credentials,service:"dev.aibro.synthetic.asr")
    let config=try reloaded.load()!
    try check(config.enabled && config==draft.configuration && (try reloaded.read(config))==draft.key,"dedicated encrypted configuration and key survive restart together")
    let files=(fm.enumerator(at:credentials,includingPropertiesForKeys:[.isRegularFileKey])?.allObjects as? [URL]) ?? []
    try check(!files.isEmpty,"credential save produced an isolated encrypted store")
    for file in files where (try file.resourceValues(forKeys:[.isRegularFileKey])).isRegularFile==true {
        let bytes=try Data(contentsOf:file);try check(bytes.range(of:Data(draft.key.utf8))==nil,"credential file contains no plaintext test key")
    }
    let before=try Data(contentsOf:folder.appendingPathComponent("index.json"))
    try check(before.range(of:Data(draft.key.utf8))==nil,"recording manifest never contains the ASR key")
    let second=NativeQuickRecordingStore();second.configure(directory:workspace);second.configureRealtime(owner:workspace,access:reloaded)
    try check(second.items.first?.transcriptionState=="partial" && second.items.first?.transcript==item.transcript,"partial real-time transcript persists as partial rather than claiming completion")
    second.saveTranscript(id:id,text:"Manually corrected note")
    try check(second.items.first?.transcriptionState=="edited" && second.items.first?.transcript=="Manually corrected note","manual correction is distinguished from retryable automatic partial text")
    try check(try Data(contentsOf:audio)==original,"metadata and settings changes never replace existing audio")
    second.beginRealtimeSettings();try check(second.removeRealtimeSettings(),"explicit remove uses the independent credential record")
    try check(try reloaded.load()==nil,"removed configuration no longer enables streaming after restart")
    try check(try Data(contentsOf:audio)==original && second.items.first?.transcript=="Manually corrected note","removing ASR configuration retains original audio and user notes")
    var object=try JSONSerialization.jsonObject(with:JSONEncoder().encode(item)) as! [String:Any];object.removeValue(forKey:"transcriptionState")
    let old=try JSONDecoder().decode(NativeQuickRecordingItem.self,from:JSONSerialization.data(withJSONObject:object))
    try check(old.transcriptionState==nil && old.transcript==item.transcript,"legacy recording metadata decodes without a migration write")
    // Same-origin schemes must not combine a stale A configuration with B's Key.
    let scopedDirectory=root.appendingPathComponent("scoped-asr")
    let scopedAccess=NativeQuickASRCredentialAdapter.access(directory:scopedDirectory,service:"dev.aibro.synthetic.asr-scopes")
    let scopeCall=scopedAccess.profiles!
    var configA=NativeQuickASRConfiguration();configA.enabled=true;configA.language="zh"
    let metadataA=String(decoding:try JSONEncoder().encode(configA),as:UTF8.self)
    _ = try scopeCall("profile-save",["id":"A","name":"A","base":configA.origin,"model":metadataA,"token":"SYNTHETIC-A","expectedRevision":0])
    let settings=NativeQuickASRSettings();settings.configure(owner:workspace,access:scopedAccess);settings.setAvailable(true)
    let initialConnection=try settings.connection()
    try check(initialConnection.0==configA && initialConnection.1=="SYNTHETIC-A","active ASR scheme initially resolves its own configuration and Key")
    let retainedA=settings.draft()
    var configB=configA;configB.language="en"
    _ = try scopeCall("profile-save",["id":"B","name":"B","base":configB.origin,"model":String(decoding:try JSONEncoder().encode(configB),as:UTF8.self),"token":"SYNTHETIC-B","expectedRevision":settings.revision])
    var rejectedStaleConnection=false
    do {_ = try settings.connection()}catch{rejectedStaleConnection=true}
    try check(rejectedStaleConnection,"external same-origin scheme switch rejects stale ASR connection instead of pairing A config with B Key")
    let scopedRestart=NativeQuickASRSettings();scopedRestart.configure(owner:workspace,access:scopedAccess);scopedRestart.setAvailable(true)
    let connectionB=try scopedRestart.connection()
    try check(connectionB.0==configB && connectionB.1=="SYNTHETIC-B","fresh ASR owner resolves the newly selected B scheme together")
    var oldDraft=retainedA;oldDraft.name="Unsaved A rename"
    try check(!scopedRestart.save(oldDraft),"a retained draft cannot silently rebase over the newly selected scheme")
    let afterStale=try scopeCall("profile-list",[:])
    try check(afterStale["activeProfileID"] as? String=="B","failed old draft save leaves current durable scheme unchanged")

    // This is a source-bound UI callback guard, not a rendered-window claim.
    // SwiftUI's private @State requires live native QA to click A→B→Save→A.
    // The actual production save callback must retain the window (and its
    // per-scheme @State drafts); only explicit discard may destroy that owner.
    let repository=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent()
    let ui=try String(contentsOf:repository.appendingPathComponent("native/Sources/AIBro/NativeQuickRealtimeASRView.swift"),encoding:.utf8)
    guard let start=ui.range(of:"    private func saveCurrent() {"),let end=ui.range(of:"    private func edit(",range:start.upperBound..<ui.endIndex) else{throw NSError(domain:"ASR save callback missing",code:1)}
    let saveCallback=String(ui[start.lowerBound..<end.lowerBound])
    try check(saveCallback.contains("settings.save(draft)") && saveCallback.contains("drafts.removeValue(forKey:id)") && saveCallback.contains("update(settings.draft(for:id))"),"actual ASR save callback clears only the saved scheme and keeps its retained editor")
    try check(!saveCallback.contains("onClose") && !saveCallback.contains("cancelRealtimeSettings") && !saveCallback.contains("drafts.removeAll"),"saving current ASR scheme cannot tear down the view that owns other unsaved drafts")
    try check(ui.contains("{saveCurrent()}") && ui.contains("Save current and keep editing") && ui.contains("Discard all unsaved changes"),"both ASR save exits retain editing and closing explicitly describes discarding every unsaved draft")
    print("\(count) Store/Archive/credential checks; synthetic files only, no device, GUI or remote request")
 }
}
