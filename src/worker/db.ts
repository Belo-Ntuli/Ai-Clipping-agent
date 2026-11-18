import type {
  Candidate,
  CandidateStatus,
  ClipInfo,
  LogEvent,
  Platform,
  Policy,
  RunnerInfo,
  Signals,
  Source,
} from '../shared/types'

/** Sensible starting blocklist. The owner can edit it; it is not exhaustive. */
export const DEFAULT_BLOCKED_TERMS = [
  'cocaine',
  'heroin',
  'meth',
  'fentanyl',
  'overdose',
  'shooting up',
  'syrup',
  'xanax',
  'drug deal',
  'suicide',
  'self harm',
  'porn',
  'nudes',
  'onlyfans',
]

/**
 * Phase A schema: sources, runners, candidates, an agent event log and the
 * owner's content policy. Later phases append tables and migrations here.
 */
const schema = [
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    platform TEXT NOT NULL,
    channel TEXT NOT NULL,
    label TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    approved_at INTEGER,
    category TEXT,
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
    block_reason TEXT,
    clip_file TEXT,
    clip_bytes INTEGER,
    clip_duration_ms INTEGER,
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
  `CREATE TABLE IF NOT EXISTS policies (
    owner_sub TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    allowed_categories TEXT NOT NULL DEFAULT '[]',
    blocked_terms TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`,
]

/**
 * Additive changes for databases created by an earlier version. Each runs on
 * its own; a "duplicate column" error is the expected no-op.
 */
const migrations = [
  `ALTER TABLE candidates ADD COLUMN clip_file TEXT`,
  `ALTER TABLE candidates ADD COLUMN clip_bytes INTEGER`,
  `ALTER TABLE candidates ADD COLUMN clip_duration_ms INTEGER`,
  `ALTER TABLE candidates ADD COLUMN block_reason TEXT`,
  `ALTER TABLE sources ADD COLUMN approved_at INTEGER`,
  `ALTER TABLE sources ADD COLUMN category TEXT`,
  // Channels added by the owner before approval existed are approved.
  `UPDATE sources SET approved_at = created_at WHERE approved_at IS NULL`,
]

const ready = new WeakMap<D1Database, Promise<void>>()
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(async () => {
        for (const sql of migrations) {
          try {
            await db.prepare(sql).run()
          } catch {
            /* column already exists */
          }
        }
      })
      .then(() => undefined)
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

const parseList = (value: string, max: number): string[] => {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === 'string')
          .slice(0, max)
      : []
  } catch {
    return []
  }
}

export type PolicyRow = {
  paused: number
  allowed_categories: string
  blocked_terms: string
  updated_at: number
}

export const mapPolicy = (row: PolicyRow): Policy => ({
  paused: row.paused === 1,
  allowedCategories: parseList(row.allowed_categories, 30),
  blockedTerms: parseList(row.blocked_terms, 200),
  updatedAt: row.updated_at,
})

/** One policy row per owner, created on first use with the default blocklist. */
export async function ensurePolicy(db: D1Database, owner: string): Promise<Policy> {
  const existing = await db
    .prepare(
      'SELECT paused, allowed_categories, blocked_terms, updated_at FROM policies WHERE owner_sub = ?',
    )
    .bind(owner)
    .first<PolicyRow>()
  if (existing) return mapPolicy(existing)
  const now = Date.now()
  await db
    .prepare(
      `INSERT OR IGNORE INTO policies (owner_sub, paused, allowed_categories, blocked_terms, updated_at)
       VALUES (?, 0, '[]', ?, ?)`,
    )
    .bind(owner, JSON.stringify(DEFAULT_BLOCKED_TERMS), now)
    .run()
  const row = await db
    .prepare(
      'SELECT paused, allowed_categories, blocked_terms, updated_at FROM policies WHERE owner_sub = ?',
    )
    .bind(owner)
    .first<PolicyRow>()
  return row
    ? mapPolicy(row)
    : {
        paused: false,
        allowedCategories: [],
        blockedTerms: DEFAULT_BLOCKED_TERMS,
        updatedAt: now,
      }
}

export type SourceRow = {
  id: string
  platform: string
  channel: string
  label: string | null
  active: number
  approved_at: number | null
  category: string | null
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
  approvedAt: row.approved_at,
  category: row.category,
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
  block_reason: string | null
  clip_file: string | null
  clip_bytes: number | null
  clip_duration_ms: number | null
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

function parseClip(row: CandidateRow): ClipInfo | null {
  if (!row.clip_file) return null
  return {
    fileName: row.clip_file,
    bytes: row.clip_bytes ?? 0,
    durationMs: row.clip_duration_ms ?? 0,
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
  blockReason: row.block_reason,
  clip: parseClip(row),
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
