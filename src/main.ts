import './frame-guard.ts'
import { Agent, AgentError, ApprovalRequired, HISTORY_PAGE_SIZE, MAX_TEXT, type Message } from './agent.ts'
import { el, markdown, richText } from './dom.ts'
import { follow } from './poll.ts'
import { clearDeviceData, server } from './server/index.ts'
import { PasskeyCancelled, passkeySupported, registerPasskey, signInWithPasskey } from './server/passkey.ts'
import { openRoutines } from './routines-view.ts'

const app = document.getElementById('app')!
const agent = new Agent(server)
/** Set by the chat screen: catches up when the app comes back into view. */
let onVisible: (() => void) | null = null
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onVisible?.()
})

function show(...nodes: Node[]): void {
  onVisible = null
  app.replaceChildren(...nodes)
}

function accountCode(): string {
  return server.userId?.slice(0, 8) ?? '—'
}

function errorText(e: unknown): string {
  if (e instanceof PasskeyCancelled || e instanceof AgentError || e instanceof ApprovalRequired) return e.message
  if (e instanceof TypeError) return '서버에 연결하지 못했어요. 네트워크를 확인해 주세요.'
  return e instanceof Error && e.message ? e.message : '알 수 없는 문제가 생겼어요.'
}

async function forgetThisDevice(): Promise<void> {
  if (!confirm('이 기기의 로그인 정보를 지울까요? 패스키를 등록하지 않았다면 이 계정으로 다시 들어올 수 없어요.')) return
  await clearDeviceData()
  location.reload()
}

// --- screens ---------------------------------------------------------------

function welcome(): void {
  const note = el('p', { class: 'note' })
  const busy = (on: boolean) => { for (const b of buttons) b.disabled = on }
  const start = el('button', { class: 'primary', type: 'button', onclick: () => { busy(true); void enter() } }, '시작하기')
  const restore = el('button', {
    type: 'button',
    onclick: async () => {
      busy(true)
      note.textContent = ''
      try {
        await signInWithPasskey()
        await enter()
      } catch (e) {
        note.textContent = errorText(e)
        busy(false)
      }
    },
  }, '패스키로 기존 계정 찾기')
  const buttons = passkeySupported() ? [start, restore] : [start]
  show(el('section', { class: 'card' },
    el('h1', {}, 'hagent'),
    el('p', {}, '나만의 AI 에이전트예요. 관리자가 승인한 계정만 쓸 수 있어요.'),
    el('p', { class: 'muted' }, '시작하면 이 기기에 로그인 키를 만들어요. 다른 기기에서 쓰려면 나중에 설정에서 패스키를 등록해 두세요.'),
    el('div', { class: 'actions' }, ...buttons),
    note))
}

function waiting(): void {
  const note = el('p', { class: 'note' })
  const check = el('button', {
    class: 'primary', type: 'button',
    onclick: async () => { check.disabled = true; note.textContent = ''; await enter(note); check.disabled = false },
  }, '다시 확인')
  show(el('section', { class: 'card' },
    el('h1', {}, '승인을 기다리고 있어요'),
    el('p', {}, '관리자에게 아래 계정 코드를 알려 주세요. 승인되면 바로 쓸 수 있어요.'),
    el('p', { class: 'code' }, accountCode()),
    el('div', { class: 'actions' }, check, el('button', { type: 'button', onclick: settings }, '설정')),
    note))
}

/** Signs in (making the device key on first use) and opens the right screen. */
async function enter(note?: HTMLElement): Promise<void> {
  try {
    const status = await agent.status()
    await chat(status.job && (status.job.status === 'queued' || status.job.status === 'running') ? status.job.id : null)
  } catch (e) {
    if (e instanceof ApprovalRequired) return waiting()
    if (note) { note.textContent = errorText(e); return }
    fatal(e)
  }
}

