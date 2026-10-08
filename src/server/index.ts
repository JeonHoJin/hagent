/**
 * The app's one server connection. The device key lives in IndexedDB as a CryptoKey object
 * (structured clone stores non-extractable keys too), under a name that carries this app's
 * path: other apps on the same github.io origin use their own names.
 */
import { ServerClient, type KeyStore } from './client.ts'

/** The public gateway; `npm run mock` points this at the local fake instead. */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'https://168-107-32-199.sslip.io'

export const KEY_DB = `hagent-keys:${new URL('.', location.href).pathname}`

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore('device')
    req.onerror = () => reject(new Error('기기 키 저장소를 열지 못했어요.'))
    req.onsuccess = () => resolve(req.result)
  })
}

function keyRequest<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openKeyDb().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction('device', mode)
    const req = run(tx.objectStore('device'))
    tx.oncomplete = () => { db.close(); resolve(req.result) }
    tx.onerror = tx.onabort = () => { db.close(); reject(new Error('기기 키를 저장하지 못했어요.')) }
  }))
}

const indexedDbKeyStore: KeyStore = {
  get: () => keyRequest('readonly', s => s.get('default') as IDBRequest<CryptoKeyPair | undefined>),
  put: keys => keyRequest('readwrite', s => s.put(keys, 'default')).then(() => undefined),
}

export const server = new ServerClient({ base: API_BASE, store: indexedDbKeyStore })

/** Forgets this device's key: the next start signs in as a new account. */
export function clearDeviceData(): Promise<void> {
  return new Promise(resolve => {
    const req = indexedDB.deleteDatabase(KEY_DB)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
}

export { ServerError } from './client.ts'
