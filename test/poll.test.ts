import { test } from 'node:test'
import assert from 'node:assert/strict'
import { follow } from '../src/poll.ts'
import { AgentError, ApprovalRequired, type Progress } from '../src/agent.ts'

const JOB = '2e6fa396-5cb2-4038-a272-5116e4df7384'

function scripted(replies: Array<Progress | Error>) {
  const asked: number[] = []
  return {
    asked,
    poll: async (_job: string, after: number) => {
      asked.push(after)
      const next = replies.shift()
      if (!next) throw new Error('no more replies')
      if (next instanceof Error) throw next
      return next
    },
  }
}

const noSleep = { sleep: async () => {} }

test('chunks arrive in order and the poll resumes after the last one', async () => {
  const api = scripted([
    { status: 'running', error: null, chunks: [{ seq: 1, text: '안' }, { seq: 2, text: '녕' }] },
    { status: 'running', error: null, chunks: [] },
    { status: 'done', error: null, chunks: [{ seq: 3, text: '!' }] },
  ])
  const pieces: string[] = []
  const last = await follow(api, JOB, t => pieces.push(t), noSleep)
  assert.deepEqual(pieces, ['안', '녕', '!'])
  assert.deepEqual(api.asked, [0, 2, 2])
  assert.equal(last.status, 'done')
})

test('a chunk seen before is not shown twice', async () => {
  const api = scripted([
    { status: 'running', error: null, chunks: [{ seq: 1, text: 'a' }] },
    { status: 'done', error: null, chunks: [{ seq: 1, text: 'a' }, { seq: 2, text: 'b' }] },
  ])
  const pieces: string[] = []
  await follow(api, JOB, t => pieces.push(t), noSleep)
  assert.deepEqual(pieces, ['a', 'b'])
})

test('polls are spaced to stay under the gateway rate limit', async () => {
  const waits: number[] = []
  const api = scripted([
    { status: 'running', error: null, chunks: [{ seq: 1, text: 'a' }] },
    { status: 'done', error: null, chunks: [] },
  ])
  await follow(api, JOB, () => {}, { sleep: async ms => { waits.push(ms) }, minInterval: 400 })
  assert.deepEqual(waits, [400])
})

test('passing errors are retried with backoff, lasting ones and revoked approval are not', async () => {
  const waits: number[] = []
  const flaky = scripted([new TypeError('network'), new AgentError('rate', 429), { status: 'done', error: null, chunks: [] }])
  await follow(flaky, JOB, () => {}, { sleep: async ms => { waits.push(ms) } })
  assert.equal(waits.length, 2)
  assert.ok(waits[1]! > waits[0]!, 'backs off')

  const broken = scripted(Array(10).fill(new TypeError('network')))
  await assert.rejects(follow(broken, JOB, () => {}, { ...noSleep, maxErrors: 3 }), TypeError)
  assert.equal(broken.asked.length, 4)

  const revoked = scripted([new ApprovalRequired()])
  await assert.rejects(follow(revoked, JOB, () => {}, noSleep), ApprovalRequired)
})

test('an aborted follow stops polling', async () => {
  const ctl = new AbortController()
  const api = scripted([{ status: 'running', error: null, chunks: [] }, { status: 'running', error: null, chunks: [] }])
  await assert.rejects(follow(api, JOB, () => {}, { sleep: async () => ctl.abort(), signal: ctl.signal }),
    (e: unknown) => e instanceof DOMException && e.name === 'AbortError')
  assert.equal(api.asked.length, 1)
})
