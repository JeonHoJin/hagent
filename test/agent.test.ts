import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, AgentError, ApprovalRequired, BadReply, parseHistory, parseProgress, parseRoutines, parseStatus } from '../src/agent.ts'

const JOB = '2e6fa396-5cb2-4038-a272-5116e4df7384'

test('status, progress and history are checked before use', () => {
  assert.deepEqual(parseStatus({ instance: 'running', job: { id: JOB, status: 'queued' } }),
    { instance: 'running', job: { id: JOB, status: 'queued' } })
  assert.deepEqual(parseStatus({ instance: 'stopped', job: null }), { instance: 'stopped', job: null })
  for (const bad of [null, {}, { instance: 'x', job: null }, { instance: 'running', job: { id: 'nope', status: 'done' } }]) {
    assert.throws(() => parseStatus(bad), BadReply)
  }
  assert.deepEqual(parseProgress({ status: 'running', error: null, chunks: [{ seq: 1, text: '안녕' }] }),
    { status: 'running', error: null, chunks: [{ seq: 1, text: '안녕' }] })
  assert.throws(() => parseProgress({ status: 'running', error: null, chunks: [{ seq: '1', text: 'x' }] }), BadReply)
  assert.throws(() => parseProgress({ status: 'done', error: 7, chunks: [] }), BadReply)
  assert.deepEqual(parseHistory({ messages: [{ id: 3, role: 'assistant', text: 'hi', at_ms: 5 }] }),
    [{ id: 3, role: 'assistant', text: 'hi', atMs: 5, routine: null }])
  assert.deepEqual(parseHistory({ messages: [{ id: 4, role: 'user', text: 'x', at_ms: 6, routine: '아침' }] })[0]!.routine, '아침')
  assert.throws(() => parseHistory({ messages: [{ id: 4, role: 'user', text: 'x', at_ms: 6, routine: 7 }] }), BadReply)
  assert.throws(() => parseHistory({ messages: [{ id: 3, role: 'system', text: 'hi', at_ms: 5 }] }), BadReply)
  assert.throws(() => parseHistory({ messages: Array(51).fill({ id: 1, role: 'user', text: '', at_ms: 0 }) }), BadReply)
})

function client(status: number, body: unknown) {
  const calls: Array<{ name: string; init: any }> = []
  return {
    calls,
    op: async (name: string, init: any = {}) => {
      calls.push({ name, init })
      return new Response(status === 204 ? null : JSON.stringify(body), { status })
    },
  }
}

test('operations are called as the sidecar expects', async () => {
  const c = client(202, { job_id: JOB })
  assert.equal(await new Agent(c).send('  안녕  '), JOB)
  assert.equal(c.calls[0]!.name, 'agent-send')
  assert.equal(c.calls[0]!.init.method, 'POST')
  assert.deepEqual(JSON.parse(c.calls[0]!.init.body), { text: '안녕' })

  const p = client(200, { status: 'done', error: null, chunks: [] })
  await new Agent(p).poll(JOB, 4)
  assert.deepEqual(p.calls[0], { name: 'agent-poll', init: { method: 'GET', query: { job: JOB, after: '4' } } })

  const h = client(200, { messages: [] })
  await new Agent(h).history(17)
  assert.deepEqual(h.calls[0]!.init.query, { before: '17', limit: '20' })
})

test('refusals become errors the screen can explain', async () => {
  await assert.rejects(new Agent(client(403, { error: 'approval required' })).status(), ApprovalRequired)
  const cases: Array<[number, string]> = [[409, 'busy'], [503, 'busy'], [429, 'rate'], [400, 'invalid'], [500, 'server']]
  for (const [status, kind] of cases) {
    await assert.rejects(new Agent(client(status, { error: 'x' })).send('hi'),
      (e: unknown) => e instanceof AgentError && e.kind === kind, String(status))
  }
  await assert.rejects(new Agent(client(200, {})).send(''), (e: unknown) => e instanceof AgentError && e.kind === 'invalid')
  await assert.rejects(new Agent(client(200, {})).send('가'.repeat(8001)), (e: unknown) => e instanceof AgentError && e.kind === 'invalid')
})

const ROUTINE = {
  id: JOB, name: '아침 뉴스', prompt: '뉴스 정리', days: 31, minute: 510, enabled: true,
  next_run_ms: 1_791_500_000_000, last_run_ms: null,
}

test('routines are checked before use', () => {
  assert.deepEqual(parseRoutines({ routines: [ROUTINE] }), [{
    id: JOB, name: '아침 뉴스', prompt: '뉴스 정리', days: 31, minute: 510, enabled: true,
    nextRunMs: 1_791_500_000_000, lastRunMs: null,
  }])
  for (const bad of [
    { ...ROUTINE, id: 'x' }, { ...ROUTINE, days: 0 }, { ...ROUTINE, days: 128 }, { ...ROUTINE, minute: 1440 },
    { ...ROUTINE, enabled: 'yes' }, { ...ROUTINE, next_run_ms: -1 }, { ...ROUTINE, name: 3 },
  ]) {
    assert.throws(() => parseRoutines({ routines: [bad] }), BadReply)
  }
  assert.throws(() => parseRoutines({ routines: Array(7).fill(ROUTINE) }), BadReply)
})

test('routine and push operations', async () => {
  const save = client(200, ROUTINE)
  const draft = { name: '아침 뉴스', prompt: '뉴스 정리', days: 31, minute: 510, enabled: true }
  assert.equal((await new Agent(save).saveRoutine(draft)).name, '아침 뉴스')
  assert.equal(save.calls[0]!.name, 'agent-routine-save')
  assert.deepEqual(JSON.parse(save.calls[0]!.init.body), draft)

  const kinds: Array<[number, string]> = [[409, 'limit'], [404, 'missing'], [400, 'routine']]
  for (const [status, kind] of kinds) {
    await assert.rejects(new Agent(client(status, { error: 'x' })).saveRoutine(draft),
      (e: unknown) => e instanceof AgentError && e.kind === kind, String(status))
  }
  // Running a routine while a message is in progress is "busy", as for sends.
  await assert.rejects(new Agent(client(409, { error: 'x' })).runRoutine(JOB),
    (e: unknown) => e instanceof AgentError && e.kind === 'busy')
  assert.equal(await new Agent(client(202, { job_id: JOB })).runRoutine(JOB), JOB)

  const gone = client(204, null)
  await new Agent(gone).deleteRoutine(JOB)
  assert.deepEqual(JSON.parse(gone.calls[0]!.init.body), { id: JOB })

  const key = 'B'.repeat(87)
  assert.equal(await new Agent(client(200, { key })).pushKey(), key)
  await assert.rejects(new Agent(client(200, { key: '<script>' })).pushKey(), BadReply)
  const sub = client(204, null)
  await new Agent(sub).pushSubscribe({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } })
  assert.deepEqual(JSON.parse(sub.calls[0]!.init.body),
    { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } })
  await assert.rejects(new Agent(client(400, { error: 'x' })).pushSubscribe({}),
    (e: unknown) => e instanceof AgentError && e.kind === 'push')
})
