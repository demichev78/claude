import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { SidecarAgent, SidecarAgentLog, SidecarLogLine, SidecarCache, SidecarContext, SidecarFileChange, SidecarLimit, SidecarModel } from '../types'

const PANE = 'sidecar'
const TITLE = 'Sidecar'
// Share of the terminal's width the docked pane asks for
const SHARE = 0.2
const MIN_COLUMNS = 24
const MAX_FILES = 10
const PREVIEW_LINES = 2
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const AGENT_POLL_MS = 1000
// How long a finished agent stays in the tree after the engine drops it
const AGENT_KEEP_MS = 10 * 60 * 1000
const MAX_AGENTS = 15
const ENDED = new Set(['completed', 'failed', 'killed'])
const AGENT_PANE = 'sidecar-agent'
// Share of the terminal's width the agent output window asks for
const AGENT_SHARE = 0.5
const MAX_LOG_LINES = 400
// The terminal docks a pane beside the transcript only in fullscreen from this width; below it
// the pane would sit above the prompt, so the sidecar hides instead
const DOCK_MIN_COLUMNS = 110
const HOUR_MS = 60 * 60 * 1000
const FIVE_MINUTES_MS = 5 * 60 * 1000
// How often the Cache card's countdown redraws and keep-warm checks whether a ping is due
const CACHE_TICK_MS = 15 * 1000
const KEEP_WARM_MS = 6 * HOUR_MS
const PING_PROMPT = 'Reply with the single word: warm'

// The terminal's width as last drawn, for sizing panes opened from a press
let terminalWidth = 0
// The agent poll; a reload of the module drops the old timer and this with it
let poller: { cancel: () => void } | null = null
let cacheTicker: { cancel: () => void } | null = null
// Whether a main-loop turn is under way, so keep-warm never pings in the middle of one
let isTurnRunning = false
let isPinging = false
// The sidecar closed itself because the terminal could not dock it; it reopens once it can
let isHiddenForWidth = false

const model = atom({ plugin: 'sidecar', key: 'model' } as const, null)
const viewing = atom({ plugin: 'sidecar', key: 'viewing' } as const, null)
const agentLog = atom({ plugin: 'sidecar', key: 'agentLog' } as const, null)
const isFollowing = atom({ plugin: 'sidecar', key: 'isFollowing' } as const, true)
const agents = atom({ plugin: 'sidecar', key: 'agents' } as const, [])
const limits = atom({ plugin: 'sidecar', key: 'limits' } as const, [])
const context = atom({ plugin: 'sidecar', key: 'context' } as const, null)
const files = atom({ plugin: 'sidecar', key: 'files' } as const, [])
const cache = atom({ plugin: 'sidecar', key: 'cache' } as const, { lastRequestAt: null, ttlMs: HOUR_MS, last: null, keepWarm: null })

// The dock width last asked for, so a width the person dragged is left alone
let askedColumns = 0

type Patch = { lines: string[] }[]
type EditRecord = { filePath?: string; structuredPatch?: Patch; staged?: boolean; type?: string; content?: string }
type BashEditDiff = { files?: { filePath: string; hunks: Patch; created?: true }[]; changedFiles?: string[] }

function wantedColumns(terminalColumns: number): number {
  return Math.max(MIN_COLUMNS, Math.round(terminalColumns * SHARE) - 2)
}

function limitLabel(kind: string): string {
  if (kind === 'five_hour') return 'Session (5h)'
  if (kind === 'seven_day') return 'Weekly'
  if (kind === 'spend_limit') return 'Spend limit'
  if (kind.startsWith('seven_day_')) {
    const model = kind.slice('seven_day_'.length).replace(/_/g, ' ')
    return 'Weekly ' + model.charAt(0).toUpperCase() + model.slice(1)
  }
  return kind.replace(/_/g, ' ')
}

function untilReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return ''
  const minutes = Math.round(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `resets ${days}d ${hours}h`
  if (hours > 0) return `resets ${hours}h ${minutes % 60}m`
  return `resets ${minutes}m`
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

// 12 -> 12, 2345 -> 2.3k, 157000 -> 157k, 1200000 -> 1.2M
function tokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1e4) return Math.round(n / 1000) + 'k'
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

// 45s, 42m, 1h05m
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 120) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// One decimal when there is a fractional part: 12.5 -> 12.5%, 41 -> 41%, 4.37 -> 4.4%, 5.0 -> 5%
function pct(n: number): string {
  const r = Math.round(n * 10) / 10
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + '%'
}

