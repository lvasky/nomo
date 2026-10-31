import { removeEmptyTrailingParagraph } from './plugins/trailingParagraph';
import type { Node } from 'prosemirror-model';
import { parseMarkdownWithSyncAnchors, serializeMarkdown } from './markdown';

type BlockRange = { from: number; to: number };
const rangesByBaseline = new WeakMap<Node, BlockRange[] | null>();

/** Patch only the changed top-level block interval; retain untouched bytes and separators. */
export function serializeSourceChange(
  doc: Node,
  baseline: Node,
  source: string,
  strictMarkdown?: boolean,
): string | null {
  const baselineKey = baseline;
  baseline = removeEmptyTrailingParagraph(baseline);
  let ranges = rangesByBaseline.get(baselineKey);
  if (ranges === undefined) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    const anchors = parseMarkdownWithSyncAnchors(source).anchors.filter(
      (a) => a.depth === 0 && a.edge === 'start',
    );
    ranges = anchors.map((a) => {
      let to = starts[a.toLine] ?? source.length;
      if (source[to - 1] === '\n') to--;
      if (source[to - 1] === '\r') to--;
      return { from: starts[a.fromLine - 1], to };
    });
    if (ranges.length !== baseline.childCount || ranges.some((r) => r.from === undefined))
      ranges = null;
    rangesByBaseline.set(baselineKey, ranges);
  }
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
