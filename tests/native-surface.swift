import AppKit

final class FocusSurface:NSView {override var acceptsFirstResponder:Bool{true}}
func require(_ value:Bool,_ message:String){if !value{fatalError(message)}}
@main struct NativeSurfaceTest {
 @MainActor static func main(){
  _=NSApplication.shared
  let window=NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:400),styleMask:[.titled],backing:.buffered,defer:false)
  let container=NSView(frame:window.contentView!.bounds),surface=FocusSurface(frame:NSRect(x:0,y:0,width:300,height:400)),child=FocusSurface(frame:NSRect(x:0,y:0,width:200,height:100)),native=FocusSurface(frame:NSRect(x:300,y:0,width:300,height:400))
  window.contentView=container;container.addSubview(surface);surface.addSubview(child);container.addSubview(native)
  require(window.makeFirstResponder(child),"fixture responder accepted")
  setNativeSurfaceVisibility(surface,visible:false)
  require(surface.isHidden && window.firstResponder !== child,"hidden subtree must resign only its owned descendant")
  require(surface.subviews.first === child && surface.window === window,"hiding retains the same subtree and window")
  setNativeSurfaceVisibility(surface,visible:true)
  require(!surface.isHidden && window.firstResponder !== child,"reveal must not steal focus back")
  require(window.makeFirstResponder(native),"native control focus accepted")
  setNativeSurfaceVisibility(surface,visible:false)
  require(window.firstResponder === native,"other native responder must not be cleared")
  setNativeSurfaceVisibility(surface,visible:false)
  require(window.firstResponder === native,"repeated snapshot must not reset focus")
  setNativeSurfaceVisibility(surface,visible:true)
  require(window.firstResponder === native && surface.subviews.first === child,"reappearance retains native focus and descendant identity")
  print("PASS: 6 native surface ownership checks")
 }
}
