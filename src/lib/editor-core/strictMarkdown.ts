import { Fragment, Slice, type Node, type Mark } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';
import { schema } from './schema';
import type { EditorCommand } from './types';

const markdownMarks = new Set(['em', 'strong', 'code', 'strikethrough', 'link', 'inline_source']);

export function requiresHtmlCommand(command: EditorCommand): boolean {
  return [
    'toggleUnderline',
    'toggleHighlight',
    'toggleSuperscript',
    'toggleSubscript',
    'insertDetails',
    'insertCommentInline',
    'insertCommentBlock',
    'toggleTableHeader',
  ].includes(command.type);
}

/** Rich clipboard styles are not permission to add HTML to the Markdown source. */
export function strictMarkdownPaste(slice: Slice, tableRowOffset = 0): Slice {
  const clean = (node: Node): Node => {
    const marks: Mark[] = node.marks
      .filter((mark) => markdownMarks.has(mark.type.name))
      .map((mark) =>
        mark.type.name === 'link'
          ? mark.type.create({ ...mark.attrs, html: false, id: null, name: null })
          : mark,
      );
    if (node.isText) return node.mark(marks);
    const children: Node[] = [];
    node.forEach((child) => {
      if (child.type.name === 'html_anchor') return;
      if (child.type.name === 'details') {
        children.push(schema.nodes.paragraph.create(null, clean(child.child(0)).content));
        child.child(1).forEach((block) => children.push(clean(block)));
      } else children.push(clean(child));
    });
    if (node.type.name === 'table') {
      const map = TableMap.get(node);
      const seen = new Set<number>();
      const rows: Node[] = [];
      for (let row = 0; row < map.height; row++) {
        const cells: Node[] = [];
        for (let column = 0; column < map.width; column++) {
          const pos = map.map[row * map.width + column];
          const cell = node.nodeAt(pos)!;
          const content = seen.has(pos)
            ? Fragment.from(schema.nodes.paragraph.create())
            : clean(cell).content;
          seen.add(pos);
          cells.push(
            (row + tableRowOffset === 0
              ? schema.nodes.table_header
              : schema.nodes.table_cell
            ).create({ align: node.firstChild?.maybeChild(column)?.attrs.align ?? null }, content),
          );
        }
        rows.push(schema.nodes.table_row.create(null, cells));
      }
      return node.type.create(null, rows);
    }
    if (node.type.name === 'html_block')
      return schema.nodes.paragraph.create(
        null,
        node.textContent ? schema.text(node.textContent) : undefined,
      );
    const attrs =
      node.type.name === 'image'
        ? { ...node.attrs, width: null, align: null }
        : ['table_cell', 'table_header'].includes(node.type.name)
          ? { ...node.attrs, colspan: 1, rowspan: 1, colwidth: null }
          : node.attrs;
    return node.type.create(attrs, children, marks);
  };
  // Use a document wrapper so unsupported containers can be unwrapped at any depth.
  const content = clean(schema.nodes.doc.create(null, slice.content)).content;
  return Slice.maxOpen(content, false);
}
