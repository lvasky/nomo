import { afterEach, describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { createEditorCore } from './createEditorCore';
import type { EditorCore } from './types';
import { projectInlineSource } from './InlineSourceCodec';
import { parseMarkdown } from './markdown';
import { setTypographyOptions } from '../typography/options';
import { DEFAULT_TYPOGRAPHY } from '../typography/types';

const editors: EditorCore[] = [];
function open(markdown = '') {
  setTypographyOptions({ ...DEFAULT_TYPOGRAPHY, enabled: false });
  const target = document.body.appendChild(document.createElement('div'));
  const editor = createEditorCore({ target, markdown, strictMarkdown: true });
  editors.push(editor);
  const view = (editor as unknown as { view: EditorView }).view;
  return { editor, view };
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
  setTypographyOptions(DEFAULT_TYPOGRAPHY);
});

describe('clipboard and minimal escaping contract', () => {
  it.each([
    'PRI->Stage',
    'A > B',
    'REG[3:0]',
    'DATA_BUS[7]',
    'foo_bar',
    'x*y',
    'price $5',
    'x|y',
    'not[link]',
  ])('does not escape ordinary technical text: %s', (text) => {
    const { editor } = open();
    editor.pasteClipboard({ text }, { mode: 'plain' });
    expect(editor.getMarkdown()).toBe(text);
    editor.selectAll();
    expect(editor.getClipboardPayload({ format: 'markdown' })?.text).toBe(text);
  });

  it('offers Markdown copy independently of the ordinary copy preference and always includes HTML', () => {
    const { editor } = open('**bold** and REG[3:0]');
    editor.updateOptions({ copyMarkdownSyntaxEnabled: false });
    editor.selectAll();
    expect(editor.getClipboardPayload()?.text).toBe('bold and REG[3:0]');
    const payload = editor.getClipboardPayload({ format: 'markdown' })!;
    expect(payload.text).toBe('**bold** and REG[3:0]');
    expect(payload.html).toContain('<strong>bold</strong>');
    expect(editor.getClipboardPayload()?.text).toBe('bold and REG[3:0]');
  });

  it('prefers HTML for ordinary paste, while plain paste uses literal text without HTML styling', () => {
    const { editor } = open();
    const input = { text: '**literal**', html: '<p>REG[3:0] <strong>formatted</strong></p>' };
    editor.pasteClipboard(input);
    expect(editor.getMarkdown()).toBe('REG[3:0] **formatted**');
    editor.setMarkdown('');
    editor.pasteClipboard(input, { mode: 'plain' });
    editor.selectAll();
    expect(editor.getClipboardPayload({ format: 'plain' })?.text).toBe('**literal**');
    expect(editor.getMarkdown()).not.toMatch(/<strong>|<span>|<p>/);
  });

  it.each([
    '**bold**',
    '*a*',
    '[label](https://example.com)',
    '<span>x</span>',
    '&amp;',
    '\\*',
    '# heading',
    '>quote',
    '- item',
    '1. item',
    '[ ] task',
    '`x*y`',
    'A\nB',
    '$$\nE = mc^2\n$$',
    '| A | B |\n| --- | --- |\n| 1 | 2 |',
  ])(
    'keeps literal text and stable escapes through five copy/paste/save/reopen cycles: %s',
    (text) => {
      let { editor } = open();
      editor.pasteClipboard({ text }, { mode: 'plain' });
      const first = editor.getMarkdown();
      for (let i = 0; i < 5; i++) {
        const saved = editor.getMarkdown();
        editor.setMarkdown(saved, { reason: 'open-file' });
        editor.selectAll();
        expect(editor.getClipboardPayload({ format: 'plain' })?.text).toBe(text);
        const payload = editor.getClipboardPayload({ format: 'markdown' })!;
        editor = open().editor;
        editor.pasteClipboard(payload);
        expect(editor.getMarkdown()).toBe(first);
      }
    },
  );

  it('keeps code block contents literal when pasting HTML and Markdown-looking text', () => {
    const { editor, view } = open('```text\noriginal\n```');
    const pos = 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    const text = 'REG[3:0] PRI->Stage A > B **x** \\path\nnext';
    editor.pasteClipboard({ text, html: '<p><strong>wrong</strong></p>' });
    expect(view.state.doc.firstChild?.type.name).toBe('code_block');
    expect(view.state.doc.firstChild?.textContent).toContain(text);
  });

  it.each([
    'Use `REG[3:0] PRI->Stage A > B \\path` here',
    '```text\nREG[3:0] PRI->Stage A > B \\path\n```',
    '[REG[3:0]](https://example.com/a_(b)?x=1&y=2 "title")',
    '| Register | Code |\n|---|---|\n| REG[3:0] PRI->Stage A > B | `x*y` |',
  ])(
    'retains technical text, links, code and tables after repeated rich clipboard round trips: %s',
    (source) => {
      let { editor } = open(source);
      for (let i = 0; i < 5; i++) {
        editor.selectAll();
        const payload = editor.getClipboardPayload({ format: 'markdown' })!;
        expect(payload.text).not.toContain('REG\\[');
        expect(payload.text).not.toContain('PRI-\\>');
        editor = open().editor;
        editor.pasteClipboard(payload);
        const saved = editor.getMarkdown();
        editor.setMarkdown(saved, { reason: 'open-file' });
        const semantics = (markdown: string) =>
          JSON.parse(
            JSON.stringify(projectInlineSource(parseMarkdown(markdown)).toJSON()),
            (key, value) => (key === 'align' && value === null ? 'left' : value),
          );
        expect(semantics(saved)).toEqual(semantics(source));
      }
    },
  );

  it('preserves unrelated source syntax, whitespace, separators and mixed newlines', () => {
    const source =
      'Title\r\n=====\r\n\r\n\r\n+ item\n\nchange me\n\n\n|A   | B|\r\n|---|:----:|\r\n|x|y |\r\n';
    const { editor, view } = open(source);
    let from = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'change me') from = pos;
    });
    expect(from).toBeGreaterThan(0);
    view.dispatch(view.state.tr.insertText('changed', from, from + 'change me'.length));
    expect(editor.getMarkdown()).toBe(source.replace('change me', 'changed'));
  });

  it.each([false, true])(
    'retains unsaved manual source formatting when semantic editing resumes (deferred: %s)',
    (deferred) => {
      const { editor, view } = open('# Title\n\n- item\n\nchange me');
      const manual = 'Title\n=====\n\n+ item\n\nchange me';
      if (deferred) editor.updateOptions({ mode: 'source' });
      editor.setMarkdown(manual, { reason: 'source-input', sourceInput: deferred });
      if (deferred) editor.updateOptions({ mode: 'semantic' });
      let from = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'change me') from = pos;
      });
      view.dispatch(view.state.tr.insertText('changed', from, from + 'change me'.length));
      expect(editor.getMarkdown()).toBe(manual.replace('change me', 'changed'));
    },
  );

  it.each(['REG[3:0] A | B', 'REG[3:0] A \\| B', 'trailing\\\nnext'])(
    'preserves cell text without accumulating escapes: %s',
    (text) => {
      let { editor, view } = open('| A | B |\n|---|---|\n| x | y |');
      let at = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'x') at = pos;
      });
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + 1)));
      editor.pasteClipboard({ text }, { mode: 'plain' });
      let last = '';
      for (let i = 0; i < 4; i++) {
        const source = editor.getMarkdown();
        if (i > 1) expect(source).toBe(last);
        const projected = projectInlineSource(parseMarkdown(source));
        const cell = projected.firstChild!.child(1).child(0);
        const payloadText = cell.textBetween(0, cell.content.size, '\n', () => '\n');
        expect(payloadText, `round ${i}: ${source}`).toBe(text);
        editor.setMarkdown(source, { reason: 'open-file' });
        editor.selectAll();
        const payload = editor.getClipboardPayload({ format: 'markdown' })!;
        last = source;
        ({ editor, view } = open());
        editor.pasteClipboard(payload);
      }
    },
  );

  it('preserves a pasted literal link label including unmatched closing brackets', () => {
    const { editor, view } = open('[label](https://example.com)');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    editor.pasteClipboard({ text: 'REG[3:0] and a]b' }, { mode: 'plain' });
    const saved = editor.getMarkdown();
    const projected = projectInlineSource(parseMarkdown(saved));
    expect(projected.textContent).toBe('REG[3:0] and a]b');
    expect(projected.firstChild!.firstChild!.marks.some((mark) => mark.type.name === 'link')).toBe(
      true,
    );
  });
});
