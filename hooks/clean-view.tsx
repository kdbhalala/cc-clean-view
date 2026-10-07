import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, ToolCallInput, ToolCallResult, TurnCompleteInput } from 'claude-code'

import type {
  CleanViewChanges, CleanViewChecklist, CleanViewHelper, CleanViewPhase, CleanViewTask, CleanViewTaskStatus,
} from '../types'

type Engine = EngineInterface
type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const PROGRESS_TOOL = 'mcp__clean-view__report_progress'
// Looking around never needs a plan; only actions that change things do.
const ALWAYS_ALLOWED = new Set([
  'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'Skill',
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', PLAN_TOOL, PROGRESS_TOOL,
])
const MAX_LISTED_CHANGES = 8
const METER = 10
const MAX_NAME = 40
const BUTTON_COLUMNS = 22
const CHANGES_BUTTON_COLUMNS = 17
const COLLAPSE_MS = 5000
const FAILS_BEFORE_STUCK = 3

const NEEDS_OK = 'Claude needs your OK to continue'
const HAS_QUESTION = 'Claude has a question for you'
const WAITING_REPLY = 'Claude is waiting for your reply'
const SAID_NO = 'you said no to a step, so Claude paused'
const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
const REFUSED = "Claude couldn't help with that request"
const GENERIC_ERROR = 'something went wrong, try again in a moment'
const GATE_MESSAGE =
  `Clean View: call ${PLAN_TOOL} first to lay out the steps of this job in plain English ` +
  '(load it with ToolSearch if it is deferred), then try this again.'

const NO_CHANGES: CleanViewChanges = { edited: [], created: [], commands: 0 }

const IDLE: CleanViewChecklist = {
  title: '', phase: 'idle', tasks: [], needsYouReason: null, stuckReason: null,
  startedAt: null, finishedAt: null, isCollapsed: false, isPlanned: false,
  changes: NO_CHANGES, helpers: [], isShowingChanges: false,
}

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, IDLE)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// Module-local: lost on a hot reload, which only resets a failure count or a timer.
let ticker: { cancel: () => void } | undefined
let failStreak = 0
let lastErrorKind: string | undefined
/** What the newest running tool call would do, in plain words, for a permission prompt it raises. */
let pendingAsk: string | undefined
/** Who made that call: Claude itself or one of its helpers. */
let pendingWho = 'Claude'

// ---------- plain names ----------

const CODE_FILE =
  /^[\w.-]+\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|json|ya?ml|toml|md|mdx|html?|css|scss|sass|less|sql|lock|dart|vue|svelte|xml|gradle|ini|cfg|conf|env)$/i

export function cleanName(raw: string): string {
  const words = String(raw ?? '')
    .replace(/`[^`]*`?/g, ' ')
    .split(/\s+/)
    .filter(word => {
      const bare = word.replace(/^[("'[]+/, '').replace(/[)"'\],.;:!?]+$/, '')
      return !/[/\\]/.test(word) && !CODE_FILE.test(bare)
    })
  const text = words.join(' ').trim()
  if (!text) return 'Working on it'
  const named = text.charAt(0).toUpperCase() + text.slice(1)
  if (named.length <= MAX_NAME) return named
  const cut = named.slice(0, MAX_NAME - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`
}

