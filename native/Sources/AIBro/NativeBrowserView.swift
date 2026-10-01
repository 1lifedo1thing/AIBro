import SwiftUI
import AppKit
import WebKit

struct NativeBrowserWebView:NSViewRepresentable {
    let tab:NativeBrowserTab
    let surfaceVisible:Bool
    func makeNSView(context:Context)->WKWebView {setNativeSurfaceVisibility(tab.web,visible:surfaceVisible);return tab.web}
    func updateNSView(_ view:WKWebView,context:Context) {setNativeSurfaceVisibility(view,visible:surfaceVisible)}
}
struct NativeBrowserTabView:View {
    @ObservedObject var tab:NativeBrowserTab
    let surfaceVisible:Bool
    @State private var input=""
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:6) {
                Button {perform("back")} label:{Image(systemName:"chevron.left")}.disabled(!tab.web.canGoBack || tab.status == "cancelled").help("返回上一页").accessibilityLabel("返回上一页")
                Button {perform("reload")} label:{Image(systemName:"arrow.clockwise")}.disabled(tab.address.isEmpty || tab.status == "cancelled").help("重新加载").accessibilityLabel("重新加载网页")
                HStack(spacing:6) {
                    Image(systemName:tab.address.hasPrefix("https:") ? "lock":"globe").font(.system(size:11)).foregroundStyle(.secondary)
                    TextField("搜索或输入网页地址",text:$input).textFieldStyle(.plain).font(.system(size:12)).onSubmit{navigate()}.accessibilityLabel("浏览器地址")
                    if tab.status == "loading" {ProgressView().controlSize(.mini).scaleEffect(0.8).frame(width:14,height:14)}
                    else {Button {navigate()} label:{Image(systemName:"arrow.right").font(.system(size:11))}.disabled(input.trimmingCharacters(in:.whitespaces).isEmpty).accessibilityLabel("前往网页")}
                }.padding(.horizontal,8).frame(height:28).background(Color.primary.opacity(0.045),in:RoundedRectangle(cornerRadius:7))
                if tab.paused {
                    Button {tab.resume()} label:{Image(systemName:"play.fill")}.help("完成操作，继续 Agent").accessibilityLabel("完成，继续 Agent").accessibilityIdentifier("browser-resume")
                } else {
                    Button {tab.takeOver()} label:{Image(systemName:"hand.raised")}.disabled(tab.status=="cancelled").help("接管网页，Agent 会等待你完成").accessibilityLabel("人工接管").accessibilityIdentifier("browser-takeover")
                }
                Button {tab.stop()} label:{Image(systemName:"stop.fill").font(.system(size:10))}.disabled(tab.status=="cancelled").help("停止本次浏览").accessibilityLabel("停止浏览").accessibilityIdentifier("browser-stop")
            }.buttonStyle(.borderless).controlSize(.small).padding(.horizontal,10).padding(.vertical,7)
            if tab.paused {
                HStack(spacing:8) {Text("你正在接管").font(.system(size:11,weight:.medium));Spacer();Button("完成，继续"){tab.resume()}.font(.system(size:11))}.padding(.horizontal,12).padding(.vertical,7).background(Color.primary.opacity(0.035))
            }
            if !tab.pendingTitle.isEmpty {
                VStack(alignment:.leading,spacing:8) {
                    Text(tab.pendingTitle).font(.headline)
                    Text(tab.pendingDetail).font(.caption).lineLimit(5).textSelection(.enabled)
                    HStack {Button("拒绝"){tab.decide(false)};Button("允许本次"){tab.decide(true)}}
                }.frame(maxWidth:.infinity,alignment:.leading).padding(12).background(Color.orange.opacity(0.12)).accessibilityIdentifier("browser-approval")
            }
            if !tab.notice.isEmpty && !tab.paused {
                HStack(alignment:.top,spacing:8) {Text(tab.notice).font(.caption).foregroundStyle(.secondary).lineLimit(3);Spacer(minLength:0);Button {tab.notice=""} label:{Image(systemName:"xmark").font(.system(size:9))}.buttonStyle(.plain).accessibilityLabel("关闭网页提示")}.padding(8).frame(maxWidth:.infinity,alignment:.leading)
            }
            Divider()
            NativeBrowserWebView(tab:tab,surfaceVisible:surfaceVisible).id(tab.id)
        }.onAppear{input=tab.address}.onChange(of:tab.address){_,value in input=value}
    }
    private func navigate() {
        let value=input.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !value.isEmpty else{return}
        let address=value.contains("://") ? value:value.contains(" ") || !value.contains(".") ? "https://www.google.com/search?q="+(value.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? value):"https://"+value
        tab.userNavigate(address)
    }
    private func perform(_ action:String) {
        // These are direct user gestures and remain usable during takeover.
        guard tab.status != "cancelled" && tab.status != "closed" else{return}
        if action == "back" {tab.web.goBack()}else if action == "reload" {tab.web.reload()}
    }
}
struct NativeBrowserPanel:View {
    @ObservedObject var browser:NativeBrowser
    var compact=false
    var surfaceVisible=true
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:6) {
                if compact {Button {browser.visible=false} label:{Label("返回对话",systemImage:"chevron.left").font(.system(size:11))}.buttonStyle(.plain).padding(.trailing,4).accessibilityIdentifier("browser-return-workspace")}
                ScrollView(.horizontal) {
                    HStack(spacing:4) {
                        ForEach(browser.tabs){tab in
                            HStack(spacing:5) {
                                Button{browser.selectedID=tab.id}label:{Text(tab.title).font(.system(size:11,weight:browser.selectedID==tab.id ? .medium:.regular)).lineLimit(1).frame(maxWidth:160)}.buttonStyle(.plain)
                                Button{browser.close(tab)}label:{Image(systemName:"xmark").font(.system(size:8)).frame(width:16,height:20)}.buttonStyle(.plain).accessibilityLabel("关闭网页 "+tab.title)
                            }.padding(.horizontal,8).padding(.vertical,3).background(browser.selectedID==tab.id ? Color.primary.opacity(0.055):Color.clear,in:RoundedRectangle(cornerRadius:6))
                        }
                    }
                }.scrollIndicators(.hidden)
                if let tab=browser.tabs.first(where:{$0.id==browser.selectedID}) {
                    Image(systemName:tab.paused ? "hand.raised":tab.asksPermission ? "checkmark.shield":"bolt").font(.system(size:11)).foregroundStyle(.secondary).help(tab.asksPermission ? "请求批准模式：网站与操作会询问。可在对话权限中修改。":"自动浏览：跟随对话任务执行，可随时接管或停止。此标签登录状态保留至本次应用退出。")
                }
                if !compact {Button{browser.visible=false}label:{Image(systemName:"sidebar.right").font(.system(size:12))}.buttonStyle(.plain).help("收起浏览器，网页继续保留").accessibilityLabel("收起浏览器")}
            }.padding(.horizontal,10).frame(height:36)
            Divider()
            if let tab=browser.tabs.first(where:{$0.id==browser.selectedID}) {NativeBrowserTabView(tab:tab,surfaceVisible:surfaceVisible).id(tab.id)}
            else {ContentUnavailableView("浏览器",systemImage:"globe",description:Text("在对话中请求打开网页，或从浏览器入口开始。"))}
        }.background(Color(nsColor:.windowBackgroundColor))
    }
}
// Layout visibility is distinct from window occlusion. Workspace overlays and
// explicit navigation can cover a compact browser without closing its tabs.
struct NativeBrowserLayout {
    let compact:Bool
    let browserPresented:Bool
    let workspaceVisible:Bool
    let browserWidth:CGFloat
    let workspaceWidth:CGFloat
    let dividerWidth:CGFloat
    init(width:CGFloat,preferredBrowserWidth:CGFloat,browserVisible:Bool,workspaceOverlay:Bool,compactWorkspacePreferred:Bool=false) {
        let width=max(0,width)
        compact=width<1000
        browserPresented=browserVisible && !(compact && (workspaceOverlay || compactWorkspacePreferred))
        workspaceVisible = !compact || !browserPresented
        browserWidth=compact ? width:min(max(420,preferredBrowserWidth),width-561)
        dividerWidth=browserPresented && !compact ? 1:0
        workspaceWidth=browserPresented ? (compact ? 0:width-browserWidth-dividerWidth):width
    }
}
struct NativeBrowserWorkspace<Content:View>:View {
    @ObservedObject var browser:NativeBrowser
    var workspaceOverlay=false
    var compactWorkspacePreferred=false
    var onCompactChange:(Bool)->Void={_ in}
    @ViewBuilder var content:(Bool)->Content
    @State private var preferredBrowserWidth:CGFloat=500
    @State private var dragStart:CGFloat?
    var body:some View {
        GeometryReader { geometry in
            let layout=NativeBrowserLayout(width:geometry.size.width,preferredBrowserWidth:preferredBrowserWidth,browserVisible:browser.visible,workspaceOverlay:workspaceOverlay,compactWorkspacePreferred:compactWorkspacePreferred)
            let compact=layout.compact,browserWidth=layout.browserWidth
            HStack(spacing:0) {
                // Keep the workspace and browser at stable structural identities:
                // resizing does not discard drafts, navigation or DOM focus.
                content(layout.workspaceVisible).frame(width:layout.workspaceWidth,height:geometry.size.height).clipped().opacity(layout.workspaceVisible ? 1:0).allowsHitTesting(layout.workspaceVisible).disabled(!layout.workspaceVisible).accessibilityHidden(!layout.workspaceVisible)
                if browser.visible {
                    Rectangle().fill(Color.primary.opacity(0.09)).frame(width:layout.dividerWidth).overlay {
                        Color.clear.frame(width:9).contentShape(Rectangle()).onHover{inside in if inside {NSCursor.resizeLeftRight.push()}else{NSCursor.pop()}}
                            .gesture(DragGesture(minimumDistance:1).onChanged{value in
                                if dragStart == nil {dragStart=browserWidth}
                                preferredBrowserWidth=min(max(420,(dragStart ?? browserWidth)-value.translation.width),geometry.size.width-561)
                            }.onEnded{_ in dragStart=nil})
                    }.accessibilityLabel("浏览器宽度").accessibilityAdjustableAction{direction in
                        preferredBrowserWidth=min(max(420,browserWidth+(direction == .increment ? 40:-40)),geometry.size.width-561)
                    }.opacity(layout.dividerWidth>0 ? 1:0).accessibilityHidden(layout.dividerWidth==0).allowsHitTesting(layout.dividerWidth>0).disabled(layout.dividerWidth==0)
                    // Preserve the mounted controls, pending approvals and the
                    // browser viewport while the compact workspace owns input.
                    NativeBrowserPanel(browser:browser,compact:compact,surfaceVisible:layout.browserPresented)
                        .frame(width:browserWidth,height:geometry.size.height)
                        .frame(width:layout.browserPresented ? browserWidth:0,alignment:.leading)
                        .clipped().opacity(layout.browserPresented ? 1:0)
                        .allowsHitTesting(layout.browserPresented).disabled(!layout.browserPresented).accessibilityHidden(!layout.browserPresented)
                }
            }.frame(width:geometry.size.width,height:geometry.size.height,alignment:.leading)
                .onChange(of:layout.compact,initial:true){_,value in onCompactChange(value)}
        }
    }
}
