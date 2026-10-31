import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { parseMarkdown } from './markdown';
import { beautifyCurrentTable, beautifyTableSource } from './tableActions';

const editors: EditorCore[] = [];
async function open(markdown: string) {
  const onCopyTable = vi.fn();
  const onChange = vi.fn();
  const host = document.body.appendChild(document.createElement('div'));
  const editor = createEditorCore({ target: host, markdown, onCopyTable, onChange });
  editors.push(editor);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const view = (editor as unknown as { view: EditorView }).view;
  let tablePos = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table' && tablePos < 0) tablePos = pos;
  });
  if (tablePos >= 0)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, tablePos + 4)));
  return { editor, view, host, onCopyTable, onChange };
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
});

const raw = '| 名称 |Value|\n|:--|--:|\n|REG[3:0]|PRI->Stage|\n|控制|`x\\|y`<br> A > B|';
describe('table toolbar actions', () => {
  it('aligns source padding, retains inline syntax and alignment, and is idempotent', () => {
    const formatted = beautifyTableSource(raw)!;
    expect(formatted).not.toBe(raw);
    expect(beautifyTableSource(formatted)).toBe(formatted);
    expect(parseMarkdown(formatted).eq(parseMarkdown(raw))).toBe(true);
    expect(formatted).toContain('PRI->Stage');
    expect(formatted).toContain('`x\\|y`<br> A > B');
    expect(beautifyTableSource('<table><tr><td>x</td></tr></table>')).toBeNull();
  });
  it('uses Chinese display widths and retains CRLF', () => {
    const source = '|名称|值|\r\n|:---|---:|\r\n|控制|0x1|';
    expect(beautifyTableSource(source)).toBe(
      '| 名称 | 值   |\r\n| :--- | ---: |\r\n| 控制 | 0x1  |',
    );
  });
  it('changes only the current table, preserves selection, and undoes/redoes exact source', async () => {
    const source =
      'Before  text\r\n\r\n' +
      raw.replace(/\n/g, '\r\n') +
      '\r\n\r\n| Other |\r\n| -- |\r\n| untouched |\r\n\r\nAfter  text\r\n';
    const { editor, view, onChange } = await open(source);
    const selection = view.state.selection.toJSON();
    expect(beautifyCurrentTable()(view.state, view.dispatch)).toBe(true);
    const result = editor.getMarkdown();
    expect(result).toBe(
      source.replace(raw.replace(/\n/g, '\r\n'), beautifyTableSource(raw)!.replace(/\n/g, '\r\n')),
    );
    expect(view.state.selection.toJSON()).toEqual(selection);
    expect(onChange.mock.calls.at(-1)?.[0].dirty).toBe(true);
    expect(editor.execute({ type: 'undo' })).toBe(true);
    expect(editor.getMarkdown()).toBe(source);
    expect(editor.execute({ type: 'redo' })).toBe(true);
    expect(editor.getMarkdown()).toBe(result);
    expect(beautifyCurrentTable()(view.state, view.dispatch)).toBe(false);
  });
  it('preserves the new layout on later edits instead of automatically realigning the table', async () => {
    const { editor, view } = await open(raw);
    beautifyCurrentTable()(view.state, view.dispatch);
    const formatted = editor.getMarkdown();
    view.dispatch(view.state.tr.insertText('X'));
    expect(editor.getMarkdown()).toBe(formatted.replace('名称', 'X名称'));
    editor.execute({ type: 'undo' });
    expect(editor.getMarkdown()).toBe(formatted);
    editor.execute({ type: 'undo' });
    expect(editor.getMarkdown()).toBe(raw);
  });
  it('copies the whole current table as Markdown and HTML without changing selection/source', async () => {
    const { editor, view, host, onCopyTable } = await open('Outside\n\n' + raw);
    const selection = view.state.selection.toJSON();
    const button = host.querySelector<HTMLButtonElement>('.util-copy-table')!;
    expect(button).not.toBeNull();
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(onCopyTable).toHaveBeenCalledOnce();
    const payload = onCopyTable.mock.calls[0][0];
    expect(payload.text).toBe(raw);
    expect(payload.html).toContain('<table');
    expect(payload.html).toContain('PRI-&gt;Stage');
    expect(payload.html).not.toContain('Outside');
    expect(payload.html).not.toContain('data-table-layout');
    expect(view.state.selection.toJSON()).toEqual(selection);
    expect(editor.getMarkdown()).toBe('Outside\n\n' + raw);
    expect(editor.execute({ type: 'undo' })).toBe(false);
  });
  it('keeps a multi-cell selection and does not serialize formatting metadata', async () => {
    const { editor, view, host } = await open(raw);
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === 'cell') cells.push(pos);
    });
    view.dispatch(
      view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[0], cells[1])),
    );
    const selection = view.state.selection.toJSON();
    host
      .querySelector('.util-format-table')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const formatted = editor.getMarkdown();
    expect(formatted).toBe(beautifyTableSource(raw));
    expect(formatted).not.toContain('sourceFormatRevision');
    expect(view.state.selection.toJSON()).toEqual(selection);
    editor.execute({ type: 'undo' });
    expect(editor.getMarkdown()).toBe(raw);
    editor.execute({ type: 'redo' });
    expect(editor.getMarkdown()).toBe(formatted);
    editor.setDirty(false);
    view.dispatch(view.state.tr.insertText('X', 4));
    editor.execute({ type: 'undo' });
    expect(editor.getMarkdown()).toBe(formatted);
  });
  it('preserves list markers and indentation around a nested table', async () => {
    const table = '|A|B|\n|--|--|\n|x|longvalue|';
    const nested = table
      .split('\n')
      .map((line) => '    ' + line)
      .join('\n');
    const source = '*   item\n\n' + nested + '\n\n*   next';
    const { editor, view } = await open(source);
    expect(beautifyCurrentTable()(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(
      source.replace(
        nested,
        beautifyTableSource(table)!
          .split('\n')
          .map((line) => '    ' + line)
          .join('\n'),
      ),
    );
  });
  it('only exposes controls inside an editable table', async () => {
    const { editor, view, host } = await open(raw);
    expect(host.querySelector('.util-format-table')).not.toBeNull();
    editor.updateOptions({ readonly: true });
    expect(host.querySelector('.util-copy-table')).toBeNull();
    editor.updateOptions({ readonly: false });
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(host.querySelector('.util-format-table')).toBeNull();
  });
  it('preserves the surrounding quote and unrelated source when formatting a nested table', async () => {
    const table = '|A|B|\n|--|--|\n|x|longvalue|';
    const source =
      'Before\n\n>   quote\n>\n' +
      table
        .split('\n')
        .map((line) => '> ' + line)
        .join('\n') +
      '\n>\n>   tail\n\nAfter';
    const { editor, view } = await open(source);
    expect(beautifyCurrentTable()(view.state, view.dispatch)).toBe(true);
    expect(editor.getMarkdown()).toBe(
      source.replace(
        table
          .split('\n')
          .map((line) => '> ' + line)
          .join('\n'),
        beautifyTableSource(table)!
          .split('\n')
          .map((line) => '> ' + line)
          .join('\n'),
      ),
    );
  });
});
