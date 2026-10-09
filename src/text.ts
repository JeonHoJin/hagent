/**
 * Splits agent text into plain runs and links. Only well-formed https URLs without
 * credentials become links; everything else stays text, and the page renders all of it with
 * textContent, never as HTML.
 */

export interface Segment { text: string; href?: string }

const URLISH = /https:\/\/[^\s<>"'`]+/g
const URL_AT = /https:\/\/[^\s<>"'`]+/y
/** Punctuation that usually ends a sentence rather than the URL. */
const TRAILING = /[.,;:!?)\]}'"」』】]+$/

export function safeHref(candidate: string): string | undefined {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** The safe https link starting exactly at `at`, if there is one. */
export function linkAt(text: string, at: number): { text: string; href: string; end: number } | undefined {
  URL_AT.lastIndex = at
  const match = URL_AT.exec(text)
  if (!match) return undefined
  const url = match[0].replace(TRAILING, '')
  const href = safeHref(url)
  return href ? { text: url, href, end: at + url.length } : undefined
}

export function segments(text: string): Segment[] {
  const out: Segment[] = []
  const push = (s: Segment) => {
    if (!s.text) return
    const last = out[out.length - 1]
    if (last && !last.href && !s.href) last.text += s.text
    else out.push(s)
  }
  let at = 0
  for (const match of text.matchAll(URLISH)) {
    const start = match.index
    const raw = match[0]
    const url = raw.replace(TRAILING, '')
    const href = safeHref(url)
    push({ text: text.slice(at, start) })
    if (href) {
      push({ text: url, href })
      push({ text: raw.slice(url.length) })
    } else {
      push({ text: raw })
    }
    at = start + raw.length
  }
  push({ text: text.slice(at) })
  return out
}