async function chat(activeJob: string | null): Promise<void> {
  const list = el('ol', { class: 'messages' })
  const older = el('button', { class: 'link', type: 'button', hidden: true }, '이전 대화 더 보기')
  const status = el('p', { class: 'status' })
  const input = el('textarea', { rows: '2', placeholder: '메시지를 입력하세요', 'aria-label': '메시지' })
  const counter = el('span', { class: 'counter' })
  const send = el('button', { class: 'primary', type: 'submit' }, '보내기')
  let oldest: number | undefined
  /** The newest message id on screen, or null when the screen may be behind the server. */
  let newest: number | null = null
  let running = false
  let refreshing = false

  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 80
  const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight })

  function bubble(m: { role: 'user' | 'assistant'; text: string; atMs?: number; routine?: string | null }): HTMLElement {
    const body = el('div', { class: m.role === 'assistant' ? 'text md' : 'text' })
    if (m.role === 'assistant') markdown(body, m.text)
    else richText(body, m.text)
    const time = m.atMs ? el('time', {}, new Date(m.atMs).toLocaleString('ko-KR', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })) : null
    const label = m.routine ? el('span', { class: 'tag' }, `⏰ ${m.routine}`) : null
    return el('li', { class: `msg ${m.role}` }, label, body, time)
  }

  function update(): void {
    const n = [...input.value.trim()].length
    counter.textContent = `${n.toLocaleString('ko-KR')} / ${MAX_TEXT.toLocaleString('ko-KR')}`
    counter.classList.toggle('over', n > MAX_TEXT)
    send.disabled = running || n === 0 || n > MAX_TEXT
  }

  async function loadOlder(): Promise<void> {
    older.disabled = true
    try {
      const page: Message[] = await agent.history(oldest)
      if (oldest === undefined) newest = page.at(-1)?.id ?? null
      if (page.length) oldest = page[0]!.id
      const first = list.firstChild
      for (const m of page) list.insertBefore(bubble(m), first)
      older.hidden = page.length < HISTORY_PAGE_SIZE
    } catch (e) {
      status.textContent = errorText(e)
    } finally {
      older.disabled = false
    }
  }

  /** Streams a job's reply into a new bubble. */
  async function stream(job: string): Promise<void> {
    running = true
    update()
    const item = bubble({ role: 'assistant', text: '' })
    item.classList.add('pending')
    const body = item.querySelector('.text') as HTMLElement
    list.append(item)
    scrollDown()
    status.textContent = '에이전트가 생각하고 있어요…'
    let text = ''
    try {
      const last = await follow(agent, job, piece => {
        const stick = nearBottom()
        text += piece
        markdown(body, text)
        if (stick) scrollDown()
      })
      if (last.status === 'failed') {
        item.classList.add('failed')
        markdown(body, text ? `${text}\n\n(${last.error ?? '응답에 실패했어요'})` : (last.error ?? '응답에 실패했어요'))
      }
      status.textContent = ''
    } catch (e) {
      if (e instanceof ApprovalRequired) return waiting()
      item.classList.add('failed')
      status.textContent = errorText(e)
    } finally {
      item.classList.remove('pending')
      // The bubbles just added carry no ids; the next refresh redraws from the server.
      newest = null
      running = false
      update()
    }
  }

  /**
   * Catches up with what happened while the app was away (a routine may have run): redraws
   * the newest page if it changed and follows a job still in progress.
   */
  async function refresh(): Promise<void> {
    if (running || refreshing) return
    refreshing = true
    try {
      const [page, now] = await Promise.all([agent.history(), agent.status()])
      const last = page.at(-1)?.id ?? null
      if (last !== newest) {
        const stick = nearBottom()
        list.replaceChildren(...page.map(bubble))
        oldest = page[0]?.id
        newest = last
        older.hidden = page.length < HISTORY_PAGE_SIZE
        if (stick) scrollDown()
      }
      const job = now.job && (now.job.status === 'queued' || now.job.status === 'running') ? now.job.id : null
      refreshing = false
      if (job && !running) {
        scrollDown()
        await stream(job)
      }
    } catch (e) {
      if (e instanceof ApprovalRequired) return waiting()
      status.textContent = errorText(e)
    } finally {
      refreshing = false
    }
  }

  function routines(): void {
    openRoutines(agent, {
      ran: () => { newest = null; void refresh() },
      approvalLost: waiting,
      errorText,
    })
  }

  const form = el('form', {
    class: 'composer',
    onsubmit: async (e: Event) => {
      e.preventDefault()
      if (send.disabled) return
      const text = input.value
      running = true
      update()
      status.textContent = ''
      try {
        const job = await agent.send(text)
        list.append(bubble({ role: 'user', text: text.trim(), atMs: Date.now() }))
        input.value = ''
        await stream(job)
      } catch (err) {
        if (err instanceof ApprovalRequired) return waiting()
        status.textContent = errorText(err)
        running = false
        update()
      }
    },
  }, input, el('div', { class: 'row' }, counter, send))
  input.addEventListener('input', update)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit()
  })
  older.addEventListener('click', () => void loadOlder())

  show(
    el('header', { class: 'bar' }, el('h1', {}, 'hagent'), el('div', { class: 'tools' },
      el('button', { type: 'button', onclick: routines }, '루틴'),
      el('button', { type: 'button', onclick: settings }, '설정'))),
    el('section', { class: 'thread' }, older, list),
    el('footer', { class: 'dock' }, status, form),
  )
  onVisible = () => void refresh()
  update()
  await loadOlder()
  scrollDown()
  if (activeJob) await stream(activeJob)
}

function settings(): void {
  const note = el('p', { class: 'note' })
  const dialog = el('dialog', { class: 'sheet' })
  const add = el('button', {
    type: 'button',
    onclick: async () => {
      add.disabled = true
      note.textContent = ''
      try {
        const n = await registerPasskey()
        note.textContent = `패스키를 등록했어요 (모두 ${n}개). 다른 기기에서 '패스키로 기존 계정 찾기'로 들어올 수 있어요.`
      } catch (e) {
        note.textContent = errorText(e)
      } finally {
        add.disabled = false
      }
    },
  }, '패스키 등록')
  dialog.append(
    el('h2', {}, '설정'),
    el('p', {}, '계정 코드 ', el('span', { class: 'code small' }, accountCode())),
    el('p', { class: 'muted' }, passkeySupported()
      ? '패스키를 등록해 두면 기기를 바꾸거나 브라우저 데이터를 지워도 이 계정으로 돌아올 수 있어요.'
      : '이 브라우저는 패스키를 지원하지 않아요.'),
    el('div', { class: 'actions' },
      passkeySupported() ? add : null,
      el('button', { type: 'button', class: 'danger', onclick: () => void forgetThisDevice() }, '이 기기 데이터 지우기'),
      el('button', { type: 'button', onclick: () => dialog.close() }, '닫기')),
    note)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}

/** The error boundary: anything unexpected ends here, with a way out. */
function fatal(e: unknown): void {
  console.error(e)
  show(el('section', { class: 'card' },
    el('h1', {}, '문제가 생겼어요'),
    el('p', {}, errorText(e)),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', type: 'button', onclick: () => location.reload() }, '새로고침'),
      el('button', { type: 'button', class: 'danger', onclick: () => void forgetThisDevice() }, '이 기기 데이터 지우기'))))
}

window.addEventListener('error', e => fatal(e.error ?? e.message))
window.addEventListener('unhandledrejection', e => fatal(e.reason))

// Requests start only when the person acts: a first visit shows the welcome screen, and a
// device that already signed in before goes straight on.
void server.hasIdentity().then(known => (known ? enter() : welcome()), fatal)
