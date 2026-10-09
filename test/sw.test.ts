import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/** Loads public/sw.js into a fake worker scope and returns its listeners and what it showed. */
function worker() {
  const listeners: Record<string, (e: any) => void> = {}
  const shown: Array<{ title: string; options: any }> = []
  const opened: string[] = []
  const focused: string[] = []
  const windows: Array<{ url: string; focus: () => void }> = []
  const self = {
    addEventListener: (type: string, fn: (e: any) => void) => { listeners[type] = fn },
    registration: {
      scope: 'https://example.github.io/hagent/',
      showNotification: async (title: string, options: any) => { shown.push({ title, options }) },
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url) },
    },
  }
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self })
  return { listeners, shown, opened, focused, windows }
}

async function push(w: ReturnType<typeof worker>, data: unknown) {
  let done: Promise<unknown> = Promise.resolve()
  w.listeners.push!({ data, waitUntil: (p: Promise<unknown>) => { done = p } })
  await done
  // Plain copy: objects made inside the vm have that realm's prototypes.
  return JSON.parse(JSON.stringify(w.shown.at(-1)!))
}

test('a push shows the routine name, cut to size, and survives bad data', async () => {
  const w = worker()
  const json = (v: unknown) => ({ json: () => v })
  assert.deepEqual(await push(w, json({ title: '아침 뉴스', body: '결과가 도착했어요' })),
    { title: '아침 뉴스', options: { body: '결과가 도착했어요', icon: 'icons/icon-192.png', lang: 'ko' } })
  const long = await push(w, json({ title: '가'.repeat(100), body: '😀'.repeat(300) }))
  assert.equal([...long.title].length, 60)
  assert.equal([...long.options.body].length, 120)
  for (const data of [null, json(null), json('text'), json({ title: 5, body: ['x'] }), { json: () => { throw new Error('bad') } }]) {
    const n = await push(w, data)
    assert.deepEqual([n.title, n.options.body], ['hagent', '새 소식이 있어요'])
  }
})

test('tapping a notification focuses the open app or opens it', async () => {
  const w = worker()
  const tap = async () => {
    let done: Promise<unknown> = Promise.resolve()
    w.listeners.notificationclick!({ notification: { close() {} }, waitUntil: (p: Promise<unknown>) => { done = p } })
    await done
  }
  await tap()
  assert.deepEqual(w.opened, ['https://example.github.io/hagent/'])
  w.windows.push({ url: 'https://example.github.io/other/', focus: () => w.focused.push('other') })
  w.windows.push({ url: 'https://example.github.io/hagent/#x', focus: () => w.focused.push('hagent') })
  await tap()
  assert.deepEqual(w.focused, ['hagent'])
  assert.equal(w.opened.length, 1)
})
