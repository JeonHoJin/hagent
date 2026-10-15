import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerScriptURL, type WorkerURLFactory } from '../src/worker-url.ts'

test('the worker policy accepts only the exact app worker and exposes no HTML or script rules', () => {
  const url = 'https://example.org/hagent/sw.js'
  let rules: { createScriptURL: (value: string) => string } | undefined
  const trusted = { trusted: url }
  const factory: WorkerURLFactory = {
    createPolicy(name, received) {
      assert.equal(name, 'hagent-worker')
      rules = received
      return { createScriptURL: value => { assert.equal(received.createScriptURL(value), url); return trusted } }
    },
  }
  assert.equal(workerScriptURL(url, factory), trusted)
  assert.deepEqual(Object.keys(rules!), ['createScriptURL'])
  for (const other of ['https://attacker.example/sw.js', 'https://example.org/other/sw.js', `${url}?x`, 'javascript:alert(1)']) {
    assert.throws(() => rules!.createScriptURL(other), TypeError)
  }
})

test('browsers without Trusted Types receive the original worker URL', () => {
  assert.equal(workerScriptURL('/hagent/sw.js'), '/hagent/sw.js')
})
