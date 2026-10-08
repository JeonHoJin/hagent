import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ServerClient, type KeyStore } from '../src/server/client.ts'

const subtle = globalThis.crypto.subtle

function memoryStore(): KeyStore & { keys?: CryptoKeyPair } {
  const store: KeyStore & { keys?: CryptoKeyPair } = {
    get: async () => store.keys,
    put: async k => { store.keys = k },
  }
  return store
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(b, c => c.charCodeAt(0))
}

/** 서버 흉내: 챌린지를 내주고, 받은 서명을 WebCrypto 로 실제 검증한다. */
function fakeServer() {
  const issued = new Set<string>()
  const users = new Map<string, string>()
  const calls = { challenge: 0, token: 0, op: 0 }
  let expiresIn = 900
  let rejectNextOp = false
  const seenAuth: string[] = []

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === '/auth/challenge') {
      calls.challenge++
      const c = `c${calls.challenge}-${Math.random().toString(36).slice(2)}`
      issued.add(c)
      return json(200, { challenge: c, expires_in: 120 })
    }
    if (url.pathname === '/auth/token') {
      calls.token++
      const req = JSON.parse(String(init?.body))
      assert.deepEqual(Object.keys(req.public_key).sort(), ['crv', 'kty', 'x', 'y'], 'only key material is sent')
      if (!issued.delete(req.challenge)) return json(401, { error: 'challenge expired or unknown' })
      const key = await subtle.importKey('jwk', { ...req.public_key, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      const ok = await subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64url(req.signature),
        new TextEncoder().encode(`mlhops-auth-v1:${req.challenge}`),
      )
      if (!ok) return json(401, { error: 'invalid signature' })
      const id = `${req.public_key.x}.${req.public_key.y}`
      if (!users.has(id)) users.set(id, `user-${users.size + 1}`)
      return json(200, { access_token: `tok-${calls.token}`, token_type: 'Bearer', expires_in: expiresIn, user_id: users.get(id) })
    }
    if (url.pathname.startsWith('/op/')) {
      calls.op++
      const auth = new Headers(init?.headers).get('authorization') ?? ''
      seenAuth.push(auth)
      if (rejectNextOp) { rejectNextOp = false; return json(401, { error: 'sign-in required' }) }
      return json(200, { path: url.pathname, auth })
    }
    return json(404, { error: 'not found' })
  }) as typeof globalThis.fetch

  return {
    fetch, calls, seenAuth,
    setExpiresIn: (s: number) => { expiresIn = s },
    rejectNextOp: () => { rejectNextOp = true },
  }
}

describe('ServerClient — 기기 키 로그인', () => {
  test('챌린지에 서명해 토큰을 받고 op 호출에 붙인다', async () => {
    const srv = fakeServer()
    const client = new ServerClient({ base: 'https://api.test', store: memoryStore(), fetch: srv.fetch })
    const res = await client.op('whoami', { method: 'GET' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { path: '/op/whoami', auth: 'Bearer tok-1' })
    assert.equal(client.userId, 'user-1')
  })

  test('유효한 토큰은 재사용하고, 동시 호출도 로그인은 한 번만', async () => {
    const srv = fakeServer()
    const client = new ServerClient({ base: 'https://api.test', store: memoryStore(), fetch: srv.fetch })
    await Promise.all([client.op('a'), client.op('b'), client.op('c', { version: 'v2' })])
    await client.op('d')
    assert.equal(srv.calls.challenge, 1)
    assert.equal(srv.calls.op, 4)
  })

  test('만료가 다가오면 새로 로그인한다', async () => {
    const srv = fakeServer()
    let t = 0
    const client = new ServerClient({ base: 'https://api.test', store: memoryStore(), fetch: srv.fetch, now: () => t })
    await client.op('a')
    t = 839_000
    await client.op('a')
    assert.equal(srv.calls.challenge, 1)
    t = 841_000
    await client.op('a')
    assert.equal(srv.calls.challenge, 2)
  })

  test('401 이면 한 번만 다시 로그인해서 재시도한다', async () => {
    const srv = fakeServer()
    const client = new ServerClient({ base: 'https://api.test', store: memoryStore(), fetch: srv.fetch })
    await client.op('a')
    srv.rejectNextOp()
    const res = await client.op('a')
    assert.equal(res.status, 200)
    assert.deepEqual(srv.seenAuth, ['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2'])
  })

  test('같은 기기 키면 같은 사용자, 개인키는 내보낼 수 없다', async () => {
    const srv = fakeServer()
    const store = memoryStore()
    const a = new ServerClient({ base: 'https://api.test', store, fetch: srv.fetch })
    await a.op('x')
    const b = new ServerClient({ base: 'https://api.test', store, fetch: srv.fetch })
    await b.op('x')
    assert.equal(a.userId, b.userId)

    const other = new ServerClient({ base: 'https://api.test', store: memoryStore(), fetch: srv.fetch })
    await other.op('x')
    assert.notEqual(other.userId, a.userId)

    await assert.rejects(subtle.exportKey('jwk', store.keys!.privateKey))
  })
})
