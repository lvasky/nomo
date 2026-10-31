import type { Node } from 'prosemirror-model';
import { Plugin, type Transaction } from 'prosemirror-state';
import type { MarkdownSyncAnchor } from './scrollSyncMapping';

// Only live tables/undo states retain their original source and immutable rows.
// No DOM, document copies, global string cache or persistent listeners.
const sources = new WeakMap<Node, { original: Node; lines: string[]; newline: string }>();

export function rememberTableSources(
  doc: Node,
  markdown: string,
  anchors: MarkdownSyncAnchor[],
): void {
  const tables = anchors.filter((anchor) => anchor.kind === 'table' && anchor.edge === 'start');
  if (!tables.length) return;
  const lines = markdown.split(/\r?\n/);
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  for (const anchor of tables) {
    const table = doc.nodeAt(anchor.pos);
    if (!table) continue;
    let raw = lines.slice(anchor.fromLine - 1, anchor.toLine);
    // Strip container syntax, which the enclosing Markdown serializer restores.
    if (anchor.depth > 0) {
      raw = raw.map((line) => line.replace(/^(?:\s{0,3}> ?)+/, ''));
      const prefix = raw[0].match(/^\s*(?:(?:[-+*]|\d+[.)])\s+)+/)?.[0];
      if (prefix)
        raw = raw.map((line, index) =>
          index === 0
            ? line.slice(prefix.length)
            : line.replace(new RegExp(`^ {0,${prefix.length}}`), ''),
        );
      const indent = raw.reduce(
        (min, line) => (line.trim() ? Math.min(min, line.match(/^ */)![0].length) : min),
        Infinity,
      );
      if (indent > 0 && Number.isFinite(indent)) raw = raw.map((line) => line.slice(indent));
    }
    if (raw.length === table.childCount + 1 && /^\s*\|?\s*:?-{1,}/.test(raw[1] ?? '')) {
      sources.set(table, {
        original: table,
        lines: raw,
        newline,
      });
    }
  }
}

function inheritSources(tr: Transaction): void {
  tr.steps.forEach((step, index) => {
    const before = tr.docs[index];
    const after = tr.docs[index + 1] ?? tr.doc;
    const map = step.getMap();
    map.forEach((from, to) => {
      for (const pos of [from, to]) {
        const $pos = before.resolve(pos);
        const candidates: Array<{ node: Node; pos: number }> = [];
        for (let depth = $pos.depth; depth > 0; depth--) {
          if ($pos.node(depth).type.name === 'table')
            candidates.push({ node: $pos.node(depth), pos: $pos.before(depth) });
        }
        if ($pos.nodeAfter?.type.name === 'table') candidates.push({ node: $pos.nodeAfter, pos });
        for (const candidate of candidates) {
          const source = sources.get(candidate.node);
          const next = after.nodeAt(map.map(candidate.pos, -1));
          if (source && next?.type.name === 'table') sources.set(next, source);
        }
      }
    });
  });
}

export function tableSourcePlugin(): Plugin {
  return new Plugin({
    state: {
      init: () => null,
      apply(tr) {
        inheritSources(tr);
        return null;
      },
    },
  });
}

/** Keep untouched rows verbatim, and replace only edited cell payloads. */
export function preserveTableSource(
  table: Node,
  renderCell: (cell: Node) => string,
): string | null {
  const source = sources.get(table);
  if (!source) return null;
  const { original, lines, newline } = source;
  if (table.eq(original)) return lines.join(newline);
  if (table.childCount !== original.childCount) return null;
  const result = [...lines];
  const separators = cellBounds(lines[1]);
  let separator = lines[1];
  for (let column = table.child(0).childCount - 1; column >= 0; column--) {
    const align = table.child(0).child(column).attrs.align;
    if (align === original.child(0).maybeChild(column)?.attrs.align) continue;
    if (!separators[column]) return null;
    const [from, to] = separators[column];
    const raw = lines[1].slice(from, to);
    const dashes = raw.match(/-+/)?.[0];
    if (!dashes) return null;
    const marker =
      align === 'center'
        ? `:${dashes}:`
        : align === 'right'
          ? `${dashes}:`
          : align === 'left'
            ? `:${dashes}`
            : dashes;
    separator =
      separator.slice(0, from) +
      (raw.match(/^\s*/)?.[0] ?? '') +
      marker +
      (raw.match(/\s*$/)?.[0] ?? '') +
      separator.slice(to);
  }
  result[1] = separator;
  for (let row = 0; row < table.childCount; row++) {
    const next = table.child(row),
      prev = original.child(row);
    if (next.eq(prev)) continue;
    if (next.childCount !== prev.childCount) return null;
    const lineIndex = row === 0 ? 0 : row + 1;
    const line = lines[lineIndex];
    const bounds = cellBounds(line);
    if (bounds.length !== next.childCount) return null;
    let patched = line;
    for (let column = next.childCount - 1; column >= 0; column--) {
      const cell = next.child(column),
        old = prev.child(column);
      // Attribute/structure changes need fresh GFM separators or a new grid.
      if (
        cell.type !== old.type ||
        cell.attrs.colspan !== old.attrs.colspan ||
        cell.attrs.rowspan !== old.attrs.rowspan ||
        cell.attrs.colwidth !== old.attrs.colwidth ||
        cell.attrs.align !== table.child(0).child(column).attrs.align
      )
        return null;
      if (cell.content.eq(old.content)) continue;
      const [from, to] = bounds[column];
      const raw = line.slice(from, to);
      patched =
        patched.slice(0, from) +
        (raw.match(/^\s*/)?.[0] ?? '') +
        renderCell(cell) +
        (raw.trim() ? (raw.match(/\s*$/)?.[0] ?? '') : '') +
        patched.slice(to);
    }
    result[lineIndex] = patched;
  }
  return result.join(newline);
}

function cellBounds(line: string): Array<[number, number]> {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '|') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) pipes.push(i);
  }
  const start = pipes[0] !== undefined && !line.slice(0, pipes[0]).trim() ? pipes.shift()! + 1 : 0;
  const last = pipes.at(-1);
  const end = last !== undefined && !line.slice(last + 1).trim() ? pipes.pop()! : line.length;
  const edges = [start - 1, ...pipes, end];
  return edges.slice(1).map((edge, i) => [edges[i] + 1, edge]);
}
