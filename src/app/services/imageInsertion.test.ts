import { describe, expect, it, vi } from 'vitest';
import { createEditorCore } from '../../lib/editor-core/createEditorCore';
import { DEFAULT_IMAGE_HANDLING_SETTINGS } from '../../lib/services/render';
import { createImageInsertionHandlers } from './imageInsertion';

vi.mock('../../lib/editor-core/renderers', () => ({
  getImageLoader: () => ({ import: async () => ({ markdownSrc: './assets/photo.png' }) }),
}));

describe('image insertion Markdown policy', () => {
  it.each([true, false])('respects strict Markdown in source mode: %s', async (strictMarkdown) => {
    const editor = createEditorCore({ markdown: '', mode: 'source', strictMarkdown });
    const handlers = createImageInsertionHandlers({
      getEditor: () => editor,
      getStrictMarkdown: () => strictMarkdown,
      getMode: () => 'source',
      getFileName: () => 'note.md',
      getNativePath: () => 'C:\\docs\\note.md',
      getSourceEditor: () => undefined,
      getImageContext: () => ({
        settings: {
          ...DEFAULT_IMAGE_HANDLING_SETTINGS,
          defaultImageWidth: '240',
          defaultImageAlign: 'center',
        },
      }),
      saveMarkdownFile: () => true,
      setMarkdown: vi.fn(),
      setStatusMessage: vi.fn(),
      syncSourceTextareaHeight: vi.fn(),
    });
    try {
      await handlers.insertImageFiles([
        {
          name: 'photo.png',
          type: 'image/png',
          arrayBuffer: async () => new ArrayBuffer(0),
        } as File,
      ]);
      if (strictMarkdown) expect(editor.getMarkdown()).toBe('![photo.png](./assets/photo.png)');
      else expect(editor.getMarkdown()).toContain('<p align="center">');
    } finally {
      editor.destroy();
    }
  });
});

it.each([true, false])(
  'pastes an Excel table once, without its alternate bitmap (HTML: %s)',
  async (withTable) => {
    const host = document.body.appendChild(document.createElement('div'));
    const editor = createEditorCore({ target: host, markdown: '', strictMarkdown: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const handlers = createImageInsertionHandlers({
      getEditor: () => editor,
      getMode: () => 'semantic',
      getFileName: () => 'note.md',
      getNativePath: () => 'C:\\docs\\note.md',
      getSourceEditor: () => undefined,
      getImageContext: () => ({ settings: DEFAULT_IMAGE_HANDLING_SETTINGS }),
      saveMarkdownFile: () => true,
      setMarkdown: vi.fn(),
      setStatusMessage: vi.fn(),
      syncSourceTextareaHeight: vi.fn(),
    });
    host.addEventListener('paste', handlers.handleEditorPaste);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: {
        files: [
          { name: 'image.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) },
        ],
        getData: (format: string) =>
          withTable
            ? format === 'text/html'
              ? '<table><tr><th>PRI-&gt;Stage EMO信号</th></tr><tr><td>RLS-&gt;Stage 禁止运动</td></tr></table>'
              : 'PRI->Stage EMO信号\nRLS->Stage 禁止运动'
            : '',
      },
    });
    try {
      host.querySelector('.ProseMirror')!.dispatchEvent(event);
      await handlers.awaitPendingInsertions();
      const markdown = editor.getMarkdown();
      if (withTable) {
        expect(markdown).toContain('| PRI->Stage EMO信号 |');
        expect(markdown).toContain('| RLS->Stage 禁止运动 |');
        expect(markdown).not.toContain('![');
        expect(markdown).not.toContain('assets');
        expect(markdown.match(/PRI->Stage/g) ?? []).toHaveLength(1);
      } else {
        expect(markdown).toContain('![image.png](./assets/photo.png)');
      }
    } finally {
      host.removeEventListener('paste', handlers.handleEditorPaste);
      editor.destroy();
      host.remove();
    }
  },
);
