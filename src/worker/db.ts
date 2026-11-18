import type {
  Candidate,
  CandidateStatus,
  LogEvent,
  Platform,
  RunnerInfo,
  Signals,
  Source,
} from '../shared/types'

/**
 * Phase A schema: sources, runners, candidates and an agent event log.
 * Job leases and clips arrive in phase B; this file is the single place
 * migrations are appended, so later phases add tables here, not elsewhere.
 */
const schema = [
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    platform TEXT NOT NULL,
    channel TEXT NOT NULL,
    label TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    live INTEGER NOT NULL DEFAULT 0,
    viewers INTEGER,
    live_checked_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(owner_sub, platform, channel)
  )`,
  `CREATE INDEX IF NOT EXISTS sources_owner ON sources(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS runners_owner ON runners(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    source_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    channel TEXT NOT NULL,
    score INTEGER NOT NULL,
    signals TEXT NOT NULL,
    sample TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at INTEGER NOT NULL,
    UNIQUE(owner_sub, source_id, window_start)
  )`,
  `CREATE INDEX IF NOT EXISTS candidates_owner_created ON candidates(owner_sub, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    level TEXT NOT NULL,
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_owner_created ON events(owner_sub, created_at DESC)`,
]

const ready = new WeakMap<D1Database, Promise<void>>()
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

export type SourceRow = {
  id: string
  platform: string
  channel: string
  label: string | null
  active: number
  live: number
  viewers: number | null
  live_checked_at: number | null
  created_at: number
}
export const mapSource = (row: SourceRow): Source => ({
  id: row.id,
  platform: row.platform as Platform,
  channel: row.channel,
  label: row.label,
  active: row.active === 1,
  live: row.live === 1,
  viewers: row.viewers,
  liveCheckedAt: row.live_checked_at,
  createdAt: row.created_at,
})

export type RunnerRow = {
  id: string
  owner_sub: string
  name: string
  token_hash: string
  last_seen_at: number | null
  created_at: number
}
export const mapRunner = (row: RunnerRow, now: number): RunnerInfo => ({
  id: row.id,
  name: row.name,
  lastSeenAt: row.last_seen_at,
  online: Boolean(row.last_seen_at && now - row.last_seen_at < 90_000),
  createdAt: row.created_at,
})

export type CandidateRow = {
  id: string
  source_id: string
  platform: string
  channel: string
  score: number
  signals: string
  sample: string
  window_start: number
  window_end: number
  status: string
  created_at: number
}

const emptySignals: Signals = {
  chatZ: 0,
  messages: 0,
  keywords: [],
  emoteBurst: 0,
  windowSeconds: 30,
}

function parseSignals(value: string): Signals {
  try {
    const parsed = JSON.parse(value) as Partial<Signals>
    return {
      chatZ: Number(parsed.chatZ) || 0,
      messages: Number(parsed.messages) || 0,
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((item): item is string => typeof item === 'string')
        : [],
      emoteBurst: Number(parsed.emoteBurst) || 0,
      windowSeconds: Number(parsed.windowSeconds) || 30,
    }
  } catch {
    return emptySignals
  }
}

function parseSample(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export const mapCandidate = (row: CandidateRow): Candidate => ({
  id: row.id,
  sourceId: row.source_id,
  platform: row.platform as Platform,
  channel: row.channel,
  score: row.score,
  signals: parseSignals(row.signals),
  sample: parseSample(row.sample),
  windowStart: row.window_start,
  windowEnd: row.window_end,
  status: row.status as CandidateStatus,
  createdAt: row.created_at,
})

export type EventRow = {
  id: string
  level: string
  stage: string
  message: string
  created_at: number
}
export const mapEvent = (row: EventRow): LogEvent => ({
  id: row.id,
  level: (['info', 'warn', 'error'].includes(row.level)
    ? row.level
    : 'info') as LogEvent['level'],
  stage: row.stage,
  message: row.message,
  createdAt: row.created_at,
})
