export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
}

export type CleanViewPhase = 'idle' | 'working' | 'needs-you' | 'stuck' | 'stopped' | 'done'

/** What the job changed, collected from the tool calls themselves (never written by a model). */
export type CleanViewChanges = {
  /** Names of files changed in place. */
  edited: string[]
  /** Names of files created. */
  created: string[]
  /** Commands run; what they changed can't be seen from here. */
  commands: number
}

/** A helper (sub-agent) Claude started, shown under the step it was started for. */
export type CleanViewHelper = {
  /** The id of the call that started it. */
  id: string
  /** Set once known; a background helper reports back under it. */
  agentId: string | null
  name: string
  status: 'working' | 'done' | 'failed'
  /** The step it belongs to; null when started before any plan. */
  taskId: string | null
  startedAt: number
  finishedAt: number | null
}

export type CleanViewChecklist = {
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number | null
  finishedAt: number | null
  isCollapsed: boolean
  /** True once Claude laid out a real plan (plan_steps or its to-do list). */
  isPlanned: boolean
  changes: CleanViewChanges
  helpers: CleanViewHelper[]
  /** The person opened the "Show changes" list. */
  isShowingChanges: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clean-view': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist
      tick: number
    }
  }
}
