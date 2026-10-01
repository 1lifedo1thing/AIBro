import AppKit

/// Route/layout exclusion, not ordinary window occlusion. Keep the view and
/// document alive while removing the inactive surface from key and AX traversal.
@MainActor func setNativeSurfaceVisibility(_ view:NSView,visible:Bool) {
    guard view.isHidden == visible else{return}
    if !visible,let window=view.window,let responder=window.firstResponder as? NSView,
       responder === view || responder.isDescendant(of:view) {
        window.makeFirstResponder(nil)
    }
    view.isHidden = !visible
}
