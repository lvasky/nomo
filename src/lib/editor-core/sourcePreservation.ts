import { removeEmptyTrailingParagraph } from './plugins/trailingParagraph';
import type { Node } from 'prosemirror-model';
import { parseMarkdownWithSyncAnchors, serializeMarkdown } from './markdown';
import { preserveTableSource } from './tableSource';

type BlockRange = { from: number; to: number };
type SourceRanges = { blocks: BlockRange[] | null; tables: Map<number, BlockRange> };
const rangesByBaseline = new WeakMap<Node, SourceRanges>();

/** Formatting a nested table must not normalize its surrounding list or quote. */
function serializeTableFormatting(
  doc: Node,
  baseline: Node,
  source: string,
  tables: Map<number, BlockRange>,
  strictMarkdown?: boolean,
): string | null {
  const changes: Array<{ before: Node; after: Node; pos: number }> = [];
  const visit = (before: Node, after: Node, pos: number): boolean => {
    if (before.eq(after)) return true;
    if (
      before.type.name === 'table' &&
      after.type === before.type &&
      before.attrs.sourceFormatRevision !== after.attrs.sourceFormatRevision
    ) {
      changes.push({ before, after, pos });
      return true;
    }
    if (!before.sameMarkup(after) || before.childCount !== after.childCount || before.isLeaf)
      return false;
    let offset = pos + 1;
    for (let index = 0; index < before.childCount; index++) {
      if (!visit(before.child(index), after.child(index), offset)) return false;
      offset += before.child(index).nodeSize;
    }
    return true;
  };
  if (!visit(baseline, doc, -1) || !changes.length) return null;
  const patches: Array<BlockRange & { text: string }> = [];
  for (const { before, after, pos } of changes) {
    const range = tables.get(pos);
    const original = preserveTableSource(before, () => '');
    if (!range || original === null) return null;
    const oldLines = original.split(/\r?\n/);
    const newLines = serializeMarkdown(doc.type.create(null, [after]), { strictMarkdown }).split(
      /\r?\n/,
    );
    const rawLines = source.slice(range.from, range.to).split(/\r?\n/);
    if (
      oldLines.length !== newLines.length ||
      oldLines.length !== rawLines.length ||
      rawLines.some((line, index) => !line.endsWith(oldLines[index]))
    )
      return null;
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    patches.push({
      ...range,
      text: rawLines
        .map((line, index) => line.slice(0, line.length - oldLines[index].length) + newLines[index])
        .join(newline),
    });
  }
  let result = source;
  for (const patch of patches.sort((a, b) => b.from - a.from))
    result = result.slice(0, patch.from) + patch.text + result.slice(patch.to);
  return result;
}

/** Patch only the changed top-level block interval; retain untouched bytes and separators. */
export function serializeSourceChange(
  doc: Node,
  baseline: Node,
  source: string,
  strictMarkdown?: boolean,
): string | null {
  const baselineKey = baseline;
  baseline = removeEmptyTrailingParagraph(baseline);
  let cached = rangesByBaseline.get(baselineKey);
  if (cached === undefined) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    const anchors = parseMarkdownWithSyncAnchors(source).anchors.filter((a) => a.edge === 'start');
    const rangeFor = (a: (typeof anchors)[number]) => {
      let to = starts[a.toLine] ?? source.length;
      if (source[to - 1] === '\n') to--;
      if (source[to - 1] === '\r') to--;
      return { from: starts[a.fromLine - 1], to };
    };
    let ranges: BlockRange[] | null = anchors.filter((a) => a.depth === 0).map(rangeFor);
    if (ranges.length !== baseline.childCount || ranges.some((r) => r.from === undefined))
      ranges = null;
    cached = {
      blocks: ranges,
      tables: new Map(anchors.filter((a) => a.kind === 'table').map((a) => [a.pos, rangeFor(a)])),
    };
    rangesByBaseline.set(baselineKey, cached);
  }
  const formatted = serializeTableFormatting(doc, baseline, source, cached.tables, strictMarkdown);
  if (formatted !== null) return formatted;
  const ranges = cached.blocks;
  if (!ranges) return null;
  let first = 0;
  while (
    first < Math.min(doc.childCount, baseline.childCount) &&
    doc.child(first).eq(baseline.child(first))
  )
    first++;
  let oldEnd = baseline.childCount,
    newEnd = doc.childCount;
  while (oldEnd > first && newEnd > first && baseline.child(oldEnd - 1).eq(doc.child(newEnd - 1))) {
    oldEnd--;
    newEnd--;
  }
  if (first === oldEnd && first === newEnd) return null;
  const nodes: Node[] = [];
  for (let i = first; i < newEnd; i++) nodes.push(doc.child(i));
  let replacement = nodes.length
    ? serializeMarkdown(doc.type.create(null, nodes), { strictMarkdown })
    : '';
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  replacement = replacement.replace(/\r?\n/g, newline);
  let from = ranges[first]?.from ?? source.length;
  let to = oldEnd > first ? ranges[oldEnd - 1].to : from;
  if (!nodes.length && oldEnd > first) {
    const gap = first > 0 ? source.slice(ranges[first - 1].to, from) : '';
    if (first > 0) from = ranges[first - 1].to;
    to = ranges[oldEnd]?.from ?? source.length;
    replacement = first > 0 && oldEnd < ranges.length ? gap : '';
  }
  if (oldEnd === first && replacement) {
    if (from > 0 && !source.slice(0, from).endsWith(newline + newline))
      replacement = newline + newline + replacement;
    if (from < source.length) replacement += newline + newline;
  }
  let result = source.slice(0, from) + replacement + source.slice(to);
  const oldPrefix = String(baseline.attrs.frontMatterPrefix ?? '');
  const newPrefix = String(doc.attrs.frontMatterPrefix ?? '');
  if (oldPrefix !== newPrefix) result = newPrefix + result.slice(oldPrefix.length);
  return result;
}
