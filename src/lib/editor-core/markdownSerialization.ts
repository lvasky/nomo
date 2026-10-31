import {
  defaultMarkdownSerializer,
  MarkdownSerializer,
  MarkdownSerializerState,
} from 'prosemirror-markdown';
import {
  Slice,
  Fragment,
  type Mark,
  type Node as ProseMirrorNode,
  type ResolvedPos,
} from 'prosemirror-model';
import { preserveTableSource } from './tableSource';
import { isMarkdownTable, UnsupportedMarkdownTableError } from './tableMarkdownSafety';
import { schema, type TableColumnAlignment } from './schema';
import { serializeHtmlBlock, serializeHtmlInlineContent } from './html/pmToHtml';
import { serializeHtmlAnchorOpen } from './html/htmlAnchor';
import { serializeCallout } from './callout/calloutSerializer';
import { TOC_START_MARKER, TOC_END_MARKER } from '../toc/tocMarkers';
import { escapeHtmlAttr } from './markdownTokenizer';
import { serializeMarkdownLinkDestination, serializeMarkdownLinkTitle } from './link';
import { analyzeInlineSourceText, escapeInlineSourceLiteral, escapeLiteralBlockSyntax, isInlineSourceText, projectInlineSource, readTaskListMarker } from './InlineSourceCodec';

const paragraphSyntaxRanges = new WeakMap<MarkdownSerializerState, Array<{ from: number; to: number }>>();

const tableMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    details(state, node) {
      const title = serializeHtmlInlineContent(projectInlineSource(node.child(0)));
      state.text(`<details${node.attrs.defaultOpen ? ' open' : ''}>\n<summary>${title}</summary>\n`, false);
      state.write('\n');
      state.renderContent(node.child(1));
      flushPendingClosedBlock(state);
      state.ensureNewLine();
      state.write('</details>');
      state.closeBlock(node);
    },
    details_summary(state, node) { state.renderInline(node); state.closeBlock(node); },
    details_body(state, node) { state.renderContent(node); },
    horizontal_rule(state, node, parent, index) {
      if (parent.type === schema.nodes.list_item && index === 0) {
        // 列表首块不能输出 - ---，否则保存后会被当作列表外的分割线。
        state.write('***\n');
        state.closeBlock(node);
      } else {
        defaultMarkdownSerializer.nodes.horizontal_rule(state, node, parent, index);
      }
    },
    code_block(state, node) {
      const code = node.textContent;
      const params = String(node.attrs.params ?? '');
      // 反引号围栏的 info 不能含反引号；正文中的同类符号串也不能提前闭合围栏。
      const marker = params.includes('`') ? '~' : '`';
      let fenceLength = 3;
      for (const match of code.matchAll(marker === '~' ? /~+/g : /`+/g)) {
        fenceLength = Math.max(fenceLength, match[0].length + 1);
      }
      const fence = marker.repeat(fenceLength);
      state.write(`${fence}${params}\n`);
      state.text(code, false);
      state.write('\n');
      state.write(fence);
      state.closeBlock(node);
    },
    paragraph(state, node, parent, index) {
      const taskParagraph = parent.type === schema.nodes.list_item && index === 0
        ? splitTaskParagraph(node)
        : null;
      if (taskParagraph) {
        state.write(taskParagraph.marker);
        renderParagraphInline(state, taskParagraph.content);
        state.closeBlock(node);
        return;
      }
      if (node.content.size === 0) {
        // 空段落只需要触发前一个块落盘；不写入当前列表缩进，避免保存成带空格的“空行”。
        flushPendingClosedBlock(state);
      } else {
        renderParagraphInline(state, node);
      }
      state.closeBlock(node);
    },
    hard_break(state, node, parent, index) {
      if (parent.type.name === 'heading' || parent.type.name === 'footnote_def') {
        // 标题和脚注定义必须保持一条源码行，显式保存定义内的软/硬换行属性。
        state.write(`<br data-nomo-break="${node.attrs.soft === true ? 'soft' : 'hard'}">`);
        return;
      }
      if (node.attrs.soft === true) {
        if (hasFollowingInlineContent(parent, index)) {
          state.write('\n');
        }
        return;
      }

      if (!hasFollowingInlineContent(parent, index)) {
        // Markdown 行尾转义无法保留段尾硬换行，使用已有 HTML 换行表示往返。
        state.write('<br>');
        return;
      }
      defaultMarkdownSerializer.nodes.hard_break(state, node, parent, index);
    },
    bullet_list(state, node) {
      state.renderList(node, '  ', () => '- ');
    },
    ordered_list(state, node) {
      const start = node.attrs.order ?? 1;
      const maxWidth = String(start + node.childCount - 1).length;
      state.renderList(node, state.repeat(' ', maxWidth + 2), (index) => {
        const marker = String(start + index);
        return state.repeat(' ', maxWidth - marker.length) + marker + '. ';
      });
    },
    table(state, node) {
      state.text(serializeTable(node, strictMode(state)), false);
      state.closeBlock(node);
    },
    table_row() {
      return;
    },
    table_cell() {
      return;
    },
    table_header() {
      return;
    },
    html_block(state, node) {
      const html = serializeHtmlBlock(node);
      state.text(html, false);
      state.closeBlock(node);
    },
    html_anchor(state, node) {
      state.write(`${serializeHtmlAnchorOpen(node.attrs)}</a>`);
    },
    comment_block(state, node) {
      state.text(serializeMarkdownComment(String(node.attrs.content ?? ''), true), false);
      state.closeBlock(node);
    },
    toc_block(state, node) {
      if (node.attrs.sourceMarker !== null) {
        state.text(String(node.attrs.sourceMarker), false);
        state.closeBlock(node);
        return;
      }
      const content = String(node.attrs.content ?? '').replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');
      state.text(
        [TOC_START_MARKER, ...(content ? [content] : []), TOC_END_MARKER].join('\n'),
        false,
      );
      state.closeBlock(node);
    },
    image(state, node, parent) {
      const src = String(node.attrs.src ?? '');
      const alt = String(node.attrs.alt ?? '');
      const title = node.attrs.title as string | null;
      const align = node.attrs.align as string | null;
      const width = node.attrs.width as string | null;

      if (parent.type.name !== 'heading' && (align === 'left' || align === 'center' || align === 'right')) {
        // 有对齐 → 块级 HTML：<p align="...">\n  <img ...>\n</p>
        const from = (state as unknown as { out: string }).out.length;
        state.ensureNewLine();
        let imgTag = `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(alt)}"`;
        if (title) imgTag += ` title="${escapeHtmlAttr(title)}"`;
        if (width) imgTag += ` width="${escapeHtmlAttr(width)}"`;
        imgTag += '>';
        state.write(`<p align="${align}">\n  ${imgTag}\n</p>`);
        paragraphSyntaxRanges.get(state)?.push({ from, to: (state as unknown as { out: string }).out.length });
        state.closeBlock(node);
      } else if (width && parent.type.name !== 'heading') {
        // 只有宽度 → 内联 <img ...>（不换行，保留在段落内）
        let imgTag = `<img src="${escapeHtmlAttr(src)}" alt="${escapeHtmlAttr(alt)}"`;
        if (title) imgTag += ` title="${escapeHtmlAttr(title)}"`;
        imgTag += ` width="${escapeHtmlAttr(width)}"`;
        imgTag += '>';
        state.write(imgTag);
      } else {
        // 标题必须保持单行；图片属性使用已有 Markdown 属性语法保存。
        const escapedAlt = escapeInlineSourceLiteral(alt).replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
        const escapedSrc = serializeMarkdownLinkDestination(src);
        const titleStr = title ? ` "${serializeMarkdownLinkTitle(title)}"` : '';
        state.write(`![${escapedAlt}](${escapedSrc}${titleStr})`);
        if (parent.type.name === 'heading') {
          const attrs: string[] = [];
          if (align === 'left' || align === 'center' || align === 'right') attrs.push(`align=${align}`);
          if (width) attrs.push(`width=${width}`);
          if (attrs.length) state.write(`{${attrs.join(' ')}}`);
        }
      }
    },
    math_inline(state, node) {
      const tex = String(node.attrs.tex).replace(/(\\*)\$/g, (match, slashes: string) =>
        slashes.length % 2 === 1 ? match : `${slashes}\\$`,
      );
      state.write(`$${tex}$`);
    },
    comment_inline(state, node, parent, index) {
      const content = String(node.attrs.content ?? '');
      // 段首含邻项、空白行和标题会打断 Markdown 行内边界，复用既有 HTML 注释节点表示。
      if (
        content.includes('\n') && (
          parent.type.name === 'heading' ||
          (parent.childCount > 1 && (index === 0 || /\n[ \t]*\n/.test(content)))
        )
      ) {
        state.write(serializeHtmlInlineComment(content));
      } else {
        state.write(serializeMarkdownComment(content, false));
      }
    },
    footnote_ref(state, node) {
      state.write(`[^${node.attrs.id}]`);
    },
    footnote_def(state, node) {
      state.ensureNewLine();
      state.write(`[^${node.attrs.id}]: `);
      state.renderInline(node);
      state.closeBlock(node);
    },
    text(state, node, parent) {
      if (isInlineSourceText(node)) {
        const from = (state as unknown as { out: string }).out.length;
        state.text('clipboard' in state.options && state.options.clipboard === true
          ? minimizeClipboardGreaterThanEscapes(node.text ?? '') : node.text ?? '', false);
        if (node.marks.some((mark) => mark.type.name === 'inline_source' && mark.attrs.literal === true)) {
          paragraphSyntaxRanges.get(state)?.push({ from, to: (state as unknown as { out: string }).out.length });
        }
        return;
      }
      let escaped = escapeInlineSourceLiteral(node.text ?? '', { linkLabel: node.marks.some((mark) => mark.type.name === 'link') });
      if (containsLiteralDisplayMathSyntax(parent)) {
        escaped = escaped.replace(/(?<!\\)\$/g, '\\$');
      }
      const atBlank = (state as unknown as { atBlank(): boolean }).atBlank();
      state.text(atBlank ? escapeMarkdownBlockStart(escaped) : escaped, false);
    },
    math_block(state, node) {
      state.text(['$$', node.attrs.tex as string, '$$'].join('\n'), false);
      state.closeBlock(node);
    },
    mermaid_block(state, node) {
      const code = node.attrs.code as string;
      let fence = '```';
      for (const match of code.matchAll(/`+/g)) {
        if (match[0].length >= fence.length) fence = '`'.repeat(match[0].length + 1);
      }
      state.text([`${fence}mermaid`, code, fence].join('\n'), false);
      state.closeBlock(node);
    },
    callout(state, node) {
      serializeCallout(state, node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    inline_source: { open: '', close: '', mixable: true },
    em: {
      ...defaultMarkdownSerializer.marks.em,
      open(_state, mark, parent, index) {
        return !strictMode(_state) && emphasisNeedsHtml(mark, parent, index) ? '<em>' : '*';
      },
      close(_state, mark, parent, index) {
        return !strictMode(_state) && emphasisNeedsHtml(mark, parent, index) ? '</em>' : '*';
      },
    },
    strong: {
      ...defaultMarkdownSerializer.marks.strong,
      open(_state, mark, parent, index) {
        return !strictMode(_state) && emphasisNeedsHtml(mark, parent, index) ? '<strong>' : '**';
      },
      close(_state, mark, parent, index) {
        return !strictMode(_state) && emphasisNeedsHtml(mark, parent, index) ? '</strong>' : '**';
      },
    },
    strikethrough: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    underline: {
      open: '<u>',
      close: '</u>',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    superscript: { open: '<sup>', close: '</sup>', mixable: true },
    subscript: { open: '<sub>', close: '</sub>', mixable: true },
    highlight: {
      open: '<mark>',
      close: '</mark>',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    link: {
      open(_state, mark) {
        return mark.attrs.html ? serializeHtmlAnchorOpen(mark.attrs) : '[';
      },
      close(_state, mark) {
        if (mark.attrs.html) return '</a>';
        const href = serializeMarkdownLinkDestination(String(mark.attrs.href ?? ''));
        const title = mark.attrs.title
          ? ` "${serializeMarkdownLinkTitle(String(mark.attrs.title))}"`
          : '';
        return `](${href}${title})`;
      },
      mixable: true,
    },
  },
);

// 表格单元格复用完整行内规则；图片属性和换行必须保持在同一条表格源码行内。
const tableCellMarkdownSerializer = new MarkdownSerializer(
  {
    ...tableMarkdownSerializer.nodes,
    paragraph(state, node, _parent, index) {
      if (index > 0) state.write('<br>');
      state.renderInline(node, false);
    },
    hard_break(state, node) {
      state.write(strictMode(state) || node.attrs.soft !== true ? '<br>' : '<br data-nomo-break="soft">');
    },
    comment_inline(state, node, parent, index) {
      const content = String(node.attrs.content ?? '');
      if (content.includes('\n')) state.write(serializeHtmlInlineComment(content));
      else tableMarkdownSerializer.nodes.comment_inline(state, node, parent, index);
    },
    image(state, node, parent, index) {
      const { align, width } = node.attrs;
      const inlineImage = node.type.create({ ...node.attrs, align: null, width: null });
      tableMarkdownSerializer.nodes.image(state, inlineImage, parent, index);
      const attrs: string[] = [];
      if (align === 'left' || align === 'center' || align === 'right') attrs.push(`align=${align}`);
      if (width) attrs.push(`width=${width}`);
      if (attrs.length) state.write(`{${attrs.join(' ')}}`);
    },
    text(state, node) {
      const text = node.text ?? '';
      state.text(
        isInlineSourceText(node) ? text : escapeInlineSourceLiteral(text, { linkLabel: node.marks.some((mark) => mark.type.name === 'link') }),
        false,
      );
    },
  },
  tableMarkdownSerializer.marks,
);

function emphasisNeedsHtml(mark: Mark, parent: ProseMirrorNode, index: number): boolean {
  let from = Math.min(index, parent.childCount - 1);
  if (from >= 0 && !mark.isInSet(parent.child(from).marks)) from -= 1;
  if (from < 0) return false;

  let to = from + 1;
  while (from > 0 && mark.isInSet(parent.child(from - 1).marks)) from -= 1;
  while (to < parent.childCount && mark.isInSet(parent.child(to).marks)) to += 1;

  const first = inlineBoundaryText(parent.child(from)).match(/^[\s\S]/u)?.[0];
  const last = inlineBoundaryText(parent.child(to - 1)).match(/[\s\S]$/u)?.[0];
  const before = from > 0 ? inlineBoundaryText(parent.child(from - 1)).match(/[\s\S]$/u)?.[0] : '';
  const after = to < parent.childCount ? inlineBoundaryText(parent.child(to)).match(/^[\s\S]/u)?.[0] : '';

  // * / ** 内侧是标点、外侧紧贴文字时不满足 CommonMark 边界规则；用 HTML 保留真实格式。
  if (
    (isInlinePunctuation(first) && isInlineWordCharacter(before)) ||
    (isInlinePunctuation(last) && isInlineWordCharacter(after))
  ) {
    return true;
  }

  // 加粗回退为 HTML 时，外层斜体的星号也可能紧贴标签，需一起保持兼容。
  if (mark.type === schema.marks.em) {
    for (let i = from; i < to; i++) {
      const strong = schema.marks.strong.isInSet(parent.child(i).marks);
      if (
        strong &&
        (i === from || !strong.isInSet(parent.child(i - 1).marks)) &&
        emphasisNeedsHtml(strong, parent, i)
      ) {
        return true;
      }
    }
  }
  return false;
}

function inlineBoundaryText(node: ProseMirrorNode): string {
  if (node.type.name === 'hard_break') return '\n';
  return node.textContent || '\ufffc';
}

function isInlinePunctuation(character: string | undefined): boolean {
  return Boolean(character && /[\p{P}\p{S}]/u.test(character));
}

function isInlineWordCharacter(character: string | undefined): boolean {
  return Boolean(character && !/\s/u.test(character) && !isInlinePunctuation(character));
}

function hasFollowingInlineContent(parent: ProseMirrorNode, index: number): boolean {
  for (let i = index + 1; i < parent.childCount; i++) {
    if (parent.child(i).type.name !== 'hard_break') {
      return true;
    }
  }
  return false;
}

function strictMode(state: MarkdownSerializerState): boolean {
  return 'strictMarkdown' in state.options && state.options.strictMarkdown === true;
}

export function serializeMarkdown(doc: ProseMirrorNode, options: { strictMarkdown?: boolean; tightLists?: boolean } = {}): string {
  return `${String(doc.attrs.frontMatterPrefix ?? '')}${tableMarkdownSerializer.serialize(doc, options)}`;
}

interface MarkdownSelectionExtraction {
  nodes: ProseMirrorNode[];
  fallbackToPlainText: boolean;
}
const topBlocksByDoc = new WeakMap<
  ProseMirrorNode,
  Array<{ node: ProseMirrorNode; offset: number }>
>();

/** 内容修订建立索引时预热；选区查询只查找命中的顶层块。 */
export function prepareMarkdownSelection(doc: ProseMirrorNode): void {
  if (topBlocksByDoc.has(doc)) return;
  const blocks: Array<{ node: ProseMirrorNode; offset: number }> = [];
  doc.forEach((node, offset) => blocks.push({ node, offset }));
  topBlocksByDoc.set(doc, blocks);
}

/**
 * 将语义编辑器选区转换为可独立粘贴的 Markdown。
 *
 * 完整覆盖块的可见内容时保留块结构；只覆盖块的一部分时去掉未完整选择的外层语法，
 * 六类行内格式保留实际选中的原文。局部表格无法合成完整表头，调用方只输出其文本内容。
 */
export function serializeMarkdownSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  options: { strictMarkdown?: boolean; tightLists?: boolean } = {},
): string | null {
  const selected = extractMarkdownSelection(doc, from, to);
  const serializationOptions = { ...options, clipboard: true };
  return selected ? serializeMarkdown(selected, serializationOptions) : null;
}

/** 使用相同序列化规则计量，不构建大选区的整段 Markdown 字符串。 */
export function measureMarkdownSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { chars: number; lines: number } | null {
  const selected = extractMarkdownSelection(doc, from, to);
  if (!selected) return null;
  type OutputState = MarkdownSerializerState & { out: string };
  // prosemirror-markdown 的状态构造器与 out 是内部 API；现有规则已使用内部 flushClose。
  const State = MarkdownSerializerState as unknown as new (
    nodes: MarkdownSerializer['nodes'],
    marks: MarkdownSerializer['marks'],
    options: MarkdownSerializerState['options'],
  ) => OutputState;
  const state = new State(tableMarkdownSerializer.nodes, tableMarkdownSerializer.marks, {
    ...tableMarkdownSerializer.options,
  });
  let chars = 0,
    breaks = 0,
    previousCR = false;
  const consume = (text: string) => {
    if (!text) return;
    chars += text.length;
    breaks +=
      (text.match(/\r\n|\r|\n/g) ?? []).length - (previousCR && text.startsWith('\n') ? 1 : 0);
    previousCR = text.endsWith('\r');
  };
  consume(String(selected.attrs.frontMatterPrefix ?? ''));
  selected.forEach((node, _offset, index) => {
    state.render(node, selected, index);
    // 规则只检查输出尾部的换行，以及链接前的 !／\\!。保留两个字符和 closed 状态，
    // 后续块的分隔语义不变；atBlank 等规则不会反复扫描已经输出的所有块。
    if (state.out.length > 2) {
      consume(state.out.slice(0, -2));
      state.out = state.out.slice(-2);
    }
  });
  consume(state.out);
  return { chars, lines: breaks + 1 };
}

/** A greater-than sign needs no escape within ordinary prose; keep code and quote boundaries. */
function minimizeClipboardGreaterThanEscapes(source: string): string {
  const code = analyzeInlineSourceText(source).spans.filter((span) => span.type === 'code');
  return source.replace(/(\\+)>/g, (match, slashes: string, offset: number) => {
    if (slashes.length % 2 === 0 || code.some((span) => offset >= span.openFrom && offset < span.closeTo)) return match;
    const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
    if (/^ {0,3}$/.test(source.slice(lineStart, offset))) return match;
    return slashes.slice(1) + '>';
  });
}

function extractMarkdownSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): ProseMirrorNode | null {
  if (from < 0 || to > doc.content.size || from >= to) {
    return null;
  }

  const listTextblock = extractSingleListTextblockSelection(doc, from, to);
  if (listTextblock) {
    return schema.nodes.doc.create(null, listTextblock);
  }

  const extraction: MarkdownSelectionExtraction = {
    nodes: [],
    fallbackToPlainText: false,
  };
  prepareMarkdownSelection(doc);
  const blocks = topBlocksByDoc.get(doc)!;
  let lo = 0,
    hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (blocks[mid].offset + blocks[mid].node.nodeSize <= from) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < blocks.length && blocks[i].offset < to; i++) {
    appendSelectedMarkdownNodes(extraction, blocks[i].node, blocks[i].offset, from, to);
  }

  if (extraction.fallbackToPlainText || extraction.nodes.length === 0) {
    return null;
  }

  return schema.nodes.doc.create(null, extraction.nodes);
}

