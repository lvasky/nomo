import { afterEach, describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { parseMarkdown } from './markdown';
import { projectInlineSource } from './InlineSourceCodec';
import { setTypographyOptions } from '../typography/options';
import { DEFAULT_TYPOGRAPHY } from '../typography/types';

const editors: EditorCore[] = [];
function open(markdown: string, strictMarkdown?: boolean) {
  setTypographyOptions({ ...DEFAULT_TYPOGRAPHY, enabled: false });
  const target = document.body.appendChild(document.createElement('div'));
  const editor = createEditorCore({ target, markdown, strictMarkdown });
  editors.push(editor);
  const view = (editor as unknown as { view: EditorView }).view;
  return { editor, view };
}
function selectText(view: EditorView, text: string) {
  let position = -1;
  view.state.doc.descendants((node, pos) => {
    if (position < 0 && node.isText && node.text?.includes(text))
      position = pos + node.text.indexOf(text);
  });
  expect(position).toBeGreaterThanOrEqual(0);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, position, position + text.length),
    ),
  );
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
  setTypographyOptions(DEFAULT_TYPOGRAPHY);
});

describe('strict Markdown', () => {
  it.each(['PRI->Stage ', 'PRI-\\>Stage '])('copies ordinary arrows without unnecessary greater-than escapes: %s', (source) => {
    const { editor, view } = open(source);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.firstChild!.nodeSize - 1)));
    expect(editor.getClipboardPayload()?.text).toBe('PRI->Stage');
    expect(editor.getMarkdown()).toBe(source);
  });

  it('does not add greater-than escapes when pasting and copying plain arrow text', () => {
    const { editor, view } = open('');
    editor.pasteClipboard({ text: 'PRI->Stage ' }, { mode: 'plain' });
    selectText(view, 'PRI->Stage ');
    expect(editor.getClipboardPayload()?.text).toBe('PRI->Stage ');
  });

  it('preserves code backslashes and necessary literal quote escapes when copying', () => {
    const { editor, view } = open('`PRI-\\>Stage` and \\> quote');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, view.state.doc.firstChild!.nodeSize - 1)));
    expect(editor.getClipboardPayload()?.text).toContain('`PRI-\\>Stage`');
    editor.setMarkdown('\\> quote');
    selectText(view, '\\> quote');
    expect(editor.getClipboardPayload()?.text).toBe('\\> quote');
  });
  it('is enabled by default, blocks automatic HTML commands and supports an explicit opt-out', () => {
    const { editor, view } = open('hello');
    selectText(view, 'hello');
    expect(editor.execute({ type: 'toggleUnderline' })).toBe(false);
    expect(editor.execute({ type: 'insertDetails' })).toBe(false);
    editor.updateOptions({ strictMarkdown: false });
    expect(editor.execute({ type: 'toggleUnderline' })).toBe(true);
    expect(editor.getMarkdown()).toContain('<u>hello</u>');
  });

  it('keeps an irregular table verbatim on open, save, and unrelated edits', () => {
    const table = '|A   | B|\n|---|:-------:|\n| x|y   |';
    const { editor, view } = open(`before\n\n${table}\n\nafter`);
    expect(editor.getMarkdown()).toBe(`before\n\n${table}\n\nafter`);
    selectText(view, 'before');
    expect(editor.execute({ type: 'insertText', text: 'changed' })).toBe(true);
    expect(editor.getMarkdown()).toContain(table);
    editor.setMarkdown(editor.getMarkdown(), { reason: 'save-file' });
    expect(editor.getMarkdown()).toContain(table);
  });

  it.each(['|A   | B|\n|---|:-------:|\n| x|y   |', 'A | B\n--- | ---\nx | y'])(
    'edits only one cell and supports undo/redo: %s',
    (table) => {
      const { editor, view } = open(table);
      selectText(view, 'y');
      editor.execute({ type: 'insertText', text: 'updated' });
      expect(editor.getMarkdown()).toBe(table.replace('y', 'updated'));
      editor.execute({ type: 'undo' });
      expect(editor.getMarkdown()).toBe(table);
      editor.execute({ type: 'redo' });
      expect(editor.getMarkdown()).toBe(table.replace('y', 'updated'));
    },
  );

  it('pastes styled, merged, multiline HTML tables as GFM with plain br breaks', () => {
    const { editor } = open('');
    expect(
      editor.pasteClipboardHtml(
        '<table><tr><td colspan="2" width="200"><p><u>A</u></p><p>B</p></td></tr><tr><td>C</td><td><mark>D</mark><br>E</td></tr></table>',
      ),
    ).toBe(true);
    const markdown = editor.getMarkdown();
    expect(markdown).toContain('A<br>B');
    expect(markdown).toContain('D<br>E');
    expect(markdown).not.toMatch(/<(?!br>)[a-z/]|data-nomo|colspan|width=/i);
    const table = parseMarkdown(markdown).firstChild!;
    expect(table.type.name).toBe('table');
    expect(table.child(0).childCount).toBe(2);
    expect(table.child(1).textContent).toContain('C');
  });

  it('preserves existing and manually entered HTML, including inside edited tables', () => {
    const { editor, view } = open(
      '<div class="custom">keep</div>\n\n| A | B |\n| --- | --- |\n| <u>raw</u> | y |',
    );
    selectText(view, 'y');
    editor.execute({ type: 'insertText', text: 'z' });
    expect(editor.getMarkdown()).toContain('<div class="custom">keep</div>');
    expect(editor.getMarkdown()).toContain('<u>raw</u>');
    editor.setMarkdown('manual <span class="mine">HTML</span>', { reason: 'source-input' });
    expect(editor.getMarkdown()).toBe('manual <span class="mine">HTML</span>');
  });

  it('keeps multiline cells in a GFM table after editing and serializing again', () => {
    const { editor, view } = open('');
    editor.pasteClipboardHtml(
      '<table><tr><th>A</th></tr><tr><td><p>one</p><p>two</p></td></tr></table>',
    );
    selectText(view, 'two');
    editor.execute({ type: 'insertText', text: 'three' });
    expect(editor.getMarkdown()).toContain('one<br>three');
    expect(editor.getMarkdown()).not.toContain('<table');
    const doc = projectInlineSource(parseMarkdown(editor.getMarkdown()));
    expect(doc.firstChild?.type.name).toBe('table');
  });

  it('preserves CRLF, the final newline, and escaped pipes when editing one cell', () => {
    const table = '| A | B |\r\n|---|---|\r\n| a\\|b | y |\r\n';
    const { editor, view } = open(table);
    selectText(view, 'y');
    editor.execute({ type: 'insertText', text: 'z' });
    expect(editor.getMarkdown()).toBe(table.replace('y', 'z'));
  });

  it('changes column alignment without reformatting cell padding or dash lengths', () => {
    const table = '|A   | B|\n|---|-------|\n| x|y   |';
    const { editor, view } = open(table);
    selectText(view, 'y');
    editor.execute({ type: 'setTableColumnAlignment', align: 'center' });
    expect(editor.getMarkdown()).toBe(table.replace('|---|-------|', '|---|:-------:|'));
  });

  it('does not create image attributes from paste or default image insertion settings', () => {
    const { editor } = open('');
    editor.pasteClipboardHtml(
      '<p><img src="https://example.com/image.png" width="200" align="center" alt="image"></p>',
    );
    expect(editor.getMarkdown()).toContain('![image](https://example.com/image.png)');
    expect(editor.getMarkdown()).not.toMatch(/<img|align=|width=/);
    editor.setMarkdown('');
    editor.execute({
      type: 'insertImage',
      src: 'photo.png',
      alt: 'photo',
      width: '200',
      align: 'center',
    });
    expect(editor.getMarkdown()).toContain('![photo](photo.png)');
    expect(editor.getMarkdown()).not.toMatch(/<img|<p|width=/);
  });

  it('pastes rich cells into an existing Markdown table without introducing an HTML table', () => {
    const { editor, view } = open('| A | B |\n| --- | --- |\n| x | y |');
    selectText(view, 'x');
    editor.pasteClipboardHtml(
      '<table><tr><td style="width: 100px"><p>new</p><p>line</p></td><td><u>second</u></td></tr></table>',
    );
    expect(editor.getMarkdown()).not.toMatch(/<table|<u>|data-nomo/);
    expect(editor.getMarkdown()).toContain('new<br>line');
    expect(editor.getMarkdown()).toContain('second');
  });

  it('keeps a nested table unchanged during an unrelated edit', () => {
    const markdown = '> |A   | B|\n> |---|:-------:|\n> | x|y   |\n\nafter';
    const { editor, view } = open(markdown);
    selectText(view, 'after');
    editor.execute({ type: 'insertText', text: 'changed' });
    expect(editor.getMarkdown()).toBe(markdown.replace('after', 'changed'));
  });

  it('does not add extra list indentation to an unchanged nested table', () => {
    const markdown = '- list\n\n  |A   | B|\n  |---|:-------:|\n  | x|y   |\n\nafter';
    const { editor, view } = open(markdown);
    selectText(view, 'after');
    editor.execute({ type: 'insertText', text: 'changed' });
    expect(editor.getMarkdown()).toBe(markdown.replace('after', 'changed'));
  });

  it('converts pasted details markup to Markdown content without adding details tags', () => {
    const { editor } = open('');
    editor.pasteClipboardHtml('<details><summary>title</summary><p>body</p></details>');
    expect(editor.getMarkdown()).toContain('title');
    expect(editor.getMarkdown()).toContain('body');
    expect(editor.getMarkdown()).not.toContain('<details');
  });
});
