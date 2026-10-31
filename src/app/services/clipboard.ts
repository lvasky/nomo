import type { EditorClipboardPayload } from '../../lib/editor-core';

export type ClipboardReadResult =
  | { kind: 'html'; html: string; text: string }
  | { kind: 'image'; files: File[] }
  | { kind: 'text'; text: string };

export type ClipboardReadPreference = 'rich' | 'text';

/** Excel also supplies a bitmap of its selection; the table is the editable representation. */
export function containsClipboardTable(html: string): boolean {
  if (!/<table[\s>]/i.test(html)) return false;
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.querySelector('table td, table th') !== null;
}

function restoreClipboardTableEnvelope(html: string): string {
  if (containsClipboardTable(html) || !/<(?:tr|td|th|tbody|thead|tfoot)[\s>]/i.test(html)) return html;
  // CF_HTML's StartFragment/EndFragment can be inside Excel's <table>.
  // arboard returns that fragment, so restore the missing table context before
  // parsing; otherwise HTML parsing drops standalone row/cell elements.
  const template = document.createElement('template');
  template.innerHTML = `<table>${html}</table>`;
  return template.content.querySelector('table td, table th') ? template.innerHTML : html;
}

export async function writeFileClipboard(path: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('copy_file_to_clipboard', { path });
}

export async function writeEditorClipboard(
  payload: EditorClipboardPayload,
  desktopEnabled: boolean,
): Promise<void> {
  if (desktopEnabled) {
    const { writeHtml, writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    if (payload.html) {
      try {
        await writeHtml(payload.html, payload.text);
        return;
      } catch {
        // 部分平台或剪贴板实现不接受 HTML，降级为纯文本。
      }
    }
    await writeText(payload.text);
    return;
  }

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined' && payload.html) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([payload.text], { type: 'text/plain' }),
        'text/html': new Blob([payload.html], { type: 'text/html' }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(payload.text);
}

export async function readEditorClipboard(
  desktopEnabled: boolean,
  preference: ClipboardReadPreference = 'rich',
): Promise<ClipboardReadResult> {
  // WebView2 may expose only Excel's PNG representation. Read CF_HTML through
  // the existing native clipboard first, rather than falling straight to readImage.
  const native = desktopEnabled ? await tryReadNativeClipboardText() : null;
  if (preference === 'text' && native?.text) return { kind: 'text', text: native.text };
  if (preference === 'rich' && native && containsClipboardTable(native.html)) {
    return { kind: 'html', html: native.html, text: native.text };
  }
  const webResult = await tryReadWebClipboard(preference);
  if (webResult) return webResult;
  if (!desktopEnabled) {
    const text = await navigator.clipboard.readText();
    return { kind: 'text', text };
  }

  const { readImage, readText } = await import('@tauri-apps/plugin-clipboard-manager');
  if (preference === 'text') {
    return { kind: 'text', text: await readText().catch(() => '') };
  }
  try {
    const image = await readImage();
    const size = await image.size();
    const rgba = await image.rgba();
    const file = await rgbaToPngFile(rgba, size.width, size.height);
    return { kind: 'image', files: [file] };
  } catch {
    const text = await readText();
    return { kind: 'text', text };
  }
}

async function tryReadNativeClipboardText(): Promise<{ html: string; text: string } | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<{ html: string; text: string }>('read_editor_clipboard_text');
    return { ...result, html: restoreClipboardTableEnvelope(result.html) };
  } catch {
    // Keep the existing Web Clipboard / image-only fallback available.
    return null;
  }
}

/** Ctrl+V can expose a PNG File while hiding Excel's native HTML from DataTransfer. */
export async function readNativeClipboardTable(): Promise<{ html: string; text: string } | null> {
  const native = await tryReadNativeClipboardText();
  return native && containsClipboardTable(native.html) ? native : null;
}

async function tryReadWebClipboard(
  preference: ClipboardReadPreference,
): Promise<ClipboardReadResult | null> {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    const imageFiles: File[] = [];
    let html = '';
    let text = '';
    for (const item of items) {
      if (!html && item.types.includes('text/html')) {
        html = restoreClipboardTableEnvelope(await (await item.getType('text/html')).text());
      }
      if (!text && item.types.includes('text/plain')) {
        text = await (await item.getType('text/plain')).text();
      }
    }
    if (preference === 'text') return { kind: 'text', text };
    if (containsClipboardTable(html)) return { kind: 'html', html, text };
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        imageFiles.push(new File([blob], `clipboard.${extensionForMime(imageType)}`, { type: imageType }));
      }
    }
    if (imageFiles.length) return { kind: 'image', files: imageFiles };
    if (html) return { kind: 'html', html, text };
    if (text) return { kind: 'text', text };
  } catch {
    // WebView 可能拒绝 clipboard.read；由桌面插件完成降级读取。
  }
  return null;
}

async function rgbaToPngFile(
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  const pixels = Uint8ClampedArray.from(rgba);
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return new File([blob], 'clipboard.png', { type: 'image/png' });
}

function extensionForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}