/**
 * 列表序号和项目符号属于外层列表结构，不是正文里的可选字符。
 * 当选区始终位于同一个列表正文块时，只复制该正文块，避免完整选中文字后补回未选中的列表标记。
 */
function extractSingleListTextblockSelection(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): ProseMirrorNode | null {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  if (!$from.sameParent($to) || !$from.parent.isTextblock || !isInsideListItem($from)) {
    return null;
  }

  const textblock = $from.parent;
  const contentFrom = $from.start($from.depth);
  const contentTo = $from.end($from.depth);
  if (from <= contentFrom && to >= contentTo) {
    return textblock;
  }

  const localFrom = Math.max(0, from - contentFrom);
  const localTo = Math.min(textblock.content.size, to - contentFrom);
  if (localFrom >= localTo) {
    return null;
  }

  return schema.nodes.paragraph.create(null, textblock.content.cut(localFrom, localTo));
}

function isInsideListItem($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth - 1; depth > 0; depth -= 1) {
    if ($pos.node(depth).type === schema.nodes.list_item) {
      return true;
    }
  }
  return false;
}

function appendSelectedMarkdownNodes(
  extraction: MarkdownSelectionExtraction,
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  if (!selectionIntersectsNode(node, pos, from, to)) {
    return;
  }

  const fullySelected = selectionCoversVisibleNodeContent(node, pos, from, to);
  if (node.type === schema.nodes.table) {
    if (fullySelected) {
      extraction.nodes.push(node);
    } else {
      extraction.fallbackToPlainText = true;
    }
    return;
  }

  if (fullySelected) {
    extraction.nodes.push(node);
    return;
  }

  if (node.isTextblock) {
    appendPartialTextblock(extraction, node, pos, from, to);
    return;
  }

  if (node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list) {
    appendPartialList(extraction, node, pos, from, to);
    return;
  }

  node.forEach((child, offset) => {
    appendSelectedMarkdownNodes(extraction, child, pos + 1 + offset, from, to);
  });
}

