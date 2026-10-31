import { DOMSerializer, type Node } from 'prosemirror-model';
import { Selection, type Command } from 'prosemirror-state';
import { closeHistory } from 'prosemirror-history';
import { serializeMarkdown } from './markdown';
import { findTableContext } from './tableCommands';
import { tableSourceCells, tableSourceFormatKey } from './tableSource';
import { projectInlineSource } from './InlineSourceCodec';
import type { EditorClipboardPayload } from './types';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Source columns in a monospace editor: CJK/fullwidth and emoji occupy two cells. */
function sourceWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (/^[\p{Mark}\u200d\ufe0e\ufe0f]+$/u.test(segment)) continue;
    width +=
      /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Script=Han}|\p{Extended_Pictographic}/u.test(
        segment,
      )
        ? 2
        : 1;
  }
  return width;
}

/** Change only padding and separator dashes; never reserialize inline cell content. */
export function beautifyTableSource(source: string): string | null {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const rows = source.split(/\r?\n/).map(tableSourceCells);
  if (rows.length < 2 || !rows[0].length) return null;
  const count = rows[0].length;
  if (rows.some((row) => row.length !== count) || rows[1].some((cell) => !/^:?-+:?$/.test(cell)))
    return null;
  const widths = rows[0].map((_, column) =>
    rows.reduce(
      (width, row, index) => (index === 1 ? width : Math.max(width, sourceWidth(row[column]))),
      3 + Number(rows[1][column].startsWith(':')) + Number(rows[1][column].endsWith(':')),
    ),
  );
  return rows
    .map(
      (row, index) =>
        `| ${row
          .map((cell, column) => {
            if (index !== 1) return cell + ' '.repeat(widths[column] - sourceWidth(cell));
            const left = cell.startsWith(':') ? ':' : '';
            const right = cell.endsWith(':') ? ':' : '';
            return left + '-'.repeat(widths[column] - left.length - right.length) + right;
          })
          .join(' | ')} |`,
    )
    .join(newline);
}

export function createTableClipboardPayload(
  table: Node,
  ownerDocument: Document,
  strictMarkdown = true,
): EditorClipboardPayload {
  const fragment = DOMSerializer.fromSchema(table.type.schema).serializeNode(
    projectInlineSource(table),
    { document: ownerDocument },
  );
  const container = ownerDocument.createElement('div');
  container.append(fragment);
  return {
    text: serializeMarkdown(table.type.schema.nodes.doc.create(null, [table]), { strictMarkdown }),
    html: container.innerHTML,
  };
}

export function canBeautifyTable(table: Node, strictMarkdown = true): boolean {
  const columns = table.firstChild?.childCount ?? 0;
  if (!columns) return false;
  for (let row = 0; row < table.childCount; row++) {
    const cells = table.child(row);
    if (cells.childCount !== columns) return false;
    for (let column = 0; column < columns; column++) {
      const cell = cells.child(column);
      if (
        cell.type.spec.tableRole !== (row === 0 ? 'header_cell' : 'cell') ||
        cell.attrs.colspan !== 1 ||
        cell.attrs.rowspan !== 1 ||
        cell.attrs.colwidth !== null ||
        (!strictMarkdown && cell.childCount !== 1) ||
        cell.attrs.align !== table.child(0).child(column).attrs.align
      )
        return false;
    }
  }
  return true;
}

export function beautifyCurrentTable(strictMarkdown = true): Command {
  return (state, dispatch) => {
    const context = findTableContext(state);
    if (!context || !canBeautifyTable(context.table, strictMarkdown)) return false;
    if (!dispatch) return true;
    const { table, tableStart } = context;
    const source = serializeMarkdown(state.schema.nodes.doc.create(null, [table]), {
      strictMarkdown,
    });
    const formatted = beautifyTableSource(source);
    if (formatted === null || formatted === source) return false;
    const next = table.type.create(
      { ...table.attrs, sourceFormatRevision: table.attrs.sourceFormatRevision + 1 },
      table.content,
      table.marks,
    );
    // Replace the immutable table as a unit so undo restores its exact source identity.
    // Children are shared; selection positions stay valid because their sizes do not change.
    const tr = closeHistory(state.tr).replaceWith(
      tableStart - 1,
      tableStart - 1 + table.nodeSize,
      next,
    );
    tr.setSelection(Selection.fromJSON(tr.doc, state.selection.toJSON()));
    tr.setMeta(tableSourceFormatKey, { pos: tableStart - 1, source: formatted });
    dispatch(tr);
    return true;
  };
}
