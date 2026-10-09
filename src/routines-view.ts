/**
 * The routines dialog: the person's routines (at most three), a form to add or change one,
 * "run now", and turning this device's notifications on or off.
 */
import { MAX_ROUTINE_NAME, MAX_ROUTINE_PROMPT, MAX_ROUTINES, ApprovalRequired, type Agent, type Routine, type RoutineDraft } from './agent.ts'
import { el } from './dom.ts'
import { disablePush, enablePush, pushState, refreshPush, type PushState } from './push.ts'
import { DAY_NAMES, describeDays, draftProblem, formatMinute, formatWhen, parseTime } from './routines.ts'

export interface RoutineHooks {
  /** A routine was started now; the chat should show it. */
  ran: (job: string) => void
  /** The account lost its approval. */
  approvalLost: () => void
  errorText: (e: unknown) => string
}

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: '이 브라우저는 알림을 받을 수 없어요.',
  'needs-install': '아이폰·아이패드는 Safari의 공유 버튼 → "홈 화면에 추가"로 설치한 앱에서 알림을 켤 수 있어요.',
  denied: '이 사이트의 알림이 막혀 있어요. 브라우저나 기기 설정에서 허용해 주세요.',
  off: '루틴이 끝나면 이 기기로 알림을 보낼 수 있어요.',
  on: '루틴이 끝나면 이 기기로 알림을 보내요.',
}