function appendPartialTextblock(
  extraction: MarkdownSelectionExtraction,
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  const contentFrom = pos + 1;
  const localFrom = Math.max(0, from - contentFrom);
  const localTo = Math.min(node.content.size, to - contentFrom);
  if (localFrom >= localTo) {
    return;
  }

  extraction.nodes.push(schema.nodes.paragraph.create(null, node.content.cut(localFrom, localTo)));
}

function appendPartialList(
  extraction: MarkdownSelectionExtraction,
  list: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  let selectedItems: ProseMirrorNode[] = [];
  let selectedItemsStartIndex = 0;

  const flushSelectedItems = () => {
    if (selectedItems.length === 0) {
      return;
    }

    const attrs =
      list.type === schema.nodes.ordered_list
        ? {
            ...list.attrs,
            order: Number(list.attrs.order ?? 1) + selectedItemsStartIndex,
          }
        : list.attrs;
    extraction.nodes.push(list.type.create(attrs, selectedItems));
    selectedItems = [];
  };

  list.forEach((item, offset, index) => {
    const itemPos = pos + 1 + offset;
    if (!selectionIntersectsNode(item, itemPos, from, to)) {
      return;
    }

    if (selectionCoversVisibleNodeContent(item, itemPos, from, to)) {
      if (selectedItems.length === 0) {
        selectedItemsStartIndex = index;
      }
      selectedItems.push(item);
      return;
    }

    flushSelectedItems();
    appendSelectedMarkdownNodes(extraction, item, itemPos, from, to);
  });

  flushSelectedItems();
}

