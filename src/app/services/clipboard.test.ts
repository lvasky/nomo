import { afterEach, describe, expect, it, vi } from 'vitest';
import { containsClipboardTable, readEditorClipboard } from './clipboard';

const html =
  '<html><body><!--StartFragment--><table><tr><td>PRI-&gt;Stage</td></tr></table><!--EndFragment--></body></html>';
function clipboardItem(types: string[], values: Record<string, string>) {
  return {
    types,
    getType: vi.fn(async (type: string) =>
      type.startsWith('text/')
        ? ({ text: async () => values[type] ?? '' } as Blob)
        : new Blob(['bitmap'], { type }),
    ),
  };
}
function mockClipboard(items: ReturnType<typeof clipboardItem>[]) {
  vi.stubGlobal('navigator', { clipboard: { read: async () => items } });
}
afterEach(() => vi.unstubAllGlobals());

describe('spreadsheet clipboard representations', () => {
  it('selects the editable table before its bitmap, including separate clipboard items', async () => {
    const image = clipboardItem(['image/png'], {});
    image.getType.mockRejectedValue(new Error('bitmap unavailable'));
    mockClipboard([
      image,
      clipboardItem(['text/html', 'text/plain'], { 'text/html': html, 'text/plain': 'PRI->Stage' }),
    ]);
    expect(await readEditorClipboard(false)).toEqual({ kind: 'html', html, text: 'PRI->Stage' });
    expect(image.getType).not.toHaveBeenCalled();
  });
  it('reads plain text without decoding the spreadsheet bitmap', async () => {
    const item = clipboardItem(['image/png', 'text/html', 'text/plain'], {
      'text/html': html,
      'text/plain': 'A\tB',
    });
    mockClipboard([item]);
    expect(await readEditorClipboard(false, 'text')).toEqual({ kind: 'text', text: 'A\tB' });
    expect(item.getType).not.toHaveBeenCalledWith('image/png');
  });
  it('keeps standalone image clipboard imports', async () => {
    mockClipboard([clipboardItem(['image/png'], {})]);
    const result = await readEditorClipboard(false);
    expect(result.kind).toBe('image');
    if (result.kind === 'image')
      expect(result.files[0]).toMatchObject({ type: 'image/png', name: 'clipboard.png' });
  });
  it('recognizes real table markup rather than escaped examples, comments or empty shells', () => {
    expect(containsClipboardTable(html)).toBe(true);
    for (const text of [
      '&lt;table&gt;',
      '<!-- <table><tr><td>x</td></tr></table> -->',
      '<table></table>',
      '<img src="image.png">',
    ]) {
      expect(containsClipboardTable(text)).toBe(false);
    }
  });
});