// Stores the main loop's model, keeping the effort last seen unless a new one is given
async function noteModel($: EngineInterface, name: string, effort?: string | number): Promise<void> {
  await update($, model, prev => {
    const next: SidecarModel = {
      model: name,
      effort: effort === undefined ? (prev?.effort ?? null) : String(effort),
    }
    return next
  })
}

// Rebuilds the agent tree from the engine's list, keeping first-seen times, last tools,
// and recently finished agents the engine has already dropped
async function refreshAgents($: EngineInterface): Promise<void> {
  const list = await $.agent.list()
  const now = Date.now()
  const prev = await read($, agents)
  const seen = new Set(list.map(a => a.id))
  const fresh: SidecarAgent[] = list.map(a => {
    const before = prev.find(p => p.id === a.id)
    const isEnded = ENDED.has(a.status)
    return {
      id: a.id,
      parentId: a.parentId ?? null,
      type: a.type,
      description: a.description,
      status: a.status,
      lastTool: before?.lastTool ?? null,
      firstSeen: before?.firstSeen ?? now,
      endedAt: isEnded ? (before?.endedAt ?? now) : null,
    }
  })
  const kept = prev
    .filter(p => !seen.has(p.id) && now - (p.endedAt ?? now) < AGENT_KEEP_MS)
    .map(p => (ENDED.has(p.status) ? p : { ...p, status: 'completed', endedAt: p.endedAt ?? now }))
  const nextList = [...fresh, ...kept].slice(-MAX_AGENTS)
  // Write while anything runs, so elapsed times tick; otherwise only on a change
  const isRunning = nextList.some(a => !ENDED.has(a.status))
  if (isRunning || JSON.stringify(nextList) !== JSON.stringify(prev)) await update($, agents, () => nextList)
}

// Starts the once-a-second agent poll if it isn't running (session start, or the first event after a reload)
function ensurePoller($: EngineInterface): void {
  if (poller) return
  poller = $.clock.every(AGENT_POLL_MS, () => {
    void refreshAgents($).catch(() => undefined)
    void refreshAgentLog($).catch(() => undefined)
  })
}

// Notes the tool a subagent is using right now
async function noteAgentTool($: EngineInterface, agentId: string, tool: string): Promise<void> {
  const list = await read($, agents)
  if (!list.some(a => a.id === agentId)) return refreshAgents($)
  await update($, agents, all => all.map(a => (a.id === agentId ? { ...a, lastTool: tool } : a)))
}

function agentIcon(status: string): { glyph: string; color: string } {
  if (status === 'running') return { glyph: '●', color: 'success' }
  if (status === 'pending' || status === 'waiting') return { glyph: '◌', color: 'warning' }
  if (status === 'idle') return { glyph: '○', color: 'inactive' }
  if (status === 'failed') return { glyph: '✗', color: 'error' }
  if (status === 'killed') return { glyph: '✗', color: 'inactive' }
  return { glyph: '✓', color: 'inactive' }
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

// Orders agents depth-first under their parents; an agent whose parent is gone is a root
function agentTree(list: SidecarAgent[]): { agent: SidecarAgent; depth: number }[] {
  const ids = new Set(list.map(a => a.id))
  const out: { agent: SidecarAgent; depth: number }[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const a of list) {
      const parent = a.parentId !== null && ids.has(a.parentId) ? a.parentId : null
      if (parent === parentId) {
        out.push({ agent: a, depth })
        if (depth < 6) walk(a.id, depth + 1)
      }
    }
  }
  walk(null, 0)
  return out
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find(l => l.trim() !== '') ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

// One short line for a tool call: its most telling argument
function describeToolUse(tool: string, input: Record<string, unknown>): string {
  const pick = ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt']
  const key = pick.find(k => typeof input[k] === 'string' && input[k] !== '')
  return key ? `${tool}: ${firstLine(String(input[key]), 120)}` : tool
}

// Reads the viewed subagent's conversation and condenses it into display lines
async function refreshAgentLog($: EngineInterface): Promise<void> {
  const agentId = await read($, viewing)
  if (!agentId) return
  const rows = await $.session.messages({ agentId })
  if (!Array.isArray(rows)) {
    await update($, agentLog, () => ({ agentId, lines: [], denied: rows.deny }))
    return
  }
  const lines: SidecarLogLine[] = []
  rows.forEach((row, i) => {
    if (row.role === 'user') {
      if (i === 0 && row.text.trim() !== '') lines.push({ kind: 'prompt', text: row.text.trim() })
      return
    }
    if (row.text.trim() !== '') lines.push({ kind: 'text', text: row.text.trim() })
    for (const use of row.toolUses) {
      lines.push({ kind: 'tool', text: describeToolUse(use.tool, use.input) })
      if (use.text !== undefined) lines.push({ kind: use.isError ? 'error' : 'result', text: firstLine(use.text) || '(no output)' })
    }
  })
  const log: SidecarAgentLog = { agentId, lines: lines.slice(-MAX_LOG_LINES), denied: null }
  const before = await read($, agentLog)
  if (JSON.stringify(before) === JSON.stringify(log)) return
  await update($, agentLog, () => log)
  // Keep the newest output in view unless the person scrolled up to read
  if (await read($, isFollowing)) await $.ui.scroll({ to: 'end', in: AGENT_PANE }).catch(() => undefined)
}

// Re-reads the output now when the event came from the agent being viewed
async function refreshIfViewed($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId && agentId === (await read($, viewing))) await refreshAgentLog($)
}