function shortTitle(raw: string): string {
  const line = raw.split('\n').find(l => l.trim()) ?? ''
  const bare = line.replace(/^[\s"'“*#]+|[\s"'”*.!]+$/g, '')
  return cleanName(bare).replace(/…$/, '').split(' ').slice(0, 6).join(' ')
}

const clampPercent = (value: unknown): number =>
  Math.min(100, Math.max(0, Math.round(Number(value) || 0)))

// ---------- checklist transitions (pure) ----------

function makeTask(id: string, name: string, status: CleanViewTaskStatus, prev?: CleanViewTask): CleanViewTask {
  const isDone = status === 'done'
  return {
    id,
    name: cleanName(name),
    status,
    percent: isDone ? 100 : prev?.percent ?? 0,
    hasReported: isDone || (prev?.hasReported ?? false),
  }
}

/** Keeps exactly one active step: the first active one, else the first upcoming one. */
function settle(tasks: CleanViewTask[]): CleanViewTask[] {
  const firstActive = tasks.findIndex(t => t.status === 'active')
  const at = firstActive >= 0 ? firstActive : tasks.findIndex(t => t.status === 'upcoming')
  return tasks.map((t, i) => {
    if (i === at) return t.status === 'active' ? t : { ...t, status: 'active' }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })
}

/** A job starts as one quiet line; steps appear only once Claude plans real work. */
function newJob(now: number, title = 'Your request'): CleanViewChecklist {
  return { ...IDLE, title, phase: 'working', startedAt: now }
}

const isActiveJob = (c: CleanViewChecklist): boolean =>
  c.phase === 'working' || c.phase === 'needs-you' || c.phase === 'stuck'

const hasUnfinished = (c: CleanViewChecklist): boolean => c.tasks.some(t => t.status !== 'done')

function startTurn(c: CleanViewChecklist, text: string, now: number): CleanViewChecklist {
  const prompt = text.trim()
  const isReply = c.phase === 'needs-you' && c.isPlanned && hasUnfinished(c)
  if (isReply) return { ...c, phase: 'working', needsYouReason: null, stuckReason: null, finishedAt: null }
  // A turn woken by a helper reporting back (or any system notice) continues the job it belongs to.
  const isWakeUp = prompt.startsWith('<') || (c.phase === 'working' && hasWorkingHelpers(c))
  if (prompt === '' || prompt.startsWith('/') || isWakeUp) return c
  const title = shortTitle(prompt)
  return newJob(now, title === 'Working on it' ? 'Your request' : title)
}

export function applyPlan(c: CleanViewChecklist, names: readonly string[], now: number): CleanViewChecklist {
  // A plan laid after a job ended (done, stopped) starts a fresh one rather than a list stuck on "All done".
  const base = isActiveJob(c) ? c : newJob(now, c.title || undefined)
  const tasks = names.slice(0, 8).map((name, i) => makeTask(`step-${i}`, name, 'upcoming'))
  return { ...base, isPlanned: true, tasks: settle(tasks) }
}

export function applyProgress(c: CleanViewChecklist, rawName: string, rawPercent: unknown): CleanViewChecklist {
  const name = cleanName(rawName)
  const percent = clampPercent(rawPercent)
  let tasks = c.tasks
  let at = tasks.findIndex(t => t.name.toLowerCase() === name.toLowerCase())
  if (at < 0) {
    // A new step goes where the current one stands, so it checks off no planned step.
    const current = tasks.findIndex(t => t.status !== 'done')
    at = current < 0 ? tasks.length : current
    tasks = [...tasks.slice(0, at), makeTask(`extra-${name}`, name, 'upcoming'), ...tasks.slice(at)]
  }
  const updated = tasks.map((t, i): CleanViewTask => {
    if (i < at) return t.status === 'done' ? t : { ...t, status: 'done', percent: 100, hasReported: true }
    if (i === at) return { ...t, status: percent >= 100 ? 'done' : 'active', percent, hasReported: true }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })
  return { ...c, tasks: settle(updated) }
}

const TODO_STATUS = { completed: 'done', in_progress: 'active', pending: 'upcoming' } as const

function applyTodos(c: CleanViewChecklist, todos: readonly Todo[]): CleanViewChecklist {
  if (todos.length === 0) return c
  const tasks = todos.map((todo, i) =>
    makeTask(`todo-${i}`, todo.content, TODO_STATUS[todo.status], c.tasks.find(t => t.name === cleanName(todo.content))))
  return { ...c, isPlanned: true, tasks: settle(tasks) }
}

function applyTaskCreate(c: CleanViewChecklist, id: string, subject: string): CleanViewChecklist {
  const kept = c.isPlanned ? c.tasks : []
  return { ...c, isPlanned: true, tasks: settle([...kept, makeTask(`task-${id}`, subject, 'upcoming')]) }
}

function applyTaskUpdate(c: CleanViewChecklist, id: string, status?: string, subject?: string): CleanViewChecklist {
  const key = `task-${id}`
  if (status === 'deleted') return { ...c, tasks: settle(c.tasks.filter(t => t.id !== key)) }
  const next = status === 'completed' ? 'done' : status === 'in_progress' ? 'active' : status === 'pending' ? 'upcoming' : undefined
  const tasks = c.tasks.map((t): CleanViewTask => {
    if (t.id !== key) return next === 'active' && t.status === 'active' ? { ...t, status: 'upcoming' } : t
    const renamed = subject ? { ...t, name: cleanName(subject) } : t
    return next ? { ...makeTask(key, renamed.name, next, renamed) } : renamed
  })
  return { ...c, tasks: settle(tasks) }
}

function withNeedsYou(c: CleanViewChecklist, reason: string): CleanViewChecklist {
  return isActiveJob(c) ? { ...c, phase: 'needs-you', needsYouReason: reason } : c
}

function withStuck(c: CleanViewChecklist, reason: string): CleanViewChecklist {
  return isActiveJob(c) ? { ...c, phase: 'stuck', stuckReason: reason, needsYouReason: null } : c
}

export function errorReason(kind: string | undefined, text: string): string {
  const said = `${kind ?? ''} ${text}`.toLowerCase()
  if (/rate_limit|billing|usage limit|rate limit|\b429\b/.test(said)) return 'you hit your usage limit, try again a little later'
  if (/overloaded|server_error|\b529\b|\b50[023]\b/.test(said)) return "Claude's servers are busy, try again in a minute"
  if (/too long|context|max_output_tokens|too many tokens/.test(said)) return 'type /compact and try again'
  if (/authentication|oauth|credential|login|\b401\b|\b403\b|api key/.test(said)) return 'type /login'
  if (/network|connection|econn|fetch failed|timed? ?out|socket|offline/.test(said)) return 'the internet connection dropped'
  return GENERIC_ERROR
}

function endTurn(c: CleanViewChecklist, e: TurnCompleteInput, now: number): CleanViewChecklist {
  if (c.phase === 'idle' || c.phase === 'done' || c.phase === 'stopped') return c
  const ended = { ...c, finishedAt: now, needsYouReason: null }
  if (e.reason === 'error') return { ...ended, phase: 'stuck', stuckReason: errorReason(lastErrorKind, e.answer) }
  if (e.reason === 'refusal') return { ...ended, phase: 'stuck', stuckReason: REFUSED }
  if (e.reason === 'aborted') {
    return c.phase === 'stuck' && c.stuckReason === SAID_NO ? ended : { ...ended, phase: 'stopped', stuckReason: null }
  }
  // Helpers still running in the background: the job isn't over, Claude will be woken when they report.
  if (hasWorkingHelpers(c)) return c
  if (c.isPlanned && hasUnfinished(c)) {
    return { ...c, phase: 'needs-you', needsYouReason: WAITING_REPLY, stuckReason: null }
  }
  // A quick answer that changed nothing ends like normal chat: no card at all.
  if (!c.isPlanned && !hasChanges(changesOf(c))) return IDLE
  const tasks = c.tasks.map((t): CleanViewTask => ({ ...t, status: 'done', percent: 100, hasReported: true }))
  return { ...ended, phase: 'done', stuckReason: null, isCollapsed: false, tasks }
}

type Outcome = { failed: boolean; saidNo: boolean; streak: number }

function outcomeOf(ran: ToolCallResult, streak: number): Outcome {
  const failed = ran.deny === undefined && ran.isError === true
  const saidNo = failed && /doesn't want to proceed|was rejected|user (denied|rejected)/i.test(String(ran.text ?? ''))
  return { failed, saidNo, streak: failed && !saidNo ? streak + 1 : 0 }
}

// ---------- helpers (sub-agents) ----------

/** State written before this field existed (it survives reloads) reads as no helpers. */
const helpersOf = (c: CleanViewChecklist): CleanViewHelper[] => c.helpers ?? []

const hasWorkingHelpers = (c: CleanViewChecklist): boolean => helpersOf(c).some(h => h.status === 'working')

function addHelper(c: CleanViewChecklist, id: string, description: string, now: number): CleanViewChecklist {
  if (!isActiveJob(c)) return c
  const helper: CleanViewHelper = {
    id, agentId: null, name: cleanName(description), status: 'working',
    taskId: c.tasks.find(t => t.status === 'active')?.id ?? null, startedAt: now, finishedAt: null,
  }
  return { ...c, helpers: [...helpersOf(c), helper] }
}

function updateHelper(
  c: CleanViewChecklist, matches: (h: CleanViewHelper) => boolean, fn: (h: CleanViewHelper) => CleanViewHelper,
): CleanViewChecklist {
  return { ...c, helpers: helpersOf(c).map(h => (matches(h) ? fn(h) : h)) }
}

/** The Agent call came back: a foreground helper is finished, a background one is now known by its id. */
function settleHelper(c: CleanViewChecklist, id: string, ran: ToolCallResult, now: number): CleanViewChecklist {
  const record = ran.result as { status?: string; agentId?: string } | undefined
  const failed = ran.deny !== undefined || ran.isError === true
  const isBackground = !failed && record?.status === 'async_launched'
  return updateHelper(c, h => h.id === id, h => ({
    ...h,
    agentId: record?.agentId ?? h.agentId,
    status: isBackground ? 'working' : failed ? 'failed' : 'done',
    finishedAt: isBackground ? null : now,
  }))
}

/** A helper's own run ended (how a background helper reports back). */
function finishHelper(c: CleanViewChecklist, agentId: string, reason: string, now: number): CleanViewChecklist {
  return updateHelper(c, h => h.agentId === agentId && h.status === 'working', h => ({
    ...h, status: reason === 'answer' ? 'done' : 'failed', finishedAt: now,
  }))
}

// ---------- the "what changed" receipt ----------

/** State written before this field existed (it survives reloads) reads as no changes. */
const changesOf = (c: CleanViewChecklist): CleanViewChanges => c.changes ?? NO_CHANGES

const hasChanges = (ch: CleanViewChanges): boolean => ch.edited.length + ch.created.length + ch.commands > 0

const fileName = (path: unknown): string => String(path ?? '').split(/[/\\]/).pop() || 'a file'

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

function recordChange(ch: CleanViewChanges, e: ToolCallInput, ran: ToolCallResult): CleanViewChanges {
  const add = (list: string[], name: string): string[] => (list.includes(name) ? list : [...list, name])
  if (e.tool === 'Edit' || e.tool === 'NotebookEdit') {
    const name = fileName(e.tool === 'Edit' ? e.file_path : e.notebook_path)
    return ch.created.includes(name) ? ch : { ...ch, edited: add(ch.edited, name) }
  }
  if (e.tool === 'Write') {
    const name = fileName(e.file_path)
    const isNew = (ran.result as { type?: string } | undefined)?.type === 'create'
    return isNew ? { ...ch, created: add(ch.created, name) } : { ...ch, edited: add(ch.edited, name) }
  }
  if (e.tool === 'Bash') return { ...ch, commands: ch.commands + 1 }
  return ch
}

/** The "Show changes" list: each file by name, and an honest note about what can't be seen. */
function changeLines(ch: CleanViewChanges): { text: string; isNote: boolean }[] {
  const files = [
    ...ch.created.map(name => ({ text: `+ created ${name}`, isNote: false })),
    ...ch.edited.map(name => ({ text: `✎ changed ${name}`, isNote: false })),
  ]
  const hidden = files.length - MAX_LISTED_CHANGES
  return [
    ...files.slice(0, MAX_LISTED_CHANGES),
    ...(hidden > 0 ? [{ text: `  and ${plural(hidden, 'more file', 'more files')}`, isNote: true }] : []),
    ...(ch.commands > 0
      ? [{ text: `Ran ${plural(ch.commands, 'command', 'commands')}: commands can change things this list can't show.`, isNote: true }]
      : []),
  ]
}

/** "changed 3 files · created 1 · ran 2 commands", counted from the tool calls, never guessed. */
export function receiptText(ch: CleanViewChanges): string {
  const parts = [
    ch.edited.length > 0 ? `changed ${plural(ch.edited.length, 'file', 'files')}` : '',
    ch.created.length > 0 ? `created ${plural(ch.created.length, 'file', 'files')}` : '',
    ch.commands > 0 ? `ran ${plural(ch.commands, 'command', 'commands')}` : '',
  ]
  return parts.filter(Boolean).join(' · ')
}

/** What a tool call would do, for "Claude needs your OK …", from a fixed table (no model call). */
export function describeAsk(e: ToolCallInput): string {
  if (e.tool === 'Edit') return `to change ${fileName(e.file_path)}`
  if (e.tool === 'NotebookEdit') return `to change ${fileName(e.notebook_path)}`
  if (e.tool === 'Write') return `to save ${fileName(e.file_path)}`
  if (e.tool === 'Bash') {
    if (/\b(rm|rmdir|unlink|trash|shred)\b/.test(e.command)) return 'to delete something'
    if (/\b(git push|npm publish|curl|wget|scp|rsync)\b/.test(e.command)) return 'to send or fetch something online'
    if (/\b(npm|pnpm|yarn|pip|brew|cargo) (i|install|add)\b/.test(e.command)) return 'to install something'
    return 'to run a command'
  }
  if (e.tool === 'WebFetch' || e.tool === 'WebSearch') return 'to look something up online'
  if (e.tool === 'Agent') return 'to start a helper'
  return 'to continue'
}

function afterTool(c: CleanViewChecklist, e: ToolCallInput, ran: ToolCallResult, { failed, saidNo, streak }: Outcome): CleanViewChecklist {
  if (!isActiveJob(c)) return c
  let next = failed ? c : { ...c, changes: recordChange(changesOf(c), e, ran) }
  if (!failed && e.tool === 'TodoWrite') next = applyTodos(next, e.todos)
  if (!failed && e.tool === 'TaskCreate') {
    const id = (ran.result as { task?: { id?: string } } | undefined)?.task?.id
    if (id !== undefined) next = applyTaskCreate(next, id, e.subject)
  }
  if (!failed && e.tool === 'TaskUpdate') next = applyTaskUpdate(next, e.taskId, e.status, e.subject)

  // The tool ran, so whatever Claude was waiting on (an OK, an answer) has been given.
  if (next.phase === 'needs-you') next = { ...next, phase: 'working', needsYouReason: null }
  if (saidNo) return withStuck(next, SAID_NO)
  if (streak >= FAILS_BEFORE_STUCK) return withStuck(next, KEEPS_FAILING)
  if (!failed && next.phase === 'stuck') return { ...next, phase: 'working', stuckReason: null }
  return next
}

const needsPlan = (c: CleanViewChecklist): boolean => isActiveJob(c) && !c.isPlanned

// ---------- engine glue ----------

function syncClock($: Engine, phase: CleanViewPhase): void {
  const shouldTick = phase === 'working' || phase === 'needs-you'
  if (shouldTick && !ticker) ticker = $.clock.every(250, () => void update($, tickAtom, n => n + 1))
  if (!shouldTick && ticker) {
    ticker.cancel()
    ticker = undefined
  }
}

async function change($: Engine, fn: (c: CleanViewChecklist) => CleanViewChecklist): Promise<CleanViewChecklist> {
  await update($, checklistAtom, fn)
  const c = await read($, checklistAtom)
  syncClock($, c.phase)
  return c
}

async function setEnabled($: Engine, isEnabled: boolean): Promise<void> {
  await update($, enabledAtom, () => isEnabled)
  await $.store.set('cleanViewEnabled', isEnabled)
  $.ui.toast(isEnabled ? 'Clean View is on: technical details are hidden' : 'Clean View is off: every step is shown in full')
}

function guideText(tools: readonly string[]): string {
  const hasTodos = tools.includes('TodoWrite') || tools.includes('TaskCreate')
  return [
    '# Clean View',
    'Clean View is on. The person using this session is not technical: instead of tool calls they see a plain checklist of your steps.',
    '- A quick answer that needs no actions needs no plan: just answer. Reading and looking things up never need one.',
    `- Before anything that changes things (editing or creating files, running commands, starting helpers), call ${PLAN_TOOL} with every step of the job in order (2 to 8 steps). If it is deferred, load it with ToolSearch first. Those actions are blocked until a plan exists.`,
    '- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".',
    '- Never put file paths, file names, commands, code or tool names in a step name.',
    `- Call ${PROGRESS_TOOL} with the step name and a percent as real progress happens, and with 100 the moment a step finishes.`,
    ...(hasTodos ? ['- You may use your to-do list (TodoWrite or TaskCreate) as the plan instead; the same naming rules apply.'] : []),
  ].join('\n')
}

const PLAN_SPEC = {
  name: 'plan_steps',
  description:
    'Lay out every step of the job up front, before any action that changes things: 2 to 8 short plain-English step names in order, ' +
    'each under 40 characters and starting with a verb ("Build the pricing section"). No file paths, file names, ' +
    'commands, code or tool names. The first step starts right away.',
  inputSchema: {
    type: 'object',
    properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 } },
    required: ['steps'],
  },
}

