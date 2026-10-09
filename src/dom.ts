/** Builds DOM from data with text only: no HTML strings anywhere in the app. */
import { parse, type Align, type Block, type Inline } from './markdown.ts'
import { segments } from './text.ts'

type Props = Record<string, string | boolean | ((e: Event) => void)>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Props = {}, ...kids: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === 'function') node.addEventListener(key.replace(/^on/, ''), value)
    else if (value === true) node.setAttribute(key, '')
    else if (value !== false) node.setAttribute(key, value)
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) node.append(kid)
  return node
}

const link = (href: string, ...kids: Array<Node | string>) =>
  el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, ...kids)

/** Plain text with https links made clickable (the user's own messages). */
export function richText(target: HTMLElement, text: string): void {
  target.replaceChildren(...segments(text).map(s => s.href ? link(s.href, s.text) : document.createTextNode(s.text)))
}

/** Agent text read as Markdown (see markdown.ts) and built from elements and text nodes. */
export function markdown(target: HTMLElement, text: string): void {
  target.replaceChildren(...parse(text).map(block))
}

function inlineNode(n: Inline): Node {
  switch (n.t) {
    case 'text': return document.createTextNode(n.text)
    case 'br': return el('br')
    case 'code': return el('code', {}, n.text)
    case 'link': return link(n.href, ...n.kids.map(inlineNode))
    default: return el(n.t, {}, ...n.kids.map(inlineNode))
  }
}

const cell = (tag: 'th' | 'td', align: Align | undefined, kids: Inline[]) =>
  el(tag, align ? { class: align } : {}, ...kids.map(inlineNode))

function block(b: Block): Node {
  switch (b.t) {
    case 'p': return el('p', {}, ...b.kids.map(inlineNode))
    case 'h': return el(`h${b.level}` as 'h1', {}, ...b.kids.map(inlineNode))
    case 'pre': return el('pre', {}, el('code', {}, b.text))
    case 'quote': return el('blockquote', {}, ...b.kids.map(block))
    case 'hr': return el('hr')
    case 'list': {
      const items = b.items.map(item => el('li', {}, ...item.map(block)))
      return b.ordered ? el('ol', b.start === 1 ? {} : { start: String(b.start) }, ...items) : el('ul', {}, ...items)
    }
    case 'table': return el('div', { class: 'table' }, el('table', {},
      el('thead', {}, el('tr', {}, ...b.head.map((c, k) => cell('th', b.align[k], c)))),
      el('tbody', {}, ...b.rows.map(row => el('tr', {}, ...row.map((c, k) => cell('td', b.align[k], c)))))))
  }
}