// The follow toggle in the window's header
async function toggleFollow($: EngineInterface): Promise<void> {
  const isOn = !(await read($, isFollowing))
  await update($, isFollowing, () => isOn)
  if (isOn) await $.ui.scroll({ to: 'end', in: AGENT_PANE }).catch(() => undefined)
}

// Opens the agent output window at half the terminal's width; the dock is shared, so the
// conversation beside it narrows while it is open (panes cannot float over the transcript)
async function openAgentView($: EngineInterface, agentId: string, title: string): Promise<void> {
  await update($, viewing, () => agentId)
  await update($, agentLog, () => null)
  await update($, isFollowing, () => true)
  const columns = terminalWidth ? Math.max(MIN_COLUMNS, Math.round(terminalWidth * AGENT_SHARE) - 2) : undefined
  await $.ui.open(
    columns
      ? { id: AGENT_PANE, title, focus: true, closeOnEscape: true, columns }
      : { id: AGENT_PANE, title, focus: true, closeOnEscape: true },
  )
  await refreshAgentLog($).catch(() => undefined)
}

// Forgets the viewed agent and gives the sidecar back its share of the width
async function restoreSidecar($: EngineInterface): Promise<void> {
  await update($, viewing, () => null)
  await update($, agentLog, () => null)
  askedColumns = terminalWidth ? wantedColumns(terminalWidth) : 0
  await $.ui.open(askedColumns ? { id: PANE, title: TITLE, columns: askedColumns } : { id: PANE, title: TITLE })
}

// The window's own close button: a plugin's own close raises no ui.close hook of its own
async function closeAgentView($: EngineInterface): Promise<void> {
  await $.ui.close({ id: AGENT_PANE })
  await restoreSidecar($)
}

// Reads the limits and the context breakdown and stores them for the pane
async function refreshUsage($: EngineInterface): Promise<void> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const nextLimits: SidecarLimit[] = usage.rateLimits.map(l => ({
    kind: l.kind,
    percentUsed: l.percentUsed,
    resetsAt: l.resetsAt,
  }))
  await update($, limits, () => nextLimits)
  await resolveCacheTtl($, nextLimits.length > 0).catch(() => undefined)

  const b = usage.context.breakdown
  const max = b?.rawMaxTokens || usage.context.window
  const rows = (b?.categories ?? [])
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: c.name, percent: (c.tokens / max) * 100 }))
  const free = b?.categories.find(c => c.kind === 'free')
  if (free) rows.push({ name: 'Free', percent: (free.tokens / max) * 100 })
  const nextContext: SidecarContext = {
    percent: usage.context.percent ?? b?.percentage ?? null,
    window: usage.context.window,
    rows,
  }
  await update($, context, () => nextContext)
}

// The prompt cache's lifetime: the promptCacheTtl setting when set, else an hour on a plan
// that reports rate limits (a subscription), else the API's five minutes
async function resolveCacheTtl($: EngineInterface, hasPlanLimits: boolean): Promise<void> {
  const setting = (await $.settings.read()).promptCacheTtl
  const ttlMs = setting === '1h' ? HOUR_MS : setting === '5m' ? FIVE_MINUTES_MS : hasPlanLimits ? HOUR_MS : FIVE_MINUTES_MS
  const before = await read($, cache)
  if (before.ttlMs !== ttlMs) await update($, cache, c => ({ ...c, ttlMs }))
}

