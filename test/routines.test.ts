import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeDays, draftProblem, formatMinute, formatWhen, parseTime } from '../src/routines.ts'

test('days and times read the way people say them', () => {
  assert.equal(describeDays(0b111_1111), '매일')
  assert.equal(describeDays(0b001_1111), '평일')
  assert.equal(describeDays(0b110_0000), '주말')
  assert.equal(describeDays(0b001_0101), '월 수 금')
  assert.equal(formatMinute(0), '00:00')
  assert.equal(formatMinute(570), '09:30')
  assert.equal(parseTime('09:30'), 570)
  assert.equal(parseTime('23:59'), 1439)
  for (const bad of ['24:00', '9:30', '09:60', '', '09:30:00']) assert.equal(parseTime(bad), null, bad)
  // 2026-10-10 09:30 in Korea, a Saturday, whatever the machine's time zone.
  assert.equal(formatWhen(Date.UTC(2026, 9, 10, 0, 30)), '10/10(토) 09:30')
})

test('drafts are checked like the server checks them', () => {
  const ok = { name: '아침 뉴스', prompt: '오늘 뉴스 세 줄로\n\t정리', days: 1, minute: 0, enabled: true }
  assert.equal(draftProblem(ok), null)
  for (const bad of [
    { ...ok, name: '  ' }, { ...ok, name: '가'.repeat(41) }, { ...ok, name: '줄\n바꿈' },
    { ...ok, prompt: '' }, { ...ok, prompt: '가'.repeat(2001) }, { ...ok, prompt: 'a\u0007b' },
    { ...ok, days: 0 }, { ...ok, days: 128 }, { ...ok, minute: 1440 }, { ...ok, minute: 1.5 },
  ]) {
    assert.notEqual(draftProblem(bad), null, JSON.stringify(bad))
  }
  assert.equal(draftProblem({ ...ok, name: '가'.repeat(40), prompt: '😀'.repeat(2000) }), null)
})