function selectionIntersectsNode(node: ProseMirrorNode, pos: number, from: number, to: number) {
  return from < pos + node.nodeSize && to > pos;
}

function selectionCoversVisibleNodeContent(
  node: ProseMirrorNode,
  pos: number,
  from: number,
  to: number,
) {
  const bounds = getVisibleNodeContentBounds(node, pos);
  return from <= bounds.from && to >= bounds.to;
}

function getVisibleNodeContentBounds(
  node: ProseMirrorNode,
  pos: number,
): { from: number; to: number } {
  if (node.isTextblock) {
    return {
      from: pos + 1,
      to: pos + 1 + node.content.size,
    };
  }

  if (node.isLeaf || node.childCount === 0) {
    return {
      from: pos,
      to: pos + node.nodeSize,
    };
  }

  const firstChild = node.child(0);
  const lastChild = node.child(node.childCount - 1);
  const firstBounds = getVisibleNodeContentBounds(firstChild, pos + 1);
  const lastChildPos = pos + 1 + node.content.size - lastChild.nodeSize;
  const lastBounds = getVisibleNodeContentBounds(lastChild, lastChildPos);
  return {
    from: firstBounds.from,
    to: lastBounds.to,
  };
}

function flushPendingClosedBlock(state: unknown): void {
  (state as { flushClose(): void }).flushClose();
}