const PROGRESS_SPEC = {
  name: 'report_progress',
  description:
    'Report progress on the current step: its name exactly as planned and a percent from 0 to 100. ' +
    'Call with 100 the moment a step finishes; the next step then starts and earlier steps are checked off.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string' }, percent: { type: 'number', minimum: 0, maximum: 100 } },
    required: ['task', 'percent'],
  },
}

// ---------- drawing ----------

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

const EIGHTHS = ' ▏▎▍▌▋▊▉'
const SWEEP = '▒▓█▓▒'

function meterFor(t: CleanViewTask, frame: number): string {
  if (t.status === 'done') return '█'.repeat(METER)
  if (t.status === 'upcoming') return '░'.repeat(METER)
  if (t.hasReported) {
    // Eighth-cell blocks, so every percent moves the bar a little.
    const eighths = Math.round((t.percent / 100) * METER * 8)
    const full = Math.floor(eighths / 8)
    const part = full < METER ? EIGHTHS[eighths % 8]?.trim() ?? '' : ''
    return '█'.repeat(full) + part + '░'.repeat(METER - full - part.length)
  }
  const at = (frame % (METER + SWEEP.length)) - SWEEP.length // a soft glow sliding across
  return Array.from({ length: METER }, (_, i) => SWEEP[i - at] ?? '░').join('')
}

