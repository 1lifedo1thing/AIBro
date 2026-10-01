import { StateField, StateEffect, MapMode } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';

export const imageAnchorChange = StateEffect.define();
class ImageUploadWidget extends WidgetType {
  constructor(count) { super(); this.count = count; }
  eq(other) { return this.count === other.count; }
  toDOM(view) {
    const element = view.dom.ownerDocument.createElement('span');
    element.className = 'source-image-upload'; element.setAttribute('role', 'status');
    element.textContent = `正在保存 ${this.count} 张图片…`;
    return element;
  }
}
export const imageAnchors = StateField.define({
  create: () => new Map(),
  update(previous, transaction) {
    const next = new Map();
    for (const [id, anchor] of previous) {
      const pos = transaction.changes.mapPos(anchor.pos, 1, MapMode.TrackDel);
      if (pos !== null) next.set(id, { ...anchor, pos });
    }
    for (const effect of transaction.effects) if (effect.is(imageAnchorChange)) {
      if (effect.value.add) next.set(effect.value.add.id, effect.value.add);
      if (effect.value.remove) next.delete(effect.value.remove);
    }
    return next;
  },
  provide: field => EditorView.decorations.from(field, anchors => Decoration.set([...anchors.values()].map(anchor =>
    Decoration.widget({ widget: new ImageUploadWidget(anchor.count), side: 1 }).range(anchor.pos)), true)),
});