function serializeTable(table: ProseMirrorNode, strictMarkdown = false): string {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  if (rows.length === 0) return '';
  const preserved = preserveTableSource(table, (cell) => serializeTableCell(cell, strictMarkdown));
  if (preserved !== null) return preserved;
  // Never silently rewrite Markdown source into a semantic HTML table.
  if (!isMarkdownTable(table)) throw new UnsupportedMarkdownTableError();

  const columnCount = Math.max(...rows.map((row) => row.childCount));
  const serializedRows = rows.map((row) => serializeTableRow(row, columnCount, strictMarkdown));
  const alignments = Array.from({ length: columnCount }, (_, index) =>
    readColumnAlignment(rows, index),
  );
  const separator = alignments.map((align) => {
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return ':---';
  });

  return [serializedRows[0], separator, ...serializedRows.slice(1)]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
}

function serializeTableRow(row: ProseMirrorNode, columnCount: number, strictMarkdown: boolean): string[] {
  const cells: string[] = [];
  row.forEach((cell) => cells.push(serializeTableCell(cell, strictMarkdown)));
  while (cells.length < columnCount) cells.push('');
  return cells;
}

function serializeTableCell(cell: ProseMirrorNode, strictMarkdown = false): string {
  // 表格分隔符只在最终输出时转义，不能删除正文或代码中的反斜杠。
  const options = { tightLists: false, strictMarkdown };
  const source = tableCellMarkdownSerializer.serialize(cell, options).replace(/\n/g, ' ');
  const code = analyzeInlineSourceText(source).spans.filter((span) => span.type === 'code');
  return source.replace(/(\\*)\|/g, (_match, slashes: string, offset: number) => {
    const pipe = offset + slashes.length;
    const inCode = code.some((span) => pipe >= span.openFrom && pipe < span.closeTo);
    return (slashes.length % 2 === 1 && !inCode ? slashes.slice(1) : slashes) + '\\|';
  }).trim();
}

