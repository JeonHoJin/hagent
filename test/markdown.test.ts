import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inline, parse, type Block, type Inline } from '../src/markdown.ts'

const txt = (text: string): Inline => ({ t: 'text', text })
const p = (...kids: Inline[]): Block => ({ t: 'p', kids })

/** Every href anywhere in the tree. */
function hrefs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(hrefs)
  if (!node || typeof node !== 'object') return []
  const own = 'href' in node ? [String(node.href)] : []
  return [...own, ...Object.values(node).flatMap(hrefs)]
}

test('headings, paragraphs and line breaks', () => {
  assert.deepEqual(parse('## 요약 ##\n첫 줄\n둘째 줄\n\n다음 문단'), [
    { t: 'h', level: 2, kids: [txt('요약')] },
    p(txt('첫 줄'), { t: 'br' }, txt('둘째 줄')),
    p(txt('다음 문단')),
  ])
  assert.deepEqual(parse('#해시태그'), [p(txt('#해시태그'))])
})

test('inline marks, including Korean right after a closer', () => {
  assert.deepEqual(inline('**굵게**입니다, *기울임*, ~~취소~~, `a*b*c`'), [
    { t: 'strong', kids: [txt('굵게')] }, txt('입니다, '),
    { t: 'em', kids: [txt('기울임')] }, txt(', '),
    { t: 'del', kids: [txt('취소')] }, txt(', '),
    { t: 'code', text: 'a*b*c' },
  ])
  assert.deepEqual(inline('*a **b** c*'), [{ t: 'em', kids: [txt('a '), { t: 'strong', kids: [txt('b')] }, txt(' c')] }])
  assert.deepEqual(inline('snake_case_name and 2 * 3 * 4'), [txt('snake_case_name and 2 * 3 * 4')])
  assert.deepEqual(inline('\\*literal\\*'), [txt('*literal*')])
})

test('lists nest by indentation and keep their numbering', () => {
  assert.deepEqual(parse('3. 셋\n   - 가\n   - 나\n4. 넷'), [{
    t: 'list', ordered: true, start: 3, items: [
      [p(txt('셋')), { t: 'list', ordered: false, start: 1, items: [[p(txt('가'))], [p(txt('나'))]] }],
      [p(txt('넷'))],
    ],
  }])
  // A list can follow a sentence directly; a date in a sentence stays text.
  assert.deepEqual(parse('정리:\n- a\n- b').map(b => b.t), ['p', 'list'])
  assert.deepEqual(parse('회의는\n2024. 10. 9.에 열려요'), [p(txt('회의는'), { t: 'br' }, txt('2024. 10. 9.에 열려요'))])
})

test('fenced code keeps its text, even while still streaming', () => {
  assert.deepEqual(parse('```py\nif a < b:\n    print("<b>")\n```\n끝'), [
    { t: 'pre', text: 'if a < b:\n    print("<b>")' }, p(txt('끝')),
  ])
  assert.deepEqual(parse('```\nhalf'), [{ t: 'pre', text: 'half' }])
})

test('tables, quotes and rules', () => {
  assert.deepEqual(parse('| 이름 | 값 |\n|:--|--:|\n| a | **1** |\n| b |'), [{
    t: 'table', align: ['left', 'right'],
    head: [[txt('이름')], [txt('값')]],
    rows: [[[txt('a')], [{ t: 'strong', kids: [txt('1')] }]], [[txt('b')], []]],
  }])
  assert.deepEqual(parse('> 인용\n> 둘째\n\n---'), [
    { t: 'quote', kids: [p(txt('인용'), { t: 'br' }, txt('둘째'))] }, { t: 'hr' },
  ])
  assert.deepEqual(parse('a | b').map(b => b.t), ['p'])
})

test('links: only https opens, everything else stays visible text', () => {
  assert.deepEqual(inline('[문서](https://example.com/a_(b)) 와 https://example.org.'), [
    { t: 'link', href: 'https://example.com/a_(b)', kids: [txt('문서')] },
    txt(' 와 '),
    { t: 'link', href: 'https://example.org/', kids: [txt('https://example.org')] },
    txt('.'),
  ])
  assert.deepEqual(inline('[클릭](javascript:alert(1))'), [txt('클릭'), txt(' (javascript:alert(1))')])
  assert.deepEqual(inline('![그림](https://example.com/x.png)'),
    [{ t: 'link', href: 'https://example.com/x.png', kids: [txt('그림')] }])
  // A link inside a link label doesn't nest.
  assert.deepEqual(hrefs(inline('[see https://a.example](https://b.example)')), ['https://b.example/'])
  for (const s of ['[x](http://example.com)', '[x](data:text/html,hi)', '<a href="https://e.com">x</a>', '[x](//e.com)']) {
    assert.ok(hrefs(parse(s)).every(h => h.startsWith('https://')), s)
  }
})

test('HTML stays text', () => {
  assert.deepEqual(parse('<img src=x onerror=alert(1)><br>다음'), [p(txt('<img src=x onerror=alert(1)>'), { t: 'br' }, txt('다음'))])
})

test('hostile text is read quickly and nesting is capped', () => {
  const inputs = [
    '*'.repeat(40_000), '*a '.repeat(15_000), '['.repeat(40_000) + '](', '[a]('.repeat(10_000),
    '`'.repeat(20_000) + 'x', '`a ``b '.repeat(6_000), '_a '.repeat(15_000), '> '.repeat(20_000) + 'x',
    '- '.repeat(20_000) + 'x', Array.from({ length: 2_000 }, (_, k) => ' '.repeat(k % 40) + '- x').join('\n'),
    '**a '.repeat(10_000) + '**'.repeat(10_000), '| a '.repeat(5_000) + '\n' + '|-'.repeat(5_000),
  ]
  for (const s of inputs) {
    const start = performance.now()
    parse(s)
    assert.ok(performance.now() - start < 1_000, `${s.slice(0, 12)}… took too long`)
  }
  let depth = 0
  let node: unknown = parse('> '.repeat(50) + 'deep')
  while (Array.isArray(node) && (node[0] as Block | undefined)?.t === 'quote') {
    depth++
    node = (node[0] as { kids: Block[] }).kids
  }
  assert.ok(depth <= 8)
})
