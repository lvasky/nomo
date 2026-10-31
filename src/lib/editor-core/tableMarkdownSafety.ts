import type { Node } from 'prosemirror-model';

export class UnsupportedMarkdownTableError extends Error {
  constructor() {
    super('This table cannot be represented losslessly as Markdown.');
    this.name = 'UnsupportedMarkdownTableError';
  }
}

// At most one validation context per immutable row. Weak keys follow live
// documents/undo states; ordinary cell edits reuse the other rows' results.
const rowChecks = new WeakMap<Node, { signature: string; valid: boolean }>();
export function isMarkdownTable(table: Node): boolean {
  const header = table.firstChild;
  if (!header?.childCount) return false;
  const alignments: unknown[] = [];
  header.forEach(cell => alignments.push(cell.attrs.align));
  const signature = JSON.stringify(alignments);
  for (let index = 0; index < table.childCount; index++) {
    const row = table.child(index);
    const key = `${index === 0}:${signature}`;
    let checked = rowChecks.get(row);
    if (!checked || checked.signature !== key) {
      let valid = row.childCount === alignments.length;
      row.forEach((cell, _offset, column) => {
        valid &&= cell.type.spec.tableRole === (index === 0 ? 'header_cell' : 'cell') &&
          cell.attrs.colspan === 1 && cell.attrs.rowspan === 1 &&
          cell.attrs.colwidth === null && cell.attrs.align === alignments[column];
      });
      checked = { signature: key, valid };
      rowChecks.set(row, checked);
    }
    if (!checked.valid) return false;
  }
  return true;
}

/** Reject only newly introduced/modified unsupported tables, not existing HTML. */
export function introducesUnsupportedTable(before: Node, after: Node): boolean {
  let existing: Node[] | undefined;
  const unchangedExistingTable = (table: Node) => {
    if (!existing) {
      existing = [];
      before.descendants(node => {
        if (node.type.spec.tableRole !== 'table') return;
        existing!.push(node);
        return false;
      });
    }
    return existing.some(node => node === table);
  };
  const changed = (next: Node, previous?: Node): boolean => {
    if (previous && next.eq(previous)) return false;
    if (next.type.spec.tableRole === 'table')
      return !isMarkdownTable(next) && !unchangedExistingTable(next);
    for (let index = 0; index < next.childCount; index++) {
      if (changed(next.child(index), previous?.maybeChild(index) ?? undefined)) return true;
    }
    return false;
  };
  return changed(after, before);
}