function splitTaskParagraph(
  node: ProseMirrorNode,
): { marker: string; content: ProseMirrorNode } | null {
  const firstChild = node.firstChild;
  const marker = readTaskListMarker(node);
  if (!marker || !firstChild) return null;

  const children: ProseMirrorNode[] = [];
  const restText = (firstChild.text ?? '').slice(marker.text.length);
  if (restText) children.push(node.type.schema.text(restText, firstChild.marks));
  for (let index = 1; index < node.childCount; index++) {
    children.push(node.child(index));
  }

  return {
    marker: marker.text.endsWith(' ') ? marker.text : `${marker.text} `,
    content: node.type.create(node.attrs, Fragment.fromArray(children), node.marks),
  };
}


function renderParagraphInline(state: MarkdownSerializerState, node: ProseMirrorNode): void {
  // 先输出容器的列表/引用前缀，只保护段落正文，不能把真实容器语法转成字面文本。
  state.write();
  const output = state as unknown as { out: string; delim: string };
  const from = output.out.length;
  const syntaxRanges: Array<{ from: number; to: number }> = [];
  paragraphSyntaxRanges.set(state, syntaxRanges);
  try {
    state.renderInline(node);
  } finally {
    // out 修正后旧绝对坐标失效；范围只属于这一段，不能影响之后的图片或段落。
    paragraphSyntaxRanges.delete(state);
  }
  const source = output.out.slice(from);
  for (const span of analyzeInlineSourceText(source).spans) {
    if (span.type === 'code') syntaxRanges.push({ from: from + span.openFrom, to: from + span.closeTo });
  }
  let offset = from;
  const content = source.split('\n').map((line, index) => {
    const prefix = index > 0 && line.startsWith(output.delim) ? output.delim : '';
    const body = line.slice(prefix.length);
    const start = offset + prefix.length;
    offset += line.length + 1;
    if (syntaxRanges.some((range) => start >= range.from && start < range.to)) return line;
    // Markdown 会裁掉段首空白或把四列缩进解释为代码；实体保留真实空格与 Tab。
    const indentation = /^[ \t]+(?=\S)/.exec(body)?.[0];
    if (indentation) {
      const literalIndentation = indentation.replace(/ /g, '&#32;').replace(/\t/g, '&#9;');
      return prefix + literalIndentation + body.slice(indentation.length);
    }
    return prefix + escapeMarkdownBlockStart(body);
  }).join('\n');
  output.out = output.out.slice(0, from) + escapeLiteralBlockSyntax(content);
}

