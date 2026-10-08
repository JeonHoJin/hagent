/**
 * The agent operations on the server (`agent-status`, `agent-send`, `agent-poll`,
 * `agent-history`). Every reply is checked for shape and size before the app uses it, and
 * refusals become errors the screen can explain.
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
export interface Message { id: number; role: 'user' | 'assistant'; text: string; atMs: number }

/** The account exists but an admin has not approved it (or took the approval back). */
export class ApprovalRequired extends Error {
  constructor() {
    super('관리자의 승인을 기다리고 있어요.')
    this.name = 'ApprovalRequired'
  }
}

export type ErrorKind = 'busy' | 'rate' | 'invalid' | 'server'

export class AgentError extends Error {
  readonly kind: ErrorKind
  readonly status: number

  constructor(kind: ErrorKind, status: number) {
    super({
      busy: status === 409 ? '이전 메시지의 답을 기다리는 중이에요.' : '지금 에이전트가 바빠요. 잠시 뒤 다시 보내 주세요.',
      rate: '요청이 너무 잦아요. 잠시 뒤 다시 해 주세요.',
      invalid: `메시지는 1~${MAX_TEXT.toLocaleString('ko-KR')}자로 보내 주세요.`,
      server: `서버에 문제가 생겼어요 (HTTP ${status}).`,
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

export function parseHistory(v: unknown): Message[] {
  if (!isObject(v) || !Array.isArray(v.messages) || v.messages.length > 50) throw new BadReply('history')
  return v.messages.map(m => {
    if (!isObject(m) || !isCount(m.id) || (m.role !== 'user' && m.role !== 'assistant')
      || typeof m.text !== 'string' || !isCount(m.at_ms)) {
      throw new BadReply('history.message')
    }
    return { id: m.id, role: m.role, text: m.text, atMs: m.at_ms }
  })
}

export interface OpClient {
  op(name: string, init?: {
    method?: string; body?: BodyInit; headers?: Record<string, string>; query?: Record<string, string>
  }): Promise<Response>
}

async function read(res: Response): Promise<unknown> {
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

  /** A page of messages before `before` (the newest page without it), oldest first. */
  async history(before?: number): Promise<Message[]> {
    const query: Record<string, string> = before === undefined ? {} : { before: String(before) }
    query.limit = String(HISTORY_PAGE)
    return parseHistory(await read(await this.client.op('agent-history', { method: 'GET', query })))
  }
}

export const HISTORY_PAGE_SIZE = HISTORY_PAGE
