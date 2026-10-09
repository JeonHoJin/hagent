/**
 * Push notifications for routine results on this device: the service worker (public/sw.js)
 * shows them, and the server needs this browser's subscription to send them. Nothing here
 * runs until the person turns notifications on.
 */
import type { Agent } from './agent.ts'
import { fromBase64url } from './server/client.ts'

/** /hagent/ in production; the worker controls only this app's pages. */
const SCOPE = import.meta.env.BASE_URL
const WORKER = `${SCOPE}sw.js`

export type PushState =
  | 'unsupported' // this browser cannot receive web push
  | 'needs-install' // iPhone/iPad: only the Home Screen app can
  | 'denied' // the person blocked notifications for this site
  | 'off'
  | 'on'

function appleMobile(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

function standalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SCOPE)
  return (await reg?.pushManager.getSubscription()) ?? null
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return appleMobile() && !standalone() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  return (await currentSubscription()) ? 'on' : 'off'
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false
  const bytes = new Uint8Array(current)
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i])
}

/**
 * Asks for permission, then subscribes this browser and tells the server. Call it straight
 * from a click: Safari asks only during a user gesture, so permission comes first.
 */
export async function enablePush(agent: Agent): Promise<PushState> {
  if (!supported()) return pushState()
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off'
  const reg = await navigator.serviceWorker.register(WORKER, { scope: SCOPE, updateViaCache: 'none' })
  await navigator.serviceWorker.ready
  const key = new Uint8Array(fromBase64url(await agent.pushKey()))
  let sub = await reg.pushManager.getSubscription()
  // A subscription made for another server key can no longer receive anything.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await agent.pushSubscribe(sub.toJSON())
  return 'on'
}

/** Tells the server again about this browser's subscription (it may have been dropped). */
export async function refreshPush(agent: Agent): Promise<void> {
  if (!supported() || Notification.permission !== 'granted') return
  const sub = await currentSubscription()
  if (sub) await agent.pushSubscribe(sub.toJSON())
}

export async function disablePush(agent: Agent): Promise<PushState> {
  const sub = supported() ? await currentSubscription() : null
  if (sub) {
    const endpoint = sub.endpoint
    await sub.unsubscribe()
    await agent.pushUnsubscribe(endpoint)
  }
  return pushState()
}
