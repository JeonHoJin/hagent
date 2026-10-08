/**
 * Follows one job to its end by long polling: each poll returns as soon as the reply has new
 * chunks, so polls are spaced out to stay under the gateway's rate limit, and short outages
 * (a dropped connection, a 429) are retried with backoff.
 */
import { AgentError, type Progress } from './agent.ts'

export interface PollApi {
  poll(job: string, after: number): Promise<Progress>
}

export interface FollowOptions {
  signal?: AbortSignal
  /** Least time between two polls, in ms. */
  minInterval?: number
  /** Consecutive failures tolerated before giving up. */
  maxErrors?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function retryable(e: unknown): boolean {
  // fetch rejects with TypeError when the network fails; 429 and 5xx pass.
  return e instanceof TypeError
    || (e instanceof AgentError && (e.kind === 'rate' || e.kind === 'server'))
}

export async function follow(
  api: PollApi,
  job: string,
  onText: (text: string) => void,
  opts: FollowOptions = {},
): Promise<Progress> {
  const { signal, minInterval = 400, maxErrors = 5, sleep = wait } = opts
  let after = 0
  let errors = 0
  for (;;) {
    signal?.throwIfAborted()
    let progress: Progress
    try {
      progress = await api.poll(job, after)
      errors = 0
    } catch (e) {
      if (!retryable(e) || ++errors > maxErrors) throw e
      await sleep(Math.min(1000 * 2 ** (errors - 1), 15_000))
      continue
    }
    for (const chunk of [...progress.chunks].sort((a, b) => a.seq - b.seq)) {
      if (chunk.seq <= after) continue
      onText(chunk.text)
      after = chunk.seq
    }
    if (progress.status === 'done' || progress.status === 'failed') return progress
    await sleep(minInterval)
  }
}
