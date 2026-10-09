// hagent's service worker: shows a notification when a routine finishes and opens the app
// when it is tapped. It has no fetch handler and no caches, so it never sees the requests or
// the storage of other apps on this shared origin.
'use strict'

const TITLE_MAX = 60
const BODY_MAX = 120

/** A string cut to `max` characters, or the fallback when there is nothing usable. */
function line(value, max, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback
  return Array.from(value.trim()).slice(0, max).join('')
}

/** The push data read as `{title, body}`, never trusting its shape. */
function notice(data) {
  let parsed = null
  try {
    parsed = data ? data.json() : null
  } catch {
    parsed = null
  }
  const fields = parsed && typeof parsed === 'object' ? parsed : {}
  return { title: line(fields.title, TITLE_MAX, 'hagent'), body: line(fields.body, BODY_MAX, '새 소식이 있어요') }
}

self.addEventListener('push', event => {
  const { title, body } = notice(event.data)
  event.waitUntil(self.registration.showNotification(title, { body, icon: 'icons/icon-192.png', lang: 'ko' }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const scope = self.registration.scope
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(w => w.url.startsWith(scope))
    return open ? open.focus() : self.clients.openWindow(scope)
  })())
})
