import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { Plugin } from 'prosemirror-state';
import { TableMap } from 'prosemirror-tables';
import type { EditorView, ViewMutationRecord } from 'prosemirror-view';

// Keep this factory stable when replacing plugin/state instances so ProseMirror
// can retain the editable table DOM, caret and cell selection.
function nativeTableNodeView(node: ProseMirrorNode, view: EditorView) {
  return new TableNodeView(node, view);
}

export function tableLayoutPlugin() {
  return new Plugin({
    props: { nodeViews: { table: nativeTableNodeView } },
  });
}

/** Wait for the browser's next layout opportunity; there is no JS width job to flush. */
export function flushEditorTableLayout(view: EditorView): Promise<void> {
  const window = view.dom.ownerDocument.defaultView;
  if (!window || view.isDestroyed) return Promise.resolve();
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

/** Owns the scroll shell and column markers; the browser owns all column widths. */
export class TableNodeView {
  readonly dom: HTMLDivElement;
  readonly table: HTMLTableElement;
  readonly contentDOM: HTMLTableSectionElement;
  private readonly colgroup: HTMLTableColElement;

  constructor(private node: ProseMirrorNode, view: EditorView) {
    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement('div');
    this.dom.className = 'nomo-table-scroll nomo-native-table';
    this.table = this.dom.appendChild(doc.createElement('table'));
    this.colgroup = this.table.appendChild(doc.createElement('colgroup'));
    this.colgroup.dataset.tableLayoutOwned = 'true';
    this.contentDOM = this.table.appendChild(doc.createElement('tbody'));
    this.updateColumns();
  }

  private updateColumns() {
    // Empty <col> elements expose native column geometry to the existing toolbar.
    // No pixel widths, equal-width rules or authored Markdown changes are applied.
    const count = TableMap.get(this.node).width;
    while (this.colgroup.childElementCount > count) this.colgroup.lastElementChild!.remove();
    while (this.colgroup.childElementCount < count)
      this.colgroup.appendChild(this.dom.ownerDocument.createElement('col'));
  }

  update(node: ProseMirrorNode) {
    if (node.type !== this.node.type) return false;
    if (node !== this.node) {
      this.node = node;
      this.updateColumns();
    }
    return true;
  }

  ignoreMutation(mutation: ViewMutationRecord) {
    if (mutation.type === 'selection') return false;
    if (mutation.target === this.colgroup || this.colgroup.contains(mutation.target)) return true;
    if (
      mutation.type === 'attributes' &&
      (mutation.target === this.dom || mutation.target === this.table)
    ) {
      return (
        mutation.attributeName === 'style' ||
        mutation.attributeName?.startsWith('data-table-layout') === true
      );
    }
    return (
      mutation.type === 'childList' &&
      mutation.target === this.table &&
      [...mutation.addedNodes, ...mutation.removedNodes].every(node => node === this.colgroup)
    );
  }

  destroy() {
    this.colgroup.remove();
  }
}
