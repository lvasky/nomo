// The semantic editor claims image pastes before ProseMirror inserts its own
// image slice. The outer handler then imports one image OR recovers a table.
// Weak keys do not retain clipboard events or their files after the paste ends.
const delegatedImagePastes = new WeakSet<ClipboardEvent>();

export function delegateImagePaste(event: ClipboardEvent): void {
  delegatedImagePastes.add(event);
}

export function isDelegatedImagePaste(event: ClipboardEvent): boolean {
  return delegatedImagePastes.has(event);
}
