import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segments } from '../src/text.ts'

test('https URLs become links and the rest stays text', () => {
  assert.deepEqual(segments('출처: https://opensource.apple.com/projects/container/. 끝'), [
    { text: '출처: ' },
    { text: 'https://opensource.apple.com/projects/container/', href: 'https://opensource.apple.com/projects/container/' },
    { text: '. 끝' },
  ])
  assert.deepEqual(segments('(https://example.com/a)'), [
    { text: '(' }, { text: 'https://example.com/a', href: 'https://example.com/a' }, { text: ')' },
  ])
})

test('nothing else becomes a link', () => {
  for (const text of [
    'javascript:alert(1)', 'http://example.com', 'data:text/html,<b>x</b>',
    'https://user:pw@example.com/', 'see https:/broken', '<a href="https://x.com">x</a>'.replace('https://x.com', 'javascript:x'),
  ]) {
    assert.ok(segments(text).every(s => !s.href), text)
  }
  assert.deepEqual(segments(''), [])
})