/** The whole job's progress: done steps count fully, the current one by its reported percent. */
function overallPercent(c: CleanViewChecklist): number {
  if (c.tasks.length === 0) return 0
  const sum = c.tasks.reduce((n, t) => n + (t.status === 'done' ? 100 : t.status === 'active' && t.hasReported ? t.percent : 0), 0)
  return Math.round(sum / c.tasks.length)
}

const PHASE_COLOR: Record<CleanViewPhase, string> = {
  idle: 'gray', working: 'cyan', 'needs-you': 'yellow', stuck: 'yellow', stopped: 'gray', done: 'green',
}

/** ` · step 2 of 4` once a real plan exists; nothing for the placeholders. */
function stepCount(c: CleanViewChecklist): string {
  if (!c.isPlanned || c.tasks.length === 0) return ''
  const active = c.tasks.findIndex(t => t.status === 'active')
  const at = active >= 0 ? active + 1 : c.tasks.filter(t => t.status === 'done').length
  return ` · step ${Math.max(1, at)} of ${c.tasks.length}`
}

const activeStep = (c: CleanViewChecklist): CleanViewTask | undefined => c.tasks.find(t => t.status === 'active')

const fit = (text: string, width: number): string =>
  text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`

// ---------- hooks ----------

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('cleanViewEnabled')
    await update($, enabledAtom, () => saved !== false)
    await $.tool.register(PLAN_SPEC)
    await $.tool.register(PROGRESS_SPEC)
    await $.command.register({ name: 'simple', description: 'Turn Clean View on or off', argumentHint: '[on|off]' })
    syncClock($, (await read($, checklistAtom)).phase)
    return next(e)
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Use /simple on, /simple off, or /simple to flip it.' }
    const isEnabled = arg === '' ? !(await read($, enabledAtom)) : arg === 'on'
    await setEnabled($, isEnabled)
    return { text: `Clean View is ${isEnabled ? 'on' : 'off'}.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await read($, enabledAtom))) return composed
    return {
      sections: [...composed.sections, { id: 'clean-view:guide', text: guideText(e.tools), scope: 'session' as const }],
    }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const before = await read($, checklistAtom)
    const after = await change($, c => startTurn(c, e.text, now))
    failStreak = 0
    lastErrorKind = undefined
    pendingAsk = undefined
    pendingWho = 'Claude'
    return next(e)
  })

  on('tool.call', { tool: 'mcp__clean-view__plan_steps' }, async ($, e) => {
    const raw = (e as unknown as { steps?: unknown }).steps
    const steps = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
    if (steps.length === 0) return { deny: 'plan_steps needs 2 to 8 short step names.' }
    const now = await $.clock.now()
    const c = await change($, list => applyPlan(list, steps, now))
    return { result: `Planned ${c.tasks.length} steps. The first one has started.` }
  })

  on('tool.call', { tool: 'mcp__clean-view__report_progress' }, async ($, e) => {
    const args = e as unknown as { task?: unknown; percent?: unknown }
    const percent = clampPercent(args.percent)
    await change($, c => applyProgress(c, String(args.task ?? ''), percent))
    return { result: `Progress noted: ${percent}%.` }
  })

  // ponytail: fails open; a broken checklist must never block real work.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool === PLAN_TOOL || tool === PROGRESS_TOOL) return next(e)
    if (e.agentId !== undefined) {
      // Helpers are never gated, but what they change still belongs on the receipt.
      pendingAsk = describeAsk(e)
      pendingWho = "Claude's helper"
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) {
        await change($, list => (isActiveJob(list) ? { ...list, changes: recordChange(changesOf(list), e, ran) } : list))
      }
      return ran
    }
    const c = await read($, checklistAtom)
    if (!ALWAYS_ALLOWED.has(tool) && needsPlan(c) && (await read($, enabledAtom))) return { deny: GATE_MESSAGE }
    if (tool === 'AskUserQuestion') await change($, list => withNeedsYou(list, HAS_QUESTION))
    pendingAsk = describeAsk(e)
    pendingWho = 'Claude'
    const helperId = e.tool === 'Agent' ? (e.tool_use_id ?? e.description) : undefined
    if (e.tool === 'Agent' && helperId !== undefined) {
      const now = await $.clock.now()
      await change($, list => addHelper(list, helperId, e.description, now))
    }
    const ran = await next(e)
    const outcome = outcomeOf(ran, failStreak)
    failStreak = outcome.streak
    const now = await $.clock.now()
    await change($, list => {
      const settled = helperId === undefined ? list : settleHelper(list, helperId, ran, now)
      return afterTool(settled, e, ran, outcome)
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const isPermission = e.notification_type === 'permission_prompt' || /permission/i.test(e.message)
    const ask = `${pendingWho} needs your OK ${pendingAsk ?? 'to continue'}`
    const reason = isPermission ? ask : e.notification_type === 'elicitation_dialog' ? HAS_QUESTION : null
    if (reason) await change($, c => withNeedsYou(c, reason))
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastErrorKind = e.error
    const reason = errorReason(e.error, e.error_details ?? '')
    await change($, c => (c.phase === 'stuck' && c.stuckReason === GENERIC_ERROR ? { ...c, stuckReason: reason } : c))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const helperAgent = e.agentId
    if (helperAgent !== undefined) {
      const now = await $.clock.now()
      await change($, list => finishHelper(list, helperAgent, e.reason, now))
    } else {
      const now = await $.clock.now()
      const c = await change($, list => endTurn(list, e, now))
      lastErrorKind = undefined
      const jobId = c.startedAt
      if (c.phase === 'done') {
        $.clock.after(COLLAPSE_MS, () =>
          void change($, list => (list.startedAt === jobId && list.phase === 'done' ? { ...list, isCollapsed: true } : list)))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabledAtom))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  // The busy line says the current step ("Build the pricing section…") instead of a whimsical word.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const step = (await read($, enabledAtom)) ? activeStep(await read($, checklistAtom)) : undefined
    return step ? next({ ...e, props: { ...e.props, message: step.name } }) : next(e)
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await read($, enabledAtom)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isEnabled = await read($, enabledAtom)
    const c = await read($, checklistAtom)
    const frame = await read($, tickAtom)
    const now = await $.clock.now()
    const showJob = isEnabled && c.phase !== 'idle'
    const showRows = showJob && !(c.phase === 'done' && c.isCollapsed)
    const showOverall = showRows && c.isPlanned
    const changes = changesOf(c)
    const receipt = receiptText(changes)
    const canShowChanges = showJob && c.phase !== 'working' && receipt !== ''
    const details = canShowChanges && c.isShowingChanges ? changeLines(changes) : []
    // Finished helpers show under their step until that step is done; running ones always show.
    // Ones started before any plan (or whose step is gone) show last.
    const openTaskIds = new Set(c.tasks.filter(t => t.status !== 'done').map(t => t.id))
    const taskIds = new Set(c.tasks.map(t => t.id))
    const helpers = showRows
      ? helpersOf(c)
        .filter(x => x.status === 'working' || (x.taskId === null ? c.phase !== 'done' : openTaskIds.has(x.taskId)))
        .map(x => (x.taskId !== null && !taskIds.has(x.taskId) ? { ...x, taskId: null } : x))
      : []
    // A rounded card when there is room for it and something to frame; flat rows otherwise.
    const rowsNeeded = 1 + (showOverall ? 1 : 0) + (showRows ? c.tasks.length : 0) + helpers.length + details.length
    const hasFrame = (showRows && (c.tasks.length > 0 || helpers.length > 0)) || details.length > 0
    const hasCard = hasFrame && rowsNeeded + 2 <= e.props.maxRows && e.props.bodyColumns >= 44
    const columns = Math.max(30, e.props.bodyColumns) - (hasCard ? 4 : 0)
    const headerColumns = columns - BUTTON_COLUMNS - (canShowChanges ? CHANGES_BUTTON_COLUMNS : 0)
    // Names column as wide as the longest name, so each bar sits right beside its step.
    const longestName = Math.max(0, ...c.tasks.map(t => t.name.length))
    const nameColumns = Math.max(6, Math.min(longestName, columns - 2 - 1 - METER - 2 - 7))
    const elapsed = formatDuration((c.finishedAt ?? now) - (c.startedAt ?? now))
    const accent = PHASE_COLOR[c.phase]

    const toggle = (
      <Button
        key="clean-view-toggle"
        label={isEnabled ? '● Clean View: ON' : '○ Clean View: OFF'}
        onPress={async () => setEnabled($, !(await read($, enabledAtom)))}
      />
    )

    const changesButton = canShowChanges && (
      <Button
        key="clean-view-changes"
        label={c.isShowingChanges ? 'Hide changes' : 'Show changes'}
        onPress={() => change($, list => ({ ...list, isShowingChanges: !list.isShowingChanges }))}
      />
    )

    const header = !showJob ? (
      <Text> </Text>
    ) : c.phase === 'needs-you' ? (
      <Box flexDirection="row">
        <Text backgroundColor="yellow" color="black" bold> Needs you </Text>
        <Text wrap="truncate-end"> {c.needsYouReason ?? NEEDS_OK}</Text>
      </Box>
    ) : c.phase === 'stuck' ? (
      <Text color="yellow" wrap="truncate-end">⚠ Stuck: {c.stuckReason ?? GENERIC_ERROR}</Text>
    ) : c.phase === 'stopped' ? (
      <Text wrap="truncate-end">■ Stopped · {c.title} · you pressed Esc</Text>
    ) : c.phase === 'done' ? (
      <Text color="green" wrap="truncate-end">✓ All done · {c.title} · took {elapsed}{receipt ? ` · ${receipt}` : ''}</Text>
    ) : (
      <Box flexDirection="row">
        <Text color={accent} bold>● </Text>
        <Text bold wrap="truncate-end">{c.title}</Text>
        <Text dimColor>{stepCount(c)} · {elapsed}</Text>
      </Box>
    )

    const firstUpcoming = c.tasks.findIndex(t => t.status === 'upcoming')
    // A helper's name spans the step-name and bar columns, so its status lines up with the step labels.
    const helperColumns = nameColumns - 2 + 1 + METER
    // Not named `h`: that name is the JSX factory.
    const helperRow = (helper: CleanViewHelper) => {
      const status = helper.status === 'working'
        ? `working · ${formatDuration(now - helper.startedAt)}`
        : helper.status === 'done' ? '✓ done' : "⚠ didn't finish"
      const color = helper.status === 'working' ? 'cyan' : helper.status === 'done' ? 'green' : 'yellow'
      return (
        <Box flexDirection="row">
          <Text dimColor>{'  ↳ '}</Text>
          <Text dimColor={helper.status !== 'working'}>{`${fit(`Helper: ${helper.name}`, helperColumns)}  `}</Text>
          <Text color={color} dimColor={helper.status === 'done'}>{status}</Text>
        </Box>
      )
    }
    const overall = overallPercent(c)
    const lineColumns = Math.max(4, columns - 6)
    const lineFilled = Math.round((overall / 100) * lineColumns)

    const body = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box width={headerColumns} flexShrink={1}>{header}</Box>
          <Box flexDirection="row" gap={1}>
            {changesButton}
            {toggle}
          </Box>
        </Box>
        {showOverall && (
          <Box flexDirection="row">
            <Text color={accent}>{'━'.repeat(lineFilled)}</Text>
            <Text dimColor>{'─'.repeat(lineColumns - lineFilled)}</Text>
            <Text color={accent} bold>{` ${String(overall).padStart(3)}%`}</Text>
          </Box>
        )}
        {showRows &&
          c.tasks.map((t, i) => {
            const isActive = t.status === 'active'
            const isDone = t.status === 'done'
            const isPaused = isActive && c.phase === 'needs-you'
            const icon = isDone ? '✓' : isActive ? (isPaused ? '‖' : '▶') : '○'
            const iconColor = isDone ? 'green' : isPaused ? 'yellow' : isActive ? 'cyan' : undefined
            const label = isDone ? 'Done' : isActive ? (t.hasReported ? `${t.percent}%` : 'Working') : i === firstUpcoming ? 'Next' : 'Up next'
            return (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text color={iconColor} bold={isActive} dimColor={!isDone && !isActive}>{`${icon} `}</Text>
                  <Text bold={isActive} dimColor={!isActive}>{`${fit(t.name, nameColumns)} `}</Text>
                  <Text color={isDone ? 'green' : isActive ? 'cyan' : undefined} dimColor={!isActive}>{meterFor(t, frame)}</Text>
                  <Text dimColor={!isActive}>{'  '}</Text>
                  <Text color={isDone ? 'green' : undefined} dimColor={!isActive} bold={isActive}>{label}</Text>
                </Box>
                {helpers.filter(h => h.taskId === t.id).map(helperRow)}
              </Box>
            )
          })}
        {helpers.filter(h => h.taskId === null).map(helperRow)}
        {details.map(line => (
          <Text dimColor={line.isNote} wrap="truncate-end">{line.text}</Text>
        ))}
      </Box>
    )

    return hasCard ? (
      <Box borderStyle="round" borderColor={accent} paddingX={1} flexDirection="column">{body}</Box>
    ) : body
  })
}
