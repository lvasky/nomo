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