function escapeMarkdownBlockStart(text: string): string {
  return text.replace(
    /^(\s{0,3})(#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|`{3,}(?=[^`]*$)|~{3,}|(?:[-*_]\s*){3,}$|=+\s*$)/,
    (_match, indentation: string, marker: string) =>
      /^\d+[.)]/.test(marker)
        ? `${indentation}${marker.replace(/[.)]/, '\\$&')}`
        : `${indentation}\\${marker}`,
  );
}

function containsLiteralDisplayMathSyntax(parent: ProseMirrorNode): boolean {
  if (!parent.isTextblock || parent.type === schema.nodes.code_block) return false;
  const text = parent.textBetween(0, parent.content.size, '\n', '\n').trim();
  return /^\$\$[\s\S]*\$\$$/.test(text) && text.length > 2;
}

function readColumnAlignment(
  rows: ProseMirrorNode[],
  columnIndex: number,
): TableColumnAlignment | null {
  for (const row of rows) {
    if (columnIndex >= row.childCount) continue;
    const cell = row.child(columnIndex);
    const align = cell?.attrs.align;
    if (align === 'left' || align === 'center' || align === 'right') return align;
  }
  return null;
}

function serializeMarkdownComment(content: string, block: boolean): string {
  const safeContent = content.replace(/-->/g, '-- >').replace(/\r\n/g, '\n');
  if (block) {
    return `<!--\n${safeContent}\n-->`;
  }

  return safeContent ? `<!-- ${safeContent} -->` : '<!---->';
}

function serializeHtmlInlineComment(content: string): string {
  const safeContent = content.replace(/-->/g, '-- >').replace(/\r\n/g, '\n');
  const attribute = escapeHtmlAttr(safeContent).replace(/\|/g, '&#124;');
  return `<span class="comment-inline" data-comment="${attribute}"></span>`;
}

export function serializeClipboardText(slice: Slice, preserveInlineSource = false): string {
  let text = '';
  let hasBlock = false;
  let previousBlockWasEmptyParagraph = false;

  const inline = slice.content.firstChild?.isInline === true;
  const input = schema.nodes.doc.create(null, inline
    ? schema.nodes.paragraph.create(null, slice.content) : slice.content);
  const projected = preserveInlineSource ? input : projectInlineSource(input);
  const content = inline ? projected.firstChild!.content : projected.content;
  content.nodesBetween(0, content.size, (node) => {
    const nodeText = node.isText
      ? (node.text ?? '')
      : node.type.name === 'hard_break'
        ? '\n'
        : node.isLeaf
          ? (node.type.spec.leafText?.(node) ?? '')
          : '';

    if (node.isBlock && ((node.isLeaf && nodeText) || node.isTextblock)) {
      if (hasBlock) {
        text += previousBlockWasEmptyParagraph ? '\n' : '\n\n';
      }
      hasBlock = true;
      previousBlockWasEmptyParagraph =
        node.type === schema.nodes.paragraph && node.content.size === 0;
    }

    text += nodeText;
  });

  return text;
}
