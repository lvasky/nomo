import { Schema, type DOMOutputSpec } from 'prosemirror-model';
import { schema as markdownSchema } from 'prosemirror-markdown';
import { tableNodes } from 'prosemirror-tables';
import { calloutNodeSpec } from './callout/calloutSchema';
import { detailsNodes } from './details/detailsSchema';
import { createLinkAttrs } from './link';
import { createHtmlAnchorAttrs } from './html/htmlAnchor';
import { t } from '../../app/i18n';

export type TableColumnAlignment = 'left' | 'center' | 'right';

const markdownImageNodeSpec = markdownSchema.spec.nodes.get('image')!;
const markdownHardBreakNodeSpec = markdownSchema.spec.nodes.get('hard_break')!;
const markdownDocNodeSpec = markdownSchema.spec.nodes.get('doc')!;
const docNodeSpec = {
  ...markdownDocNodeSpec,
  attrs: {
    ...(markdownDocNodeSpec.attrs ?? {}),
    /** 文档开头的 Front Matter 及其与正文之间的原始分隔。 */
    frontMatterPrefix: { default: '' },
  },
};
const hardBreakNodeSpec = {
  ...markdownHardBreakNodeSpec,
  attrs: {
    ...(markdownHardBreakNodeSpec.attrs ?? {}),
    /** true 表示源码里的普通单换行；视觉换行但保存回普通换行。 */
    soft: { default: false },
  },
  parseDOM: [
    {
      tag: 'br',
      getAttrs: (dom: HTMLElement) => ({ soft: dom.dataset.nomoBreak === 'soft' }),
    },
  ],
  toDOM(node: import('prosemirror-model').Node): DOMOutputSpec {
    return ['br', { 'data-nomo-break': node.attrs.soft ? 'soft' : 'hard' }];
  },
};
const imageNodeSpec = {
  ...markdownImageNodeSpec,
  selectable: false,
  draggable: false,
  attrs: {
    ...(markdownImageNodeSpec.attrs as Record<string, unknown>),
    /** 图片对齐方式：null=跟随段落，left/center/right */
    align: { default: null },
    /** 图片宽度：如 "60%" 或 "600"（px），null=原始尺寸 */
    width: { default: null },
  },
  parseDOM: [
    {
      tag: 'img[src]',
      getAttrs: (dom: HTMLElement) => ({
        src: dom.getAttribute('src'),
        alt: dom.getAttribute('alt'),
        title: dom.getAttribute('title'),
        width: dom.style.width || dom.getAttribute('width'),
        align: readImageAlignment(dom),
      }),
    },
  ],
  toDOM(node: import('prosemirror-model').Node): DOMOutputSpec {
    const { src, alt, title, width, align } = node.attrs;
    const styles: string[] = [];
    if (width) styles.push(`width: ${/^\d+$/.test(width) ? `${width}px` : width}; height: auto`);
    if (align === 'left' || align === 'center' || align === 'right') {
      styles.push(`display: block; margin-left: ${align === 'left' ? '0' : 'auto'}; margin-right: ${align === 'right' ? '0' : 'auto'}`);
    }
    return ['img', { src, alt, title, width, align, style: styles.join('; ') || null }];
  },
};

function readImageAlignment(dom: HTMLElement): TableColumnAlignment | null {
  for (const element of [dom, dom.parentElement]) {
    if (!element) continue;
    const value = element.getAttribute('align') || element.style.textAlign || element.getAttribute('data-align');
    if (value === 'left' || value === 'center' || value === 'right') return value;
    if (element.style.marginLeft === 'auto' && element.style.marginRight === 'auto') return 'center';
    if (element.style.marginLeft === 'auto') return 'right';
    if (element.style.marginRight === 'auto') return 'left';
  }
  return null;
}

function readCellAlignment(dom: HTMLElement): TableColumnAlignment | null {
  const value = dom.style.textAlign || dom.getAttribute('data-align');
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

const tableNodeSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph+',
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: readCellAlignment,
      setDOMAttr(value, attrs) {
        if (value === 'left' || value === 'center' || value === 'right') {
          attrs['data-align'] = value;
          attrs.style = `${attrs.style ? `${attrs.style}; ` : ''}text-align: ${value}`;
        }
      },
    },
  },
});
tableNodeSpecs.table = {
  ...tableNodeSpecs.table,
  // Source-only revision makes explicit formatting undoable without changing cells.
  attrs: { sourceFormatRevision: { default: 0 } },
};