export function openRoutines(agent: Agent, hooks: RoutineHooks): void {
  const dialog = el('dialog', { class: 'sheet wide' })
  const note = el('p', { class: 'note', role: 'status' })
  const list = el('ul', { class: 'routines' })
  const add = el('button', { type: 'button', class: 'primary', hidden: true }, '루틴 추가')
  const body = el('div', {}, el('p', { class: 'muted' }, '불러오는 중…'))
  const pushNote = el('p', { class: 'muted' })
  const pushButton = el('button', { type: 'button', hidden: true })
  let routines: Routine[] = []
  let push: PushState = 'unsupported'

  function fail(e: unknown): void {
    if (e instanceof ApprovalRequired) {
      dialog.close()
      hooks.approvalLost()
      return
    }
    note.textContent = hooks.errorText(e)
  }

  /** Disables `button` while `work` runs and reports what goes wrong. */
  async function act(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
    button.disabled = true
    note.textContent = ''
    try {
      await work()
    } catch (e) {
      fail(e)
    } finally {
      button.disabled = false
    }
  }

  function showPush(state: PushState): void {
    push = state
    pushNote.textContent = PUSH_TEXT[state]
    pushButton.textContent = state === 'on' ? '이 기기 알림 끄기' : '이 기기에서 알림 받기'
    pushButton.hidden = state !== 'on' && state !== 'off'
  }
  pushButton.addEventListener('click', () => void act(pushButton, async () => {
    showPush(push === 'on' ? await disablePush(agent) : await enablePush(agent))
  }))

  function item(r: Routine): HTMLElement {
    const run = el('button', { type: 'button' }, '지금 실행')
    run.addEventListener('click', () => void act(run, async () => {
      const job = await agent.runRoutine(r.id)
      dialog.close()
      hooks.ran(job)
    }))
    const remove = el('button', { type: 'button', class: 'danger' }, '삭제')
    remove.addEventListener('click', () => void act(remove, async () => {
      if (!confirm(`'${r.name}' 루틴을 지울까요?`)) return
      await agent.deleteRoutine(r.id)
      routines = routines.filter(x => x.id !== r.id)
      showList()
    }))
    const when = `${describeDays(r.days)} ${formatMinute(r.minute)}`
      + (!r.enabled ? ' · 꺼짐' : r.nextRunMs ? ` · 다음 ${formatWhen(r.nextRunMs)}` : '')
    return el('li', { class: 'routine' },
      el('div', { class: 'name' }, r.name),
      el('div', { class: 'muted' }, when),
      el('div', { class: 'prompt' }, r.prompt),
      el('div', { class: 'actions' }, run, el('button', { type: 'button', onclick: () => showForm(r) }, '편집'), remove))
  }

  function showList(): void {
    list.replaceChildren(...routines.map(item))
    if (!routines.length) list.append(el('li', { class: 'muted' }, '아직 루틴이 없어요.'))
    add.hidden = routines.length >= MAX_ROUTINES
    body.replaceChildren(list, add)
  }
  add.addEventListener('click', () => showForm())

  function showForm(r?: Routine): void {
    note.textContent = ''
    const name = el('input', { type: 'text', maxlength: String(MAX_ROUTINE_NAME), required: true, placeholder: '예: 아침 뉴스' })
    name.value = r?.name ?? ''
    const prompt = el('textarea', { rows: '4', maxlength: String(MAX_ROUTINE_PROMPT), required: true,
      placeholder: '예: 오늘 주요 뉴스를 세 줄로 정리해 줘' })
    prompt.value = r?.prompt ?? ''
    const time = el('input', { type: 'time', required: true })
    time.value = formatMinute(r?.minute ?? 8 * 60)
    const days = DAY_NAMES.map((day, i) => {
      const box = el('input', { type: 'checkbox' })
      box.checked = r ? (r.days & (1 << i)) !== 0 : true
      return { box, label: el('label', { class: 'day' }, box, day) }
    })
    const enabled = el('input', { type: 'checkbox' })
    enabled.checked = r?.enabled ?? true
    const save = el('button', { type: 'submit', class: 'primary' }, '저장')
    const field = (text: string, input: HTMLElement) => el('label', { class: 'field' }, el('span', {}, text), input)

    const form = el('form', {
      class: 'routine-form',
      onsubmit: (e: Event) => {
        e.preventDefault()
        const draft: RoutineDraft = {
          ...(r ? { id: r.id } : {}),
          name: name.value.trim(),
          prompt: prompt.value.trim(),
          days: days.reduce((bits, d, i) => (d.box.checked ? bits | (1 << i) : bits), 0),
          minute: parseTime(time.value) ?? -1,
          enabled: enabled.checked,
        }
        const problem = draftProblem(draft)
        if (problem) {
          note.textContent = problem
          return
        }
        void act(save, async () => {
          const saved = await agent.saveRoutine(draft)
          routines = r ? routines.map(x => (x.id === saved.id ? saved : x)) : [...routines, saved]
          showList()
        })
      },
    },
    field('이름', name),
    field('할 일', prompt),
    el('div', { class: 'row' }, field('시각 (한국 시간)', time), el('label', { class: 'toggle' }, enabled, '켜기')),
    el('fieldset', { class: 'days' }, el('legend', {}, '요일'), ...days.map(d => d.label)),
    el('div', { class: 'actions' }, save, el('button', { type: 'button', onclick: () => { note.textContent = ''; showList() } }, '취소')))
    body.replaceChildren(form)
    name.focus()
  }

  dialog.append(
    el('h2', {}, '루틴'),
    el('p', { class: 'muted' }, `정한 요일·시각에 에이전트가 할 일을 하고 답장을 대화에 남겨요. ${MAX_ROUTINES}개까지 만들 수 있어요.`),
    el('section', { class: 'push' }, pushNote, pushButton),
    body,
    note,
    el('div', { class: 'actions end' }, el('button', { type: 'button', onclick: () => dialog.close() }, '닫기')))
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()

  void (async () => {
    try {
      const [mine, state] = await Promise.all([agent.routines(), pushState()])
      routines = mine
      showList()
      showPush(state)
      // The server may have dropped this browser (say, after a push failed); remind it.
      if (state === 'on') await refreshPush(agent)
    } catch (e) {
      body.replaceChildren()
      fail(e)
    }
  })()
}
