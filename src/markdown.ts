/**
 * A small Markdown reader for agent replies. It turns text into plain data that dom.ts builds
 * with createElement and text nodes, never as HTML: raw HTML stays literal text, images become
 * links, and only https links survive (text.ts decides).
 *
 * It covers what chat models write: headings, paragraphs, fenced code, nested lists, quotes,
 * rules, tables, and inline code, bold, italic, strikethrough and links. Nesting is capped and
 * failed searches are remembered, so hostile text (a web page can steer the agent) can't stall
 * the page. A reply is re-read on every streamed piece, so unfinished markup must read sanely.
 */
import { linkAt, safeHref } from './text.ts'

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'br' }
  | { t: 'strong' | 'em' | 'del'; kids: Inline[] }
  | { t: 'link'; href: string; kids: Inline[] }

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { t: 'p'; kids: Inline[] }
  | { t: 'h'; level: number; kids: Inline[] }
  | { t: 'pre'; text: string }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'quote'; kids: Block[] }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }

/** Deepest nesting of lists, quotes and inline markup; anything deeper reads as text. */
const MAX_DEPTH = 8
/** Longest link address (with its parentheses) the reader looks for. */
const MAX_DEST = 2048

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)/
const QUOTE = /^ {0,3}> ?/
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/
const PUNCT = /^[!-/:-@[-`{-~]$/
const BR_TAG = /<br\s*\/?>/iy
const WORD = /[\p{L}\p{N}]/u

const blank = (line: string) => line.trim() === ''
const indent = (line: string) => line.length - line.replace(/^ +/, '').length

function expandTabs(line: string): string {
  const lead = /^[ \t]+/.exec(line)?.[0]
  if (!lead?.includes('\t')) return line
  let width = 0
  for (const c of lead) width = c === '\t' ? width + 4 - (width % 4) : width + 1
  return ' '.repeat(width) + line.slice(lead.length)
}

export function parse(text: string): Block[] {
  return blocks(text.replace(/\r\n?/g, '\n').split('\n').map(expandTabs), 0)
}

type Read = [Block, number] | null

function blocks(lines: string[], depth: number): Block[] {
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    if (blank(lines[i]!)) { i++; continue }
    const [block, next] = fence(lines, i) ?? heading(lines, i) ?? rule(lines, i) ?? quote(lines, i, depth)
      ?? list(lines, i, depth) ?? table(lines, i) ?? paragraph(lines, i)
    out.push(block)
    i = next
  }
  return out
}

/** Whether line `i` starts a block that ends the paragraph above it. */
function interrupts(lines: string[], i: number): boolean {
  const line = lines[i]!
  if (FENCE.test(line) || HEADING.test(line) || isRule(line) || QUOTE.test(line)) return true
  const item = ITEM.exec(line)
  // An ordered list breaks into a paragraph only from 1, so "2024. 10. 9." in a sentence stays text.
  if (item && !blank(line.slice(item[0].length)) && (item[3] === undefined || item[3] === '1')) return true
  return tableStart(lines, i) !== null
}

function fence(lines: string[], i: number): Read {
  const m = FENCE.exec(lines[i]!)
  if (!m) return null
  const mark = m[1]!
  if (mark[0] === '`' && m[2]!.includes('`')) return null
  const pad = indent(lines[i]!)
  const body: string[] = []
  let j = i + 1
  for (; j < lines.length; j++) {
    const line = lines[j]!
    const rest = line.trim()
    if (indent(line) <= 3 && rest.length >= mark.length && rest.replaceAll(mark[0]!, '') === '') { j++; break }
    body.push(line.slice(Math.min(pad, indent(line))))
  }
  // An unclosed fence runs to the end, which is also how a streaming reply looks mid-block.
  return [{ t: 'pre', text: body.join('\n') }, j]
}

function heading(lines: string[], i: number): Read {
  const line = lines[i]!
  const m = HEADING.exec(line)
  if (!m) return null
  let text = line.slice(m[0].length).trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#') end--
  if (end === 0) text = ''
  else if (end < text.length && text[end - 1] === ' ') text = text.slice(0, end).trimEnd()
  return [{ t: 'h', level: m[1]!.length, kids: inline(text) }, i + 1]
}

function isRule(line: string): boolean {
  if (indent(line) > 3) return false
  const marks = line.replace(/[ \t]/g, '')
  return marks.length >= 3 && /^(?:-+|\*+|_+)$/.test(marks)
}

function rule(lines: string[], i: number): Read {
  return isRule(lines[i]!) ? [{ t: 'hr' }, i + 1] : null
}

function quote(lines: string[], i: number, depth: number): Read {
  if (depth >= MAX_DEPTH || !QUOTE.test(lines[i]!)) return null
  const body: string[] = []
  let j = i
  for (; j < lines.length; j++) {
    const m = QUOTE.exec(lines[j]!)
    if (!m) break
    body.push(lines[j]!.slice(m[0].length))
  }
  return [{ t: 'quote', kids: blocks(body, depth + 1) }, j]
}

function list(lines: string[], i: number, depth: number): Read {
  const first = ITEM.exec(lines[i]!)
  if (depth >= MAX_DEPTH || !first) return null
  const kind = (m: RegExpExecArray) => m[3] === undefined ? m[2]! : m[2]!.slice(-1)
  const ordered = first[3] !== undefined
  const marker = kind(first)
  const base = first[1]!.length
  const items: string[][] = []
  let content = 0
  let afterBlank = false
  let j = i
  for (; j < lines.length; j++) {
    const line = lines[j]!
    if (blank(line)) {
      items.at(-1)!.push('')
      afterBlank = true
      continue
    }
    const at = indent(line)
    const m = ITEM.exec(line)
    if (m && kind(m) === marker && (items.length === 0 || at < content) && !isRule(line)) {
      const rest = line.slice(m[0].length)
      content = blank(rest) ? m[0].length + 1 : m[0].length
      items.push([rest])
    } else if (at > base) {
      items.at(-1)!.push(line.slice(Math.min(at, content)))
    } else if (!afterBlank && !interrupts(lines, j)) {
      items.at(-1)!.push(line.trimStart())
    } else {
      break
    }
    afterBlank = false
  }
  return [{
    t: 'list', ordered, start: ordered ? Number(first[3]) : 1,
    items: items.map(item => blocks(item, depth + 1)),
  }, j]
}

function cells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const out: string[] = []
  let cell = ''
  for (let k = 0; k < row.length; k++) {
    if (row[k] === '\\' && row[k + 1] === '|') { cell += '|'; k++ }
    else if (row[k] === '|') { out.push(cell.trim()); cell = '' }
    else cell += row[k]
  }
  out.push(cell.trim())
  return out
}

/** The column alignments if line `i` is a table's header followed by its divider row. */
function tableStart(lines: string[], i: number): Align[] | null {
  const head = lines[i]!
  const divider = lines[i + 1]
  if (divider === undefined || !head.includes('|') || !divider.includes('|') || !divider.includes('-')) return null
  const align: Align[] = []
  for (const cell of cells(divider)) {
    if (!/^:?-+:?$/.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return cells(head).length === align.length ? align : null
}

function table(lines: string[], i: number): Read {
  const align = tableStart(lines, i)
  if (!align) return null
  const row = (line: string) => {
    const found = cells(line)
    return align.map((_, k) => inline(found[k] ?? ''))
  }
  const rows: Inline[][][] = []
  let j = i + 2
  for (; j < lines.length && !blank(lines[j]!) && lines[j]!.includes('|'); j++) rows.push(row(lines[j]!))
  return [{ t: 'table', align, head: row(lines[i]!), rows }, j]
}

function paragraph(lines: string[], i: number): [Block, number] {
  let j = i + 1
  while (j < lines.length && !blank(lines[j]!) && !interrupts(lines, j)) j++
  // Chat text means its line breaks, so single newlines stay breaks.
  const text = lines.slice(i, j).map(line => line.trim().replace(/\\$/, '')).join('\n')
  return [{ t: 'p', kids: inline(text) }, j]
}

const DELIMITERS = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']] as const

export function inline(s: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ t: 'text', text })
    text = ''
  }
  // Searches that found nothing from some point find nothing from any later point either.
  const noCloser = new Set<string>()
  let nextBracket: number | null = null

  /** Where a delimiter opened at `at` closes, or -1. */
  function closer(d: string, at: number): number {
    if (noCloser.has(d)) return -1
    const single = d.length === 1
    const underscore = d[0] === '_'
    if (!s[at + d.length] || /\s/.test(s[at + d.length]!)) return -1
    if (underscore && at > 0 && WORD.test(s[at - 1]!)) return -1
    for (let k = s.indexOf(d, at + d.length + 1); k !== -1; k = s.indexOf(d, k + 1)) {
      if (/\s/.test(s[k - 1]!)) continue
      if (single && (s[k - 1] === d || s[k + 1] === d)) continue
      if (underscore && s[k + d.length] !== undefined && WORD.test(s[k + d.length]!)) continue
      return k
    }
    noCloser.add(d)
    return -1
  }

  function emphasis(at: number) {
    for (const [d, t] of DELIMITERS) {
      if (!s.startsWith(d, at)) continue
      const end = closer(d, at)
      if (end !== -1) return { d, t, end }
    }
    return null
  }

  /** Where the address after `](` at `from` closes, remembered for the many `[` before one `]`. */
  let parenFrom = -1
  let parenEnd = -1
  function addressEnd(from: number): number {
    if (from === parenFrom) return parenEnd
    let level = 0
    parenFrom = from
    parenEnd = -1
    for (let k = from; k < s.length && k <= from + MAX_DEST; k++) {
      if (s[k] === '(') level++
      else if (s[k] === ')' && --level === 0) { parenEnd = k; break }
    }
    return parenEnd
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === '\\' && s[i + 1] === '\n') { i++; continue }
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1]!)) { text += s[i + 1]; i += 2; continue }
    if (c === '\n') { flush(); out.push({ t: 'br' }); i++; continue }
    if (c === '<') {
      BR_TAG.lastIndex = i
      if (BR_TAG.test(s)) { flush(); out.push({ t: 'br' }); i = BR_TAG.lastIndex; continue }
    }

    if (c === '`') {
      let n = 1
      while (s[i + n] === '`') n++
      const run = '`'.repeat(n)
      let k = noCloser.has(run) ? -1 : s.indexOf(run, i + n)
      while (k !== -1 && s[k + n] === '`') {
        let end = k
        while (s[end] === '`') end++
        k = s.indexOf(run, end)
      }
      if (k === -1) {
        noCloser.add(run)
        text += run
        i += n
        continue
      }
      let code = s.slice(i + n, k).replaceAll('\n', ' ')
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1)
      flush()
      out.push({ t: 'code', text: code })
      i = k + n
      continue
    }

    if (c === 'h' && !inLink) {
      const link = linkAt(s, i)
      if (link) {
        flush()
        out.push({ t: 'link', href: link.href, kids: [{ t: 'text', text: link.text }] })
        i = link.end
        continue
      }
    }

    if (depth < MAX_DEPTH && (c === '[' || (c === '!' && s[i + 1] === '['))) {
      const open = c === '!' ? i + 1 : i
      if (nextBracket === null || (nextBracket !== -1 && nextBracket <= open)) nextBracket = s.indexOf(']', open + 1)
      const close = nextBracket
      if (close !== -1 && s[close + 1] === '(') {
        const end = addressEnd(close + 1)
        if (end !== -1) {
          const label = s.slice(open + 1, close)
          const raw = s.slice(close + 2, end).trim().replace(/^<(.*)>$/, '$1').split(/\s/)[0] ?? ''
          const href = inLink ? undefined : safeHref(raw)
          flush()
          if (href) {
            const kids: Inline[] = c === '!' ? [{ t: 'text', text: label || href }] : inline(label, depth + 1, true)
            out.push({ t: 'link', href, kids: kids.length ? kids : [{ t: 'text', text: href }] })
          } else {
            // Not a link we open: keep the words, show the address as text.
            out.push(...inline(label, depth + 1, true))
            if (raw) out.push({ t: 'text', text: ` (${raw})` })
          }
          i = end + 1
          continue
        }
      }
    }

    if (depth < MAX_DEPTH && (c === '*' || c === '_' || c === '~')) {
      const hit = emphasis(i)
      if (hit) {
        flush()
        out.push({ t: hit.t, kids: inline(s.slice(i + hit.d.length, hit.end), depth + 1, inLink) })
        i = hit.end + hit.d.length
        continue
      }
    }

    text += c
    i++
  }
  flush()
  return out
}
