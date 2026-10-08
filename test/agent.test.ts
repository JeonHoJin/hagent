import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, AgentError, ApprovalRequired, BadReply, parseHistory, parseProgress, parseStatus } from '../src/agent.ts'

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
    [{ id: 3, role: 'assistant', text: 'hi', atMs: 5 }])
  assert.throws(() => parseHistory({ messages: [{ id: 3, role: 'system', text: 'hi', at_ms: 5 }] }), BadReply)
  assert.throws(() => parseHistory({ messages: Array(51).fill({ id: 1, role: 'user', text: '', at_ms: 0 }) }), BadReply)
})

function client(status: number, body: unknown) {
  const calls: Array<{ name: string; init: any }> = []
  return {
    calls,
    op: async (name: string, init: any = {}) => {
      calls.push({ name, init })
      return new Response(JSON.stringify(body), { status })
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
