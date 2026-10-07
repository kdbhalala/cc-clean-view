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
