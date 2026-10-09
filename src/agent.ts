/**
 * The agent operations on the server (`agent-status`, `agent-send`, `agent-poll`,
 * `agent-history`, the routine operations and the push subscription ones). Every reply is
 * checked for shape and size before the app uses it, and refusals become errors the screen can
 * explain.
 */

export const MAX_TEXT = 8000
/** Largest reply body read; the server sends far less. */
const MAX_REPLY_BYTES = 2 * 1024 * 1024
const HISTORY_PAGE = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'
export interface Status { instance: 'running' | 'stopped'; job: { id: string; status: JobStatus } | null }
export interface Chunk { seq: number; text: string }
export interface Progress { status: JobStatus; error: string | null; chunks: Chunk[] }
export interface Message {
  id: number; role: 'user' | 'assistant'; text: string; atMs: number
  /** The routine that sent this message, if one did. */
  routine: string | null
}
export interface Routine {
  id: string; name: string; prompt: string
  /** Bit 0 = Monday … bit 6 = Sunday. */
  days: number
  /** Minutes after midnight, Korea time. */
  minute: number
  enabled: boolean; nextRunMs: number | null; lastRunMs: number | null
}
export interface RoutineDraft { id?: string; name: string; prompt: string; days: number; minute: number; enabled: boolean }
/** What `PushSubscription.toJSON()` gives. */
export interface PushSubscriptionJson { endpoint?: string; keys?: Record<string, string> }

export const MAX_ROUTINES = 3
export const MAX_ROUTINE_NAME = 40
export const MAX_ROUTINE_PROMPT = 2000

/** The account exists but an admin has not approved it (or took the approval back). */
export class ApprovalRequired extends Error {
  constructor() {
    super('관리자의 승인을 기다리고 있어요.')
    this.name = 'ApprovalRequired'
  }
}

export type ErrorKind = 'busy' | 'rate' | 'invalid' | 'server' | 'limit' | 'missing' | 'routine' | 'push'

export class AgentError extends Error {
  readonly kind: ErrorKind
  readonly status: number

  constructor(kind: ErrorKind, status: number) {
    super({
      busy: status === 409 ? '이전 메시지의 답을 기다리는 중이에요.' : '지금 에이전트가 바빠요. 잠시 뒤 다시 보내 주세요.',
      rate: '요청이 너무 잦아요. 잠시 뒤 다시 해 주세요.',
      invalid: `메시지는 1~${MAX_TEXT.toLocaleString('ko-KR')}자로 보내 주세요.`,
      server: `서버에 문제가 생겼어요 (HTTP ${status}).`,
      limit: `루틴은 ${MAX_ROUTINES}개까지 만들 수 있어요.`,
      missing: '루틴을 찾지 못했어요. 창을 닫았다가 다시 열어 주세요.',
      routine: '루틴 내용을 확인해 주세요.',
      push: '이 브라우저의 알림 구독을 서버가 받지 않았어요.',
    }[kind])
    this.kind = kind
    this.status = status
    this.name = 'AgentError'
  }
}

/** The server answered something this app does not understand. */
export class BadReply extends Error {
  constructor(what: string) {
    super(`서버 응답을 이해하지 못했어요 (${what}).`)
    this.name = 'BadReply'
  }
}

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isJobStatus = (v: unknown): v is JobStatus =>
  v === 'queued' || v === 'running' || v === 'done' || v === 'failed'
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

export function parseStatus(v: unknown): Status {
  if (!isObject(v) || (v.instance !== 'running' && v.instance !== 'stopped')) throw new BadReply('status')
  if (v.job === null) return { instance: v.instance, job: null }
  const job = v.job
  if (!isObject(job) || typeof job.id !== 'string' || !UUID.test(job.id) || !isJobStatus(job.status)) {
    throw new BadReply('status.job')
  }
  return { instance: v.instance, job: { id: job.id, status: job.status } }
}

export function parseProgress(v: unknown): Progress {
  if (!isObject(v) || !isJobStatus(v.status) || !Array.isArray(v.chunks) || v.chunks.length > 10_000) {
    throw new BadReply('poll')
  }
  if (v.error !== null && v.error !== undefined && typeof v.error !== 'string') throw new BadReply('poll.error')
  const chunks = v.chunks.map(c => {
    if (!isObject(c) || !isCount(c.seq) || typeof c.text !== 'string') throw new BadReply('poll.chunk')
    return { seq: c.seq, text: c.text }
  })
  return { status: v.status, error: typeof v.error === 'string' ? v.error : null, chunks }
}

const isLabel = (v: unknown): v is string | null | undefined =>
  v === null || v === undefined || (typeof v === 'string' && v.length <= MAX_ROUTINE_NAME * 2)

export function parseHistory(v: unknown): Message[] {
  if (!isObject(v) || !Array.isArray(v.messages) || v.messages.length > 50) throw new BadReply('history')
  return v.messages.map(m => {
    if (!isObject(m) || !isCount(m.id) || (m.role !== 'user' && m.role !== 'assistant')
      || typeof m.text !== 'string' || !isCount(m.at_ms) || !isLabel(m.routine)) {
      throw new BadReply('history.message')
    }
    return { id: m.id, role: m.role, text: m.text, atMs: m.at_ms, routine: m.routine ?? null }
  })
}

const isTime = (v: unknown): v is number | null => v === null || isCount(v)