// Idle time before a keep-warm ping: ten minutes short of the lifetime, or a fifth of a short one
function pingAfterMs(ttlMs: number): number {
  return ttlMs - Math.min(10 * 60 * 1000, ttlMs / 5)
}

async function stopKeepWarm($: EngineInterface, why: string): Promise<void> {
  await update($, cache, c => (c.keepWarm ? { ...c, keepWarm: { ...c.keepWarm, stopped: why } } : c))
}

// The Keep warm button: arms a six-hour window, or turns a running one off
async function toggleKeepWarm($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, cache, c => {
    const isOn = c.keepWarm !== null && c.keepWarm.stopped === null && c.keepWarm.until > now
    const next: SidecarCache = { ...c, keepWarm: isOn ? null : { until: now + KEEP_WARM_MS, lastPing: null, stopped: null } }
    return next
  })
  ensureCacheTicker($)
  $.ui.invalidate('ui.render')
}

// One request over the session's own transcript, so the cache is read and its lifetime renewed
async function pingCache($: EngineInterface): Promise<void> {
  isPinging = true
  try {
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    const now = await $.clock.now()
    if (!reply.isAnswered) {
      const why =
        reply.reason === 'nothing-to-fork' ? 'no conversation yet'
        : reply.reason === 'api-error' ? 'the ping failed'
        : reply.reason === 'aborted' ? 'the ping was interrupted'
        : 'the ping got no reply'
      await stopKeepWarm($, why)
      return
    }
    const read_ = reply.usage.cache_read_input_tokens
    const write = reply.usage.cache_creation_input_tokens
    await update($, cache, c => ({
      ...c,
      lastRequestAt: now,
      keepWarm: c.keepWarm ? { ...c.keepWarm, lastPing: { at: now, read: read_, write } } : null,
    }))
    // A warm ping reads the prefix and writes only its own line; a big write means the cache had lapsed
    if (read_ === 0 || write >= 0.1 * read_) await stopKeepWarm($, 'the cache had already gone cold')
  } catch {
    await stopKeepWarm($, 'the ping failed')
  } finally {
    isPinging = false
  }
}

// Every tick: redraw the countdown, end a finished window, and ping when the cache is near its end
async function cacheTick($: EngineInterface): Promise<void> {
  $.ui.invalidate('ui.render')
  const c = await read($, cache)
  const kw = c.keepWarm
  if (!kw || kw.stopped !== null) return
  const now = await $.clock.now()
  if (now >= kw.until) return stopKeepWarm($, 'the 6h window ended')
  if (isTurnRunning || isPinging || c.lastRequestAt === null) return
  const idle = now - c.lastRequestAt
  // Already cold: a ping would pay the whole rewrite, so wait for the next turn
  if (idle >= c.ttlMs || idle < pingAfterMs(c.ttlMs)) return
  await pingCache($)
}

function ensureCacheTicker($: EngineInterface): void {
  if (cacheTicker) return
  cacheTicker = $.clock.every(CACHE_TICK_MS, () => {
    void cacheTick($).catch(() => undefined)
  })
}

function countPatch(patch: Patch): { added: number; removed: number; preview: string[] } {
  let added = 0
  let removed = 0
  const preview: string[] = []
  for (const hunk of patch) {
    for (const line of hunk.lines) {
      const sign = line.charAt(0)
      if (sign !== '+' && sign !== '-') continue
      if (sign === '+') added += 1
      else removed += 1
      const body = line.slice(1).trim()
      if (preview.length < PREVIEW_LINES && body !== '') preview.push(sign + ' ' + body)
    }
  }
  return { added, removed, preview }
}