export const schema = new Schema({
  nodes: markdownSchema.spec.nodes
    .update('doc', docNodeSpec)
    .update('heading', {
      ...markdownSchema.spec.nodes.get('heading')!,
      // 标题允许完整行内内容，避免公式、脚注和换行使整个标题无效。
      content: 'inline*',
    })
    .update('hard_break', hardBreakNodeSpec)
    .update('image', imageNodeSpec)
    .update('code_block', {
      ...markdownSchema.spec.nodes.get('code_block')!,
      parseDOM: [{ tag: 'pre', preserveWhitespace: 'full', getAttrs: dom => ({
        params: ((dom as HTMLElement).querySelector('code')?.className ?? '').replace(/^language-/, ''),
      }) }],
      toDOM: node => ['pre', ['code', node.attrs.params ? { class: `language-${String(node.attrs.params).split(/\s+/)[0]}` } : {}, 0]],
    })
    .append(tableNodeSpecs)
    .append({
      /** 空 HTML 锚点没有文本可承载 mark，需作为行内节点保留目标属性。 */
      html_anchor: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: false,
        attrs: {
          href: { default: null },
          title: { default: null },
          id: { default: null },
          name: { default: null },
          html: { default: true },
        },
        parseDOM: [
          {
            tag: 'a',
            // 空节点规则先于 link mark，避免粘贴时没有文本承载的锚点被丢掉。
            priority: 60,
            getAttrs(dom) {
              const el = dom as HTMLElement;
              if (el.childNodes.length) return false;
              return createHtmlAnchorAttrs(
                el.getAttribute('href'),
                el.getAttribute('title'),
                el.getAttribute('id'),
                el.getAttribute('name'),
              ) ?? false;
            },
          },
        ],
        toDOM(node) {
          const attrs: Record<string, string> = {};
          const link = createLinkAttrs(node.attrs.href, node.attrs.title);
          if (link) attrs.href = link.href;
          for (const key of ['title', 'id', 'name']) {
            if (node.attrs[key] != null) attrs[key] = String(node.attrs[key]);
          }
          return ['a', attrs];
        },
      },
      math_inline: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        draggable: false,
        attrs: {
          tex: { default: '' },
        },
        toDOM(node) {
          const tex = node.attrs.tex as string;
          return ['span', { class: 'math-inline', 'data-tex': tex }, `$${tex}$`];
        },
        parseDOM: [
          {
            tag: 'span.math-inline',
            getAttrs(dom) {
              const el = dom as HTMLElement;
              const tex = el.getAttribute('data-tex') ?? el.textContent ?? '';
              return { tex: tex.startsWith('$') && tex.endsWith('$') ? tex.slice(1, -1) : tex };
            },
          },
        ],
      },
      html_block: {
        content: 'inline*',
        group: 'block',
        defining: true,
        attrs: {
          tag: { default: 'div' },
          class: { default: null },
          id: { default: null },
        },
        toDOM(node) {
          const { tag, class: cls, id } = node.attrs;
          const domAttrs: Record<string, string> = {};
          if (cls) domAttrs.class = cls;
          if (id) domAttrs.id = id;
          return [tag, domAttrs, 0];
        },
      },
      comment_block: {
        atom: true,
        selectable: true,
        draggable: false,
        group: 'block',
        attrs: {
          content: { default: '' },
        },
        toDOM(node) {
          return [
            'div',
            { class: 'comment-block', 'data-comment': node.attrs.content },
            ['span', { class: 'comment-block-label' }, t.comment()],
            ['span', { class: 'comment-block-preview' }, node.attrs.content || t.fillComment()],
          ];
        },
        parseDOM: [
          {
            tag: 'div.comment-block',
            getAttrs(dom) {
              const el = dom as HTMLElement;
              return { content: el.getAttribute('data-comment') ?? el.textContent ?? '' };
            },
          },
        ],
      },
      comment_inline: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: true,
        draggable: false,
        attrs: {
          content: { default: '' },
        },
        toDOM(node) {
          const content = String(node.attrs.content ?? '');
          return [
            'span',
            { class: 'comment-inline', 'data-comment': content },
            ['span', { class: 'comment-inline-label' }, content || t.emptyComment()],
          ];
        },
        parseDOM: [
          {
            tag: 'span.comment-inline',
            getAttrs(dom) {
              const el = dom as HTMLElement;
              return { content: el.getAttribute('data-comment') ?? '' };
            },
          },
        ],
      },
      footnote_ref: {
        inline: true,
        group: 'inline',
        atom: true,
        selectable: false,
        draggable: false,
        attrs: {
          id: { default: '' },
        },
        toDOM(node) {
          const id = node.attrs.id as string;
          return ['sup', { class: 'footnote-ref', 'data-footnote-id': id }, id];
        },
        parseDOM: [
          {
            tag: 'sup.footnote-ref',
            getAttrs(dom) {
              const el = dom as HTMLElement;
              return { id: el.getAttribute('data-footnote-id') ?? '' };
            },
          },
        ],
      },
      footnote_def: {
        content: 'inline*',
        group: 'block',
        defining: true,
        attrs: {
          id: { default: '' },
        },
        toDOM(node) {
          const id = node.attrs.id as string;
          return [
            'div',
            { class: 'footnote-def', 'data-footnote-id': id },
            ['span', { class: 'footnote-def-marker' }, id],
            ['span', { class: 'footnote-def-content', 'data-placeholder': t.footnoteContentPlaceholder() }, 0],
          ];
        },
        parseDOM: [
          {
            tag: 'div.footnote-def',
            contentElement(dom) {
              // 编号是展示控件，只导入定义正文；无包装的外部 HTML 继续按原规则读取。
              return (dom as HTMLElement).querySelector('.footnote-def-content') ?? dom as HTMLElement;
            },
            getAttrs(dom) {
              const el = dom as HTMLElement;
              return { id: el.getAttribute('data-footnote-id') ?? '' };
            },
          },
        ],
      },
      // 跨行公式块（display math）：$$...$$ 语法
      callout: calloutNodeSpec,
      ...detailsNodes,
      toc_block: {
        atom: true,
        selectable: true,
        draggable: false,
        group: 'block',
        attrs: {
          content: { default: '' },
        },
        toDOM(node) {
          return ['div', { class: 'toc-block', 'data-content': node.attrs.content }, t.toc()];
        },
      },
      math_block: {
        atom: true,
        selectable: true,
        draggable: false,
        group: 'block',
        attrs: {
          tex: { default: '' },
        },
        toDOM(node) {
          const tex = node.attrs.tex as string;
          return ['div', { class: 'math-block', 'data-tex': tex }, `$$\n${tex}\n$$`];
        },
        parseDOM: [
          {
            tag: 'div.math-block',
            getAttrs(dom) {
              const el = dom as HTMLElement;
              const tex = el.getAttribute('data-tex') ?? el.textContent ?? '';
              return { tex };
            },
          },
        ],
      },
      mermaid_block: {
        atom: true,
        selectable: false,
        draggable: false,
        group: 'block',
        attrs: {
          code: { default: '' },
        },
        toDOM(node) {
          const code = node.attrs.code as string;
          return ['div', { class: 'mermaid-block', 'data-code': code }, code];
        },
        parseDOM: [
          {
            tag: 'div.mermaid-block',
            getAttrs(dom) {
              const el = dom as HTMLElement;
              return { code: el.getAttribute('data-code') ?? el.textContent ?? '' };
            },
          },
        ],
      },
    }),
  marks: markdownSchema.spec.marks
    .update('code', {
      parseDOM: [{ tag: 'code' }],
      toDOM() {
        return ['code', { class: 'inline-code' }, 0];
      },
    })
    .update('link', {
      attrs: {
        href: { default: null },
        title: { default: null },
        id: { default: null },
        name: { default: null },
        html: { default: false },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a',
          getAttrs(dom) {
            const el = dom as HTMLElement;
            if (!el.hasAttribute('href') || el.hasAttribute('id') || el.hasAttribute('name')) {
              return createHtmlAnchorAttrs(
                el.getAttribute('href'),
                el.getAttribute('title'),
                el.getAttribute('id'),
                el.getAttribute('name'),
              ) ?? false;
            }
            return createLinkAttrs(el.getAttribute('href'), el.getAttribute('title')) ?? false;
          },
        },
      ],
      toDOM(mark) {
        const attrs = createLinkAttrs(mark.attrs.href, mark.attrs.title);
        const domAttrs: Record<string, string> = {};
        if (attrs) domAttrs.href = attrs.href;
        if (attrs?.title) {
          domAttrs.title = attrs.title;
        }
        if (mark.attrs.html) {
          for (const key of ['title', 'id', 'name']) {
            if (mark.attrs[key] != null) domAttrs[key] = String(mark.attrs[key]);
          }
        }
        return ['a', domAttrs, 0];
      },
    })
    .append({
      /** 原文载荷标识；格式与定界符显隐由行内源码插件派生。 */
      inline_source: {
        inclusive: true,
        excludes: '',
        attrs: { literal: { default: false } },
        parseDOM: [{ tag: 'span[data-inline-source]' }],
        toDOM() {
          return ['span', { 'data-inline-source': 'true' }, 0];
        },
      },
      strikethrough: {
        parseDOM: [
          { tag: 's' },
          { tag: 'del' },
          { tag: 'strike' },
          { style: 'text-decoration=line-through' },
        ],
        toDOM() {
          return ['s', 0];
        },
      },
      underline: {
        parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
        toDOM() {
          return ['u', 0];
        },
      },
      superscript: {
        excludes: 'subscript',
        parseDOM: [{ tag: 'sup:not(.footnote-ref)' }],
        toDOM() { return ['sup', 0]; },
      },
      subscript: {
        excludes: 'superscript',
        parseDOM: [{ tag: 'sub' }],
        toDOM() { return ['sub', 0]; },
      },
      highlight: {
        parseDOM: [{ tag: 'mark' }],
        toDOM() {
          return ['mark', 0];
        },
      },
    }),
});
