/**
 * Routine helpers the screens share: reading the form, and showing days and times the way
 * people say them. Times are Korea time, as the server schedules them.
 */
import { MAX_ROUTINE_NAME, MAX_ROUTINE_PROMPT, type RoutineDraft } from './agent.ts'

export const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'] as const
export const EVERY_DAY = 0b111_1111
export const WEEKDAYS = 0b001_1111
export const WEEKEND = 0b110_0000

const KST = 9 * 3600_000
// No control characters except line breaks and tabs in the prompt (the server checks the same).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function describeDays(days: number): string {
  if (days === EVERY_DAY) return '매일'
  if (days === WEEKDAYS) return '평일'
  if (days === WEEKEND) return '주말'
  return DAY_NAMES.filter((_, i) => days & (1 << i)).join(' ')
}

export function formatMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** `HH:MM` (what `<input type=time>` gives) as minutes after midnight, or null. */
export function parseTime(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** A moment as Korea time, e.g. `10/10(금) 09:30`. */
export function formatWhen(ms: number): string {
  const d = new Date(ms + KST)
  const day = DAY_NAMES[(d.getUTCDay() + 6) % 7]
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${day}) ${formatMinute(d.getUTCHours() * 60 + d.getUTCMinutes())}`
}

/** What is wrong with a draft, or null when the server will take it. */
export function draftProblem(d: RoutineDraft): string | null {
  const name = d.name.trim()
  const prompt = d.prompt.trim()
  if (![...name].length || [...name].length > MAX_ROUTINE_NAME || NAME_CONTROL.test(name)) {
    return `이름은 한 줄로 1~${MAX_ROUTINE_NAME}자로 써 주세요.`
  }
  if (![...prompt].length || [...prompt].length > MAX_ROUTINE_PROMPT || CONTROL.test(prompt)) {
    return `할 일은 1~${MAX_ROUTINE_PROMPT.toLocaleString('ko-KR')}자로 써 주세요.`
  }
  if (!Number.isInteger(d.days) || d.days < 1 || d.days > EVERY_DAY) return '요일을 하나 이상 골라 주세요.'
  if (!Number.isInteger(d.minute) || d.minute < 0 || d.minute > 1439) return '시각을 정해 주세요.'
  return null
}