export function parseRoutine(v: unknown): Routine {
  if (!isObject(v) || typeof v.id !== 'string' || !UUID.test(v.id)
    || typeof v.name !== 'string' || v.name.length > MAX_ROUTINE_NAME * 2
    || typeof v.prompt !== 'string' || v.prompt.length > MAX_ROUTINE_PROMPT * 2
    || !Number.isInteger(v.days) || (v.days as number) < 1 || (v.days as number) > 127
    || !Number.isInteger(v.minute) || (v.minute as number) < 0 || (v.minute as number) > 1439
    || typeof v.enabled !== 'boolean' || !isTime(v.next_run_ms) || !isTime(v.last_run_ms)) {
    throw new BadReply('routine')
  }
  return {
    id: v.id, name: v.name, prompt: v.prompt, days: v.days as number, minute: v.minute as number,
    enabled: v.enabled, nextRunMs: v.next_run_ms, lastRunMs: v.last_run_ms,
  }
}

export function parseRoutines(v: unknown): Routine[] {
  if (!isObject(v) || !Array.isArray(v.routines) || v.routines.length > MAX_ROUTINES * 2) throw new BadReply('routines')
  return v.routines.map(parseRoutine)
}

export interface OpClient {
  op(name: string, init?: {
    method?: string; body?: BodyInit; headers?: Record<string, string>; query?: Record<string, string>
  }): Promise<Response>
}

/** Statuses an operation means differently from a message send (say, 409 = too many routines). */
type Meanings = Partial<Record<number, ErrorKind>>

async function read(res: Response, meanings: Meanings = {}): Promise<unknown> {
  const text = await res.text()
  if (text.length > MAX_REPLY_BYTES) throw new BadReply('too large')
  if (res.ok) {
    try {
      return JSON.parse(text)
    } catch {
      throw new BadReply('not JSON')
    }
  }
  if (res.status === 403) throw new ApprovalRequired()
  const meant = meanings[res.status]
  if (meant) throw new AgentError(meant, res.status)
  if (res.status === 409 || res.status === 503) throw new AgentError('busy', res.status)
  if (res.status === 429) throw new AgentError('rate', res.status)
  if (res.status === 400 || res.status === 413) throw new AgentError('invalid', res.status)
  throw new AgentError('server', res.status)
}

export class Agent {
  private readonly client: OpClient

  constructor(client: OpClient) {
    this.client = client
  }

  async status(): Promise<Status> {
    return parseStatus(await read(await this.client.op('agent-status', { method: 'GET' })))
  }

  /** Queues a message and returns its job id. */
  async send(text: string): Promise<string> {
    const trimmed = text.trim()
    if (!trimmed || [...trimmed].length > MAX_TEXT) throw new AgentError('invalid', 400)
    const reply = await read(await this.client.op('agent-send', {
      method: 'POST',
      body: JSON.stringify({ text: trimmed }),
      headers: { 'content-type': 'application/json' },
    }))
    if (!isObject(reply) || typeof reply.job_id !== 'string' || !UUID.test(reply.job_id)) throw new BadReply('send')
    return reply.job_id
  }

  /** Chunks after `after`; the server holds the request until there are some or the job ends. */
  async poll(job: string, after: number): Promise<Progress> {
    return parseProgress(await read(await this.client.op('agent-poll', {
      method: 'GET', query: { job, after: String(after) },
    })))
  }

  async routines(): Promise<Routine[]> {
    return parseRoutines(await read(await this.client.op('agent-routines', { method: 'GET' })))
  }

  async saveRoutine(draft: RoutineDraft): Promise<Routine> {
    return parseRoutine(await read(await this.post('agent-routine-save', draft),
      { 400: 'routine', 404: 'missing', 409: 'limit' }))
  }

  async deleteRoutine(id: string): Promise<void> {
    await this.empty(await this.post('agent-routine-delete', { id }), { 404: 'missing' })
  }

  /** Runs a routine now and returns its job id. */
  async runRoutine(id: string): Promise<string> {
    const reply = await read(await this.post('agent-routine-run', { id }), { 404: 'missing' })
    if (!isObject(reply) || typeof reply.job_id !== 'string' || !UUID.test(reply.job_id)) throw new BadReply('run')
    return reply.job_id
  }

  /** The server's VAPID public key (base64url) for `pushManager.subscribe`. */
  async pushKey(): Promise<string> {
    const reply = await read(await this.client.op('agent-push-key', { method: 'GET' }))
    if (!isObject(reply) || typeof reply.key !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(reply.key)) {
      throw new BadReply('push key')
    }
    return reply.key
  }

  async pushSubscribe(sub: PushSubscriptionJson): Promise<void> {
    await this.empty(await this.post('agent-push-subscribe', { endpoint: sub.endpoint, keys: sub.keys }), { 400: 'push' })
  }

  async pushUnsubscribe(endpoint: string): Promise<void> {
    await this.empty(await this.post('agent-push-unsubscribe', { endpoint }))
  }

  private post(name: string, body: unknown): Promise<Response> {
    return this.client.op(name, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    })
  }

  /** For operations that answer 204: only refusals matter. */
  private async empty(res: Response, meanings: Meanings = {}): Promise<void> {
    if (res.status === 204) return
    await read(res, meanings)
  }

  /** A page of messages before `before` (the newest page without it), oldest first. */
  async history(before?: number): Promise<Message[]> {
    const query: Record<string, string> = before === undefined ? {} : { before: String(before) }
    query.limit = String(HISTORY_PAGE)
    return parseHistory(await read(await this.client.op('agent-history', { method: 'GET', query })))
  }
}

export const HISTORY_PAGE_SIZE = HISTORY_PAGE
