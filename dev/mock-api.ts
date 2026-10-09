/**
 * A fake server for `npm run mock` (and `vite preview --mode mock`), so the screens can be
 * seen without the real backend: the first status check says "waiting for approval", later
 * ones say approved, and a sent message streams back in pieces. Only the dev and preview
 * servers load this; the build never includes it.
 */
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

const USER = '1b4e28ba-2fa1-41d2-883f-0016d3cca427'
const JOB = '2e6fa396-5cb2-4038-a272-5116e4df7384'
const REPLY = ['## Apple container\n\n**Apple의 container**는 Mac에서 Linux 컨테이너를 ',
  '*가벼운 VM*으로 돌리는 도구예요.\n\n1. 컨테이너마다 VM 하나\n   - 커널을 따로 씀\n   - `container run`으로 시작\n2. ',
  'OCI 이미지 사용\n\n| 항목 | 값 |\n|:--|--:|\n| 메모리 | 512MB |\n| CPU | 2 |\n\n```sh\ncontainer run --rm -it alpine sh\n```\n\n',
  '> 인용 예시\n\n출처: [apple/container](https://github.com/apple/container)']

type Next = () => void

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
  })
}

export function mockApi(): Plugin {
  let statusCalls = 0
  let polls = 0
  let nextId = 3
  const messages = [
    { id: 1, role: 'user', text: '오늘 할 일 정리하는 요령 알려줘', at_ms: Date.now() - 3_600_000 },
    { id: 2, role: 'assistant', text: '1. 가장 중요한 일 세 가지만 고르세요.\n2. 오전에 하나 끝내세요.', at_ms: Date.now() - 3_590_000 },
  ]

  async function handle(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    switch (url.pathname) {
      case '/auth/challenge':
        return json(res, 200, { challenge: 'mock-challenge', expires_in: 120 })
      case '/auth/token':
        return json(res, 200, { access_token: 'mock', token_type: 'Bearer', expires_in: 900, user_id: USER, created: true })
      case '/op/agent-status':
        statusCalls++
        return statusCalls === 1
          ? json(res, 403, { error: 'approval required' })
          : json(res, 200, { instance: 'running', job: null })
      case '/op/agent-history': {
        const before = Number(url.searchParams.get('before') ?? Infinity)
        return json(res, 200, { messages: messages.filter(m => m.id < before).slice(-20) })
      }
      case '/op/agent-send': {
        const { text } = JSON.parse(await readBody(req)) as { text: string }
        polls = 0
        messages.push({ id: nextId++, role: 'user', text, at_ms: Date.now() })
        return json(res, 202, { job_id: JOB })
      }
      case '/op/agent-poll': {
        await new Promise(r => setTimeout(r, 300))
        const after = Number(url.searchParams.get('after') ?? 0)
        polls++
        const upto = Math.min(polls, REPLY.length)
        const done = upto === REPLY.length
        if (done) messages.push({ id: nextId++, role: 'assistant', text: REPLY.join(''), at_ms: Date.now() })
        return json(res, 200, {
          status: done ? 'done' : 'running', error: null,
          chunks: REPLY.slice(0, upto).map((text, i) => ({ seq: i + 1, text })).filter(c => c.seq > after),
        })
      }
      default:
        return next()
    }
  }

  const use = (req: IncomingMessage, res: ServerResponse, next: Next) => { void handle(req, res, next) }
  return {
    name: 'hagent-mock-api',
    configureServer: server => { server.middlewares.use(use) },
    configurePreviewServer: server => { server.middlewares.use(use) },
  }
}