// Records one finished edit, newest first, one row per file
async function recordEdit($: EngineInterface, filePath: string, record: EditRecord): Promise<void> {
  let counted = countPatch(record.structuredPatch ?? [])
  if (record.type === 'create' && counted.added === 0 && typeof record.content === 'string') {
    const lines = record.content.split('\n')
    counted = {
      added: lines.length,
      removed: 0,
      preview: lines.filter(l => l.trim() !== '').slice(0, PREVIEW_LINES).map(l => '+ ' + l.trim()),
    }
  }
  const cwd = await $.session.cwd()
  const shown = cwd && filePath.startsWith(cwd + '/') ? filePath.slice(cwd.length + 1) : filePath
  const cut = shown.lastIndexOf('/')
  const now = Date.now()
  await update($, files, list => {
    const before = list.find(f => f.path === filePath)
    const row: SidecarFileChange = {
      path: filePath,
      name: cut >= 0 ? shown.slice(cut + 1) : shown,
      dir: cut >= 0 ? shown.slice(0, cut) : '.',
      added: (before?.added ?? 0) + counted.added,
      removed: (before?.removed ?? 0) + counted.removed,
      edits: (before?.edits ?? 0) + 1,
      at: now,
      preview: counted.preview.length > 0 ? counted.preview : before?.preview ?? [],
    }
    return [row, ...list.filter(f => f.path !== filePath)].slice(0, MAX_FILES)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sidecar',
      description: 'Open the sidecar panel (limits, context, recent file changes); /sidecar close hides it',
      argumentHint: '[close]',
    })
    askedColumns = 0
    void $.ui.open({ id: PANE, title: TITLE })
    void $.session.model().then(name => noteModel($, name)).catch(() => undefined)
    void refreshAgents($).catch(() => undefined)
    poller?.cancel()
    poller = null
    ensurePoller($)
    cacheTicker?.cancel()
    cacheTicker = null
    isTurnRunning = false
    ensureCacheTicker($)
    void refreshUsage($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'sidecar' }, async ($, e) => {
    if ((e.args ?? '').trim() === 'close') {
      isHiddenForWidth = false
      await $.ui.close({ id: PANE })
      return { text: 'Sidecar closed. Run /sidecar to open it again.' }
    }
    const terminalColumns = e.presentation?.columns
    if (e.presentation && !e.presentation.isFullscreen) {
      return { text: 'Sidecar shows only docked on the right, which needs the fullscreen layout (/tui fullscreen).' }
    }
    if (terminalColumns && terminalColumns < DOCK_MIN_COLUMNS) {
      isHiddenForWidth = true
      return { text: `Sidecar is hidden while the terminal is under ${DOCK_MIN_COLUMNS} columns; it appears once it is wider.` }
    }
    askedColumns = terminalColumns ? wantedColumns(terminalColumns) : 0
    const opened = await $.ui.open(
      askedColumns ? { id: PANE, title: TITLE, columns: askedColumns } : { id: PANE, title: TITLE },
    )
    await refreshUsage($).catch(() => undefined)
    return { text: opened.isPlaced ? 'Sidecar opened.' : 'Sidecar is waiting: ' + opened.reason }
  })

  // After each turn, and when a rate-limit window moves a point
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refreshUsage($).catch(() => undefined)
    await $.session.model().then(name => noteModel($, name)).catch(() => undefined)
    await refreshAgents($).catch(() => undefined)
    ensurePoller($)

    return result
  })

  // A new subagent joins the tree as soon as it is spawned
  on('agent.spawn', async ($, e, next) => {
    ensurePoller($)
    const result = await next(e)
    await refreshAgents($).catch(() => undefined)

    return result
  }).catch(($, e, next) => next(e))

  // Each model request of the main loop names the model and effort it is sent with
  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) await noteModel($, e.model, e.effort).catch(() => undefined)
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    // The main loop's request renewed the cache; its usage says what was read and written
    const usage = result.usage
    if (!e.agentId && !isPinging && usage) {
      await update($, cache, c => ({
        ...c,
        lastRequestAt: sentAt,
        last: { read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens, uncached: usage.input_tokens },
      })).catch(() => undefined)
    }
    // A viewed subagent's reply shows as soon as its step ends, and the tree catches its status
    await refreshIfViewed($, e.agentId).catch(() => undefined)
    if (e.agentId) await refreshAgents($).catch(() => undefined)
    return result
  })

  // A subagent's run ending flips its row to done or failed at once
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) isTurnRunning = false
    if (e.agentId) {
      await refreshAgents($).catch(() => undefined)
      await refreshIfViewed($, e.agentId).catch(() => undefined)
    }

    return result
  })

  // A compaction rewrites the prefix, so the cache's state is unknown until the next request
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await update($, cache, c => ({ ...c, lastRequestAt: null, last: null })).catch(() => undefined)

    return result
  }).catch(($, e, next) => next(e))

  // /clear starts a new conversation with nothing cached; a resume knows when its last reply came
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') {
      await update($, cache, c => ({ ...c, lastRequestAt: null, last: null, keepWarm: null })).catch(() => undefined)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const at = (await $.clock.now()) - e.seconds_since_last_response * 1000
      await update($, cache, c => ({ ...c, lastRequestAt: at, last: null })).catch(() => undefined)
    }

    return result
  }).catch(($, e, next) => next(e))

  // A width change redraws every hooked site: bring the hidden sidecar back once it can dock
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await next(e)
    const viewport = e.viewport
    if (isHiddenForWidth && viewport?.isFullscreen === true && viewport.columns >= DOCK_MIN_COLUMNS) {
      isHiddenForWidth = false
      askedColumns = wantedColumns(viewport.columns)
      void $.ui.open({ id: PANE, title: TITLE, columns: askedColumns })
    }

    return result
  })

  // The person's own close keeps it closed, whatever the width does
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') isHiddenForWidth = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      ensurePoller($)
      await noteAgentTool($, e.agentId, String(e.tool)).catch(() => undefined)
    }
    void refreshIfViewed($, e.agentId).catch(() => undefined)
    const result = await next(e)
    void refreshIfViewed($, e.agentId).catch(() => undefined)
    const tool = String(e.tool)
    if (EDIT_TOOLS.has(tool) && !result.deny && !result.isError) {
      const record = (result.result ?? {}) as EditRecord
      const input = e as unknown as { file_path?: string }
      const filePath = record.filePath ?? input.file_path
      if (filePath && !record.staged) await recordEdit($, filePath, record).catch(() => undefined)
    }
    // A shell command that changed files reports them, with their hunks, as bashEditDiff
    if (tool === 'Bash' && !result.deny && !result.isError) {
      const diff = (result.result as { bashEditDiff?: BashEditDiff } | undefined)?.bashEditDiff
      const withHunks = diff?.files ?? []
      const seen = new Set(withHunks.map(f => f.filePath))
      const pathsOnly = (diff?.changedFiles ?? []).filter(p => !seen.has(p))
      for (const f of withHunks) {
        await recordEdit($, f.filePath, { structuredPatch: f.hunks, type: f.created ? 'create' : undefined }).catch(() => undefined)
      }
      for (const path of pathsOnly) await recordEdit($, path, {}).catch(() => undefined)
    }

    return result
  }).catch(($, e, next) => next(e))

  // Scrolling up to read pauses following; scrolling back to the bottom resumes it
  on('ui.scroll', { requestId: AGENT_PANE }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'person') {
      const isAtEnd = e.offset >= e.contentRows - e.bodyRows
      if (isAtEnd !== (await read($, isFollowing))) await update($, isFollowing, () => isAtEnd)
    }

    return result
  }).catch(($, e, next) => next(e))

  // Esc or the engine's close mark: back to the sidecar at its width
  on('ui.close', { id: AGENT_PANE }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'unload') await restoreSidecar($)

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: AGENT_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    if (e.viewport?.columns) terminalWidth = e.viewport.columns
    const now = Date.now()
    const agentId = await read($, viewing)
    const log = await read($, agentLog)
    const following = await read($, isFollowing)
    const agent = (await read($, agents)).find(a => a.id === agentId)
    const icon = agentIcon(agent?.status ?? 'completed')
    const colorOf = (kind: SidecarLogLine['kind']) =>
      kind === 'tool' ? 'suggestion' : kind === 'error' ? 'error' : kind === 'result' ? 'inactive' : 'text'

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={icon.color}>{icon.glyph}</Text> <Text bold>{agent?.type ?? 'agent'}</Text> {agent?.description ?? ''}
            <Text dimColor>
              {agent ? ` · ${ENDED.has(agent.status) ? agent.status : agent.lastTool ?? agent.status} · ${elapsed((agent.endedAt ?? now) - agent.firstSeen)}` : ''}
            </Text>
          </Text>
          <Box flexDirection="row">
            <Button key="follow" plain onPress={() => toggleFollow($)}>
              {following ? <Text color="success">⇣ live</Text> : <Text color="warning">⏸ paused</Text>}
            </Button>
            <Text> </Text>
            <Button key="close" role="dismiss" plain onPress={() => closeAgentView($)}>✕ Esc</Button>
          </Box>
        </Box>
        {log === null && <Text dimColor>Loading…</Text>}
        {log?.denied && <Text color="warning" wrap="wrap">Output not available: {log.denied}</Text>}
        {log && !log.denied && log.lines.length === 0 && <Text dimColor>No output yet.</Text>}
        {log?.lines.map(line =>
          line.kind === 'prompt' ? (
            <Text dimColor wrap="wrap">Task: {line.text.length > 600 ? line.text.slice(0, 599) + '…' : line.text}</Text>
          ) : line.kind === 'text' ? (
            <Text wrap="wrap">{line.text}</Text>
          ) : (
            <Text color={colorOf(line.kind)} wrap="truncate-end">
              {line.kind === 'tool' ? '▸ ' : '  ⎿ '}
              {line.text}
            </Text>
          ),
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns

    // Too narrow to dock: close rather than sit above the prompt, and come back once it widens
    if (e.props.placement === 'inline') {
      isHiddenForWidth = e.viewport?.isFullscreen === true
      void $.ui.close({ id: PANE })
      return <Box flexDirection="column" />
    }

    // Keep the docked pane at its share of the terminal as the terminal resizes
    const terminalColumns = e.viewport?.columns
    if (terminalColumns) terminalWidth = terminalColumns
    if (e.props.placement === 'dock' && terminalColumns) {
      const want = wantedColumns(terminalColumns)
      if (want !== askedColumns && Math.abs(want - width) > 1) {
        askedColumns = want
        void $.ui.open({ id: PANE, title: TITLE, columns: want })
      }
    }

    const now = Date.now()
    const modelInfo = await read($, model)
    const agentList = await read($, agents)
    const limitList = await read($, limits)
    const ctx = await read($, context)
    const fileList = await read($, files)
    const cacheInfo = await read($, cache)
    const clockNow = await $.clock.now()

    // Cards run the pane's full width, inset a column on the left; the pane is their frame, a rule parts them
    const card = (title: string, body: RenderElement, isFirst = false) => (
      <Box flexDirection="column" width={width}>
        {!isFirst && <Text color="promptBorder">{'─'.repeat(Math.max(1, width))}</Text>}
        <Box flexDirection="column" paddingLeft={1}>
          <Text bold color="claude">{title}</Text>
          {body}
        </Box>
      </Box>
    )

    const modelBody =
      modelInfo === null ? (
        <Text dimColor>Reading…</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">{modelInfo.model}</Text>
          <Text wrap="truncate-end">
            Effort <Text bold color="suggestion">{modelInfo.effort ?? '–'}</Text>
            {modelInfo.effort === null && <Text dimColor> (after next reply)</Text>}
          </Text>
        </Box>
      )

    const limitsBody =
      limitList.length === 0 ? (
        <Text dimColor wrap="wrap">No reading yet. Shows after the next reply.</Text>
      ) : (
        <Box flexDirection="column">
          {limitList.map(l => (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                {limitLabel(l.kind)}{' '}
                <Text bold color={l.percentUsed >= 90 ? 'error' : l.percentUsed >= 70 ? 'warning' : 'success'}>
                  {pct(l.percentUsed)}
                </Text>
              </Text>
              {l.resetsAt && <Text dimColor wrap="truncate-end">  {untilReset(l.resetsAt, now)}</Text>}
            </Box>
          ))}
        </Box>
      )

    const contextBody =
      ctx === null ? (
        <Text dimColor>Measuring…</Text>
      ) : (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            Used{' '}
            <Text bold color={(ctx.percent ?? 0) >= 80 ? 'error' : (ctx.percent ?? 0) >= 60 ? 'warning' : 'success'}>
              {ctx.percent === null ? '–' : pct(ctx.percent)}
            </Text>
            <Text dimColor> of {Math.round(ctx.window / 1000)}k</Text>
          </Text>
          {ctx.rows.map(r => (
            <Text dimColor={r.name === 'Free'} wrap="truncate-end">
              {'  '}{r.name} {pct(r.percent)}
            </Text>
          ))}
        </Box>
      )

    const cacheAge = cacheInfo.lastRequestAt === null ? null : clockNow - cacheInfo.lastRequestAt
    const cacheState = cacheAge === null ? 'unknown' : cacheAge >= cacheInfo.ttlMs ? 'cold' : 'warm'
    const warm = cacheInfo.keepWarm
    const isWarming = warm !== null && warm.stopped === null && warm.until > clockNow
    const cacheBody = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold color={cacheState === 'warm' ? 'success' : cacheState === 'cold' ? 'error' : 'inactive'}>
            {cacheState === 'warm' ? '● Warm' : cacheState === 'cold' ? '● Cold' : '○ Unknown'}
          </Text>
          {cacheAge !== null && cacheState === 'warm' && <Text> · {span(cacheInfo.ttlMs - cacheAge)} left</Text>}
          {cacheAge !== null && cacheState === 'cold' && <Text> · {span(cacheAge - cacheInfo.ttlMs)} ago</Text>}
        </Text>
        <Text dimColor wrap="truncate-end">
          {'  '}{cacheInfo.ttlMs >= HOUR_MS ? '1h' : '5m'} cache · {cacheAge === null ? 'no request yet' : `last request ${span(cacheAge)} ago`}
        </Text>
        {cacheInfo.last && (
          <Box flexDirection="column">
            <Text wrap="truncate-end">Read <Text bold color="success">{tokens(cacheInfo.last.read)}</Text></Text>
            <Text wrap="truncate-end">Write <Text bold color={cacheInfo.last.write >= 0.5 * Math.max(1, cacheInfo.last.read) ? 'warning' : 'text'}>{tokens(cacheInfo.last.write)}</Text></Text>
            <Text wrap="truncate-end">Uncached <Text bold>{tokens(cacheInfo.last.uncached)}</Text></Text>
          </Box>
        )}
        <Button key="keepwarm" plain onPress={() => toggleKeepWarm($)}>
          {isWarming ? <Text color="warning">■ Stop keep-warm</Text> : <Text color="suggestion">▶ Keep warm 6h</Text>}
        </Button>
        {isWarming && warm && (
          <Text dimColor wrap="truncate-end">
            {'  '}{span(warm.until - clockNow)} left
            {cacheState === 'warm' && cacheAge !== null && !isTurnRunning ? ` · ping in ${span(Math.max(0, pingAfterMs(cacheInfo.ttlMs) - cacheAge))}` : ''}
          </Text>
        )}
        {isWarming && warm?.lastPing && (
          <Text dimColor wrap="truncate-end">{'  '}last ping read {tokens(warm.lastPing.read)}</Text>
        )}
        {warm && warm.stopped !== null && (
          <Text color="warning" wrap="truncate-end">{'  '}Stopped: {warm.stopped}</Text>
        )}
      </Box>
    )

    const agentRows = agentTree(agentList)
    const agentsBody =
      agentRows.length === 0 ? (
        <Text dimColor>No subagents yet.</Text>
      ) : (
        <Box flexDirection="column">
          {agentRows.map(({ agent: a, depth }) => {
            const icon = agentIcon(a.status)
            const indent = depth === 0 ? '' : '  '.repeat(depth - 1) + '└ '
            const isEnded = ENDED.has(a.status)
            const detail = [isEnded ? a.status : a.lastTool, elapsed((a.endedAt ?? now) - a.firstSeen)].filter(Boolean).join(' · ')
            return (
              <Box flexDirection="column">
                <Button key={'agent-' + a.id} plain onPress={() => openAgentView($, a.id, 'Agent: ' + a.description)}>
                  {indent}
                  <Text color={icon.color}>{icon.glyph}</Text> <Text bold>{a.type}</Text>{' '}
                  <Text dimColor={isEnded}>{a.description}</Text>
                </Button>
                <Text dimColor wrap="truncate-end">
                  {'  '.repeat(depth + 1)}{detail}
                </Text>
              </Box>
            )
          })}
        </Box>
      )

    const filesBody =
      fileList.length === 0 ? (
        <Text dimColor>No edits yet this session.</Text>
      ) : (
        <Box flexDirection="column">
          {fileList.map(f => (
            <Box flexDirection="column" marginBottom={0}>
              <Text wrap="truncate-end">
                <Text bold>{f.name}</Text> <Text color="success">+{f.added}</Text>{' '}
                <Text color="error">-{f.removed}</Text>
                <Text dimColor> · {ago(f.at, now)}</Text>
              </Text>
              <Text dimColor wrap="truncate-start">  {f.dir}</Text>
              {f.preview.map(p => (
                <Text color={p.startsWith('+') ? 'success' : 'error'} wrap="truncate-end">
                  {'  '}{p}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )

    return (
      <Box flexDirection="column">
        {card('Model', modelBody, true)}
        {card('Limits', limitsBody)}
        {card('Context', contextBody)}
        {card('Cache', cacheBody)}
        {agentRows.length > 0 && card('Agents', agentsBody)}
        {card('Recent changes', filesBody)}
      </Box>
    )
  })
}
