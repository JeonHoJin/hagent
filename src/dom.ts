/** Builds DOM from data with text only: no HTML strings anywhere in the app. */
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

/** Agent text with https links made clickable; the rest stays plain text. */
export function richText(target: HTMLElement, text: string): void {
  target.replaceChildren(...segments(text).map(s => s.href
    ? el('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, s.text)
    : document.createTextNode(s.text)))
}
