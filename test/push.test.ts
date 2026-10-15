import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { workerScriptURL } from '../src/worker-url.ts'

// Exercise enablePush without real notification permission, accounts or push endpoints.
const source = readFileSync(new URL('../src/push.ts', import.meta.url), 'utf8')
  .replace('import.meta.env.BASE_URL', JSON.stringify('/hagent/'))
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function browser(failRegistration = false) {
  const events: string[] = []
  const trusted = { url: 'https://example.org/hagent/sw.js' }
  const exports: Record<string, any> = {}
  const registration = {
    pushManager: {
      getSubscription: async () => null,
      subscribe: async () => { events.push('subscribe'); return { toJSON: () => ({ endpoint: 'synthetic' }) } },
    },
  }
  vm.runInNewContext(code, {
    exports, URL, Uint8Array,
    require: (name: string) => name.endsWith('worker-url.ts') ? { workerScriptURL } : { fromBase64url: () => new Uint8Array(65) },
    location: { href: 'https://example.org/hagent/' },
    window: { PushManager: {}, Notification: {}, trustedTypes: {
      createPolicy: (name: string, rules: any) => {
        assert.equal(name, 'hagent-worker')
        return { createScriptURL: (value: string) => { assert.equal(rules.createScriptURL(value), trusted.url); return trusted } }
      },
    } },
    Notification: { requestPermission: () => { events.push('permission'); return Promise.resolve('granted') } },
    navigator: { serviceWorker: {
      register: async (url: unknown) => {
        events.push('register')
        // Trusted Types enforcement rejects the old plain-string registration.
        assert.equal(url, trusted)
        if (failRegistration) throw new TypeError('TrustedScriptURL required')
        return registration
      },
      ready: Promise.resolve(registration),
    } },
  })
  const agent = {
    pushKey: async () => { events.push('key'); return 'synthetic-key' },
    pushSubscribe: async () => { events.push('save') },
  }
  return { exports, events, agent }
}

test('push setup passes a trusted worker URL and saves the subscription after permission', async () => {
  const b = browser()
  assert.equal(await b.exports.enablePush(b.agent), 'on')
  assert.deepEqual(b.events, ['permission', 'register', 'key', 'subscribe', 'save'])
  // A retry must reuse the policy instead of violating CSP's duplicate-name restriction.
  assert.equal(await b.exports.enablePush(b.agent), 'on')
})

test('worker setup errors identify the browser stage instead of reporting a server network failure', async () => {
  const b = browser(true)
  await assert.rejects(b.exports.enablePush(b.agent), (e: Error) => {
    assert.equal(e.name, 'PushSetupError')
    assert.match(e.message, /서비스 워커 등록/)
    assert.ok(e.cause instanceof TypeError)
    return true
  })
  assert.deepEqual(b.events, ['permission', 'register'])
})
