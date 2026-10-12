export type SidecarModel = { model: string; effort: string | null }

export type SidecarAgent = {
  id: string
  parentId: string | null
  type: string
  description: string
  status: string
  lastTool: string | null
  firstSeen: number
  endedAt: number | null
}

export type SidecarLogLine = { kind: 'prompt' | 'text' | 'tool' | 'result' | 'error'; text: string }

export type SidecarAgentLog = { agentId: string; lines: SidecarLogLine[]; denied: string | null }

export type SidecarLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type SidecarContextRow = { name: string; percent: number }

export type SidecarContext = {
  percent: number | null
  window: number
  rows: SidecarContextRow[]
}

export type SidecarFileChange = {
  path: string
  name: string
  dir: string
  added: number
  removed: number
  edits: number
  at: number
  preview: string[]
}

export type SidecarCacheUsage = { read: number; write: number; uncached: number }

export type SidecarKeepWarm = {
  // When the keep-warm window ends
  until: number
  lastPing: { at: number; read: number; write: number } | null
  // Why keep-warm stopped by itself; null while it runs
  stopped: string | null
}

export type SidecarCache = {
  // When the main loop last sent a request; null before the first or after a compaction or /clear
  lastRequestAt: number | null
  ttlMs: number
  last: SidecarCacheUsage | null
  keepWarm: SidecarKeepWarm | null
}

declare module 'claude-code' {
  interface PluginState {
    sidecar: {
      model: SidecarModel | null
      agents: SidecarAgent[]
      viewing: string | null
      isFollowing: boolean
      agentLog: SidecarAgentLog | null
      limits: SidecarLimit[]
      context: SidecarContext | null
      cache: SidecarCache
      files: SidecarFileChange[]
    }
  }
}
