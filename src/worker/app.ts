import { isSameOriginRequest } from '@freebuff/auth'
import type { FreebuffUser } from '@freebuff/auth'
import { Hono, type Handler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { appOrigin, currentUser, isLocalPreview, type Env } from './auth'
import {
  ensurePolicy,
  ensureSchema,
  mapCandidate,
  mapEvent,
  mapRunner,
  mapSource,
  type CandidateRow,
  type EventRow,
  type RunnerRow,
  type SourceRow,
} from './db'
import { cleanList, screenMoment } from '../shared/policy'
import type { Candidate, Platform, Policy } from '../shared/types'

type AppContext = {
  Bindings: Env
  Variables: {
    user: FreebuffUser
    db: D1Database
    runner: RunnerRow
  }
}
type Authenticate = (request: Request, env: Env) => Promise<FreebuffUser | null>

const PLATFORMS = new Set(['twitch', 'kick'])
const CHANNEL = /^[a-zA-Z0-9_]{2,50}$/
const LEVELS = new Set(['info', 'warn', 'error'])

/** Runner tokens are handed out once; only their hash is stored. */
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function newRunnerToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return `clpr_${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`
}

/** Strict, non-coercing readers: the runner is a separate process we validate. */
function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= max
    ? value.trim()
    : null
}
function num(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null
}

export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()

  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 96 * 1024,
      onError: (c) => c.json({ error: 'Request is too large.' }, 413),
    }),
  )

  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: isLocalPreview(c.req.raw, c.env)
        ? 'local'
        : c.env.FREEBUFF_CLIENT_ID && c.env.APP_ORIGIN
          ? 'freebuff'
          : 'setup',
      database: Boolean(c.env.DB),
    }),
  )

  // Browser-facing dashboard routes: signed in, owner-scoped, same-origin writes.
  const dashboard: Handler<AppContext> = async (c, next) => {
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOriginRequest(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  }
  for (const path of [
    '/api/overview',
    '/api/sources',
    '/api/sources/*',
    '/api/candidates/*',
    '/api/policy',
    '/api/runners',
    '/api/runners/*',
  ])
    app.use(path, dashboard)

  app.get('/api/overview', async (c) => {
    const db = c.get('db')
    const owner = c.get('user').sub
    const now = Date.now()
    const policy = await ensurePolicy(db, owner)
    const [sources, candidates, events, runners] = await Promise.all([
      db
        .prepare(
          'SELECT id, platform, channel, label, active, approved_at, category, live, viewers, live_checked_at, created_at FROM sources WHERE owner_sub = ? ORDER BY created_at ASC',
        )
        .bind(owner)
        .all<SourceRow>(),
      db
        .prepare(
          'SELECT id, source_id, platform, channel, score, signals, sample, window_start, window_end, status, block_reason, clip_file, clip_bytes, clip_duration_ms, created_at FROM candidates WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 60',
        )
        .bind(owner)
        .all<CandidateRow>(),
      db
        .prepare(
          'SELECT id, level, stage, message, created_at FROM events WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 40',
        )
        .bind(owner)
        .all<EventRow>(),
      db
        .prepare(
          'SELECT id, owner_sub, name, token_hash, last_seen_at, created_at FROM runners WHERE owner_sub = ? ORDER BY created_at ASC',
        )
        .bind(owner)
        .all<RunnerRow>(),
    ])
    return c.json({
      sources: sources.results.map(mapSource),
      candidates: candidates.results.map(mapCandidate),
      events: events.results.map(mapEvent),
      runners: runners.results.map((row) => mapRunner(row, now)),
      policy,
    })
  })

  // Owner guardrails: a kill switch, a category allowlist and a blocklist.
  // Adding a channel is the approval act; this is what governs what gets cut.
  app.patch('/api/policy', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const record = body as Record<string, unknown>
    const paused =
      typeof record.paused === 'boolean' ? Number(record.paused) : undefined
    const categories =
      record.allowedCategories === undefined
        ? undefined
        : cleanList(record.allowedCategories, 30, 60)
    const terms =
      record.blockedTerms === undefined
        ? undefined
        : cleanList(record.blockedTerms, 200, 40)
    if (paused === undefined && !categories && !terms)
      return c.json(
        { error: 'Send paused, allowedCategories or blockedTerms.' },
        400,
      )
    const db = c.get('db')
    const owner = c.get('user').sub
    await ensurePolicy(db, owner)
    await db
      .prepare(
        `UPDATE policies SET
           paused = COALESCE(?, paused),
           allowed_categories = COALESCE(?, allowed_categories),
           blocked_terms = COALESCE(?, blocked_terms),
           updated_at = ?
         WHERE owner_sub = ?`,
      )
      .bind(
        paused ?? null,
        categories ? JSON.stringify(categories) : null,
        terms ? JSON.stringify(terms) : null,
        Date.now(),
        owner,
      )
      .run()
    const policy: Policy = await ensurePolicy(db, owner)
    return c.json({ policy })
  })

  app.post('/api/sources', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Send a platform and channel.' }, 400)
    const record = body as Record<string, unknown>
    const platform = str(record.platform, 10)
    const channel = str(record.channel, 50)
    const label = record.label === undefined ? null : str(record.label, 60)
    if (!platform || !PLATFORMS.has(platform))
      return c.json({ error: 'Platform must be twitch or kick.' }, 400)
    if (!channel || !CHANNEL.test(channel))
      return c.json(
        { error: 'Channel must be 2-50 letters, numbers or underscores.' },
        400,
      )
    if (record.label !== undefined && !label)
      return c.json({ error: 'Label must be 1-60 characters.' }, 400)
    const id = crypto.randomUUID()
    const now = Date.now()
    const inserted = await c
      .get('db')
      .prepare(
        'INSERT OR IGNORE INTO sources (id, owner_sub, platform, channel, label, active, approved_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id, platform, channel, label, active, approved_at, category, live, viewers, live_checked_at, created_at',
      )
      // Adding the channel is the owner's approval: nothing else can create one.
      .bind(id, c.get('user').sub, platform, channel.toLowerCase(), label, now, now)
      .first<SourceRow>()
    return inserted
      ? c.json({ source: mapSource(inserted) }, 201)
      : c.json({ error: 'That channel is already on your watchlist.' }, 409)
  })

  app.patch('/api/sources/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'Nothing to update.' }, 400)
    const record = body as Record<string, unknown>
    const active =
      typeof record.active === 'boolean' ? Number(record.active) : undefined
    const label = record.label === undefined ? undefined : str(record.label, 60)
    if (active === undefined && label === undefined)
      return c.json({ error: 'Send active or label.' }, 400)
    const row = await c
      .get('db')
      .prepare(
        `UPDATE sources SET
           active = COALESCE(?, active),
           label = COALESCE(?, label)
         WHERE id = ? AND owner_sub = ?
         RETURNING id, platform, channel, label, active, approved_at, category, live, viewers, live_checked_at, created_at`,
      )
      .bind(active ?? null, label ?? null, c.req.param('id'), c.get('user').sub)
      .first<SourceRow>()
    return row
      ? c.json({ source: mapSource(row) })
      : c.json({ error: 'Channel not found.' }, 404)
  })

  app.delete('/api/sources/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare('DELETE FROM sources WHERE id = ? AND owner_sub = ? RETURNING id')
      .bind(c.req.param('id'), c.get('user').sub)
      .first()
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'Channel not found.' }, 404)
  })

  app.post('/api/candidates/:id/decision', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const decision =
      body && typeof body === 'object' && !Array.isArray(body)
        ? str((body as Record<string, unknown>).decision, 10)
        : null
    if (decision !== 'approved' && decision !== 'rejected')
      return c.json({ error: 'Decision must be approved or rejected.' }, 400)
    const row = await c
      .get('db')
      .prepare(
        'UPDATE candidates SET status = ? WHERE id = ? AND owner_sub = ? RETURNING id, source_id, platform, channel, score, signals, sample, window_start, window_end, status, block_reason, clip_file, clip_bytes, clip_duration_ms, created_at',
      )
      .bind(decision, c.req.param('id'), c.get('user').sub)
      .first<CandidateRow>()
    return row
      ? c.json({ candidate: mapCandidate(row) })
      : c.json({ error: 'Moment not found.' }, 404)
  })

  app.get('/api/runners', async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        'SELECT id, owner_sub, name, token_hash, last_seen_at, created_at FROM runners WHERE owner_sub = ? ORDER BY created_at ASC',
      )
      .bind(c.get('user').sub)
      .all<RunnerRow>()
    const now = Date.now()
    return c.json({ runners: rows.results.map((row) => mapRunner(row, now)) })
  })

  // The token is returned exactly once and never readable again.
  app.post('/api/runners', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const name =
      body && typeof body === 'object' && !Array.isArray(body)
        ? str((body as Record<string, unknown>).name, 40)
        : null
    if (!name) return c.json({ error: 'Name your runner (1-40 characters).' }, 400)
    const token = newRunnerToken()
    const row: RunnerRow = {
      id: crypto.randomUUID(),
      owner_sub: c.get('user').sub,
      name,
      token_hash: await sha256(token),
      last_seen_at: null,
      created_at: Date.now(),
    }
    await c
      .get('db')
      .prepare(
        'INSERT INTO runners (id, owner_sub, name, token_hash, last_seen_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      )
      .bind(row.id, row.owner_sub, row.name, row.token_hash, row.created_at)
      .run()
    return c.json({ runner: mapRunner(row, Date.now()), token }, 201)
  })

  app.delete('/api/runners/:id', async (c) => {
    const removed = await c
      .get('db')
      .prepare('DELETE FROM runners WHERE id = ? AND owner_sub = ? RETURNING id')
      .bind(c.req.param('id'), c.get('user').sub)
      .first()
    return removed
      ? c.json({ ok: true })
      : c.json({ error: 'Runner not found.' }, 404)
  })

  // Runner-facing routes authenticate with the runner token, not a browser session.
  app.use('/api/runner/*', async (c, next) => {
    if (!c.env.DB)
      return c.json({ error: 'Database is not configured.' }, 503)
    const header = c.req.header('authorization') || ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!token.startsWith('clpr_'))
      return c.json({ error: 'Runner token required.' }, 401)
    await ensureSchema(c.env.DB)
    const row = await c.env.DB.prepare(
      'SELECT id, owner_sub, name, token_hash, last_seen_at, created_at FROM runners WHERE token_hash = ?',
    )
      .bind(await sha256(token))
      .first<RunnerRow>()
    if (!row) return c.json({ error: 'Unknown runner token.' }, 401)
    await c.env.DB.prepare('UPDATE runners SET last_seen_at = ? WHERE id = ?')
      .bind(Date.now(), row.id)
      .run()
    c.set('runner', row)
    await next()
  })

  /**
   * One call per tick: proves the runner is alive, records which channels are
   * live, and returns the watchlist so the dashboard stays the source of truth.
   */
  app.post('/api/runner/heartbeat', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const record =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {}
    const observed = Array.isArray(record.observed) ? record.observed.slice(0, 50) : []
    const db = c.get('db') ?? c.env.DB!
    const owner = c.get('runner').owner_sub
    const now = Date.now()
    for (const item of observed) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const entry = item as Record<string, unknown>
      const id = str(entry.sourceId, 64)
      const live = typeof entry.live === 'boolean' ? Number(entry.live) : null
      if (!id || live === null) continue
      // The category is what the owner's category allowlist is checked against,
      // so it is stored whenever the platform reports one.
      const category = str(entry.category, 60)
      await db
        .prepare(
          `UPDATE sources SET live = ?, viewers = ?, live_checked_at = ?,
             category = COALESCE(?, category)
           WHERE id = ? AND owner_sub = ?`,
        )
        .bind(live, num(entry.viewers, 0, 50_000_000), now, category, id, owner)
        .run()
    }
    const rows = await db
      .prepare(
        'SELECT id, platform, channel, label, active, approved_at, category, live, viewers, live_checked_at, created_at FROM sources WHERE owner_sub = ? AND active = 1 ORDER BY created_at ASC',
      )
      .bind(owner)
      .all<SourceRow>()
    // The policy rides along so the runner can refuse a moment before spending
    // time buffering or cutting it.
    return c.json({
      sources: rows.results.map(mapSource),
      policy: await ensurePolicy(db, owner),
    })
  })

  app.post('/api/runner/candidates', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const list =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).candidates
        : null
    if (!Array.isArray(list) || list.length > 20)
      return c.json({ error: 'Send 1-20 candidates.' }, 400)
    const db = c.get('db') ?? c.env.DB!
    const owner = c.get('runner').owner_sub
    const policy = await ensurePolicy(db, owner)
    const accepted: Candidate[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      const sourceId = str(record.sourceId, 64)
      const platform = str(record.platform, 10)
      const channel = str(record.channel, 50)
      const score = num(record.score, 0, 100)
      const windowStart = num(record.windowStart, 0, 4_102_444_800_000)
      const windowEnd = num(record.windowEnd, 0, 4_102_444_800_000)
      if (!sourceId || !platform || !PLATFORMS.has(platform) || !channel)
        continue
      if (score === null || windowStart === null || windowEnd === null) continue
      if (windowEnd < windowStart) continue
      const signals =
        record.signals && typeof record.signals === 'object'
          ? (record.signals as Record<string, unknown>)
          : {}
      const keywords = Array.isArray(signals.keywords)
        ? signals.keywords
            .filter((word): word is string => typeof word === 'string')
            .slice(0, 10)
            .map((word) => word.slice(0, 40))
        : []
      const sample = Array.isArray(record.sample)
        ? record.sample
            .filter((line): line is string => typeof line === 'string')
            .slice(0, 6)
            .map((line) => line.slice(0, 200))
        : []
      // A cut clip rides along with its candidate. Only its metadata is sent:
      // the media file stays on the runner that captured it.
      let clipFile: string | null = null
      let clipBytes: number | null = null
      let clipDurationMs: number | null = null
      if (
        record.clip &&
        typeof record.clip === 'object' &&
        !Array.isArray(record.clip)
      ) {
        const clip = record.clip as Record<string, unknown>
        const fileName = str(clip.fileName, 160)
        const bytes = num(clip.bytes, 0, 5_000_000_000)
        const durationMs = num(clip.durationMs, 0, 600_000)
        if (fileName && bytes !== null && durationMs !== null) {
          clipFile = fileName.replace(/[/\\]/g, '_')
          clipBytes = Math.round(bytes)
          clipDurationMs = Math.round(durationMs)
        }
      }
      // The dashboard is the authority on policy, not the runner: every moment
      // is re-checked on arrival, so a stale or modified runner cannot queue
      // something the owner refused. A refusal is stored with its reason.
      const source = await db
        .prepare(
          'SELECT id, platform, channel, label, active, approved_at, category, live, viewers, live_checked_at, created_at FROM sources WHERE id = ? AND owner_sub = ?',
        )
        .bind(sourceId, owner)
        .first<SourceRow>()
      // Reporting on a channel the owner removed is not an error, just noise.
      if (!source) continue
      let status: 'new' | 'blocked' = 'new'
      let blockReason: string | null = null
      if (source.approved_at === null) {
        status = 'blocked'
        blockReason = 'channel not approved'
      } else {
        const verdict = screenMoment(
          {
            platform: source.platform as Platform,
            channel: source.channel,
            category: source.category,
            sample,
          },
          policy,
        )
        if (!verdict.allowed) {
          status = 'blocked'
          blockReason = verdict.reason
        }
      }
      if (status === 'blocked') {
        clipFile = null
        clipBytes = null
        clipDurationMs = null
      }
      const row = await db
        .prepare(
          `INSERT OR IGNORE INTO candidates
             (id, owner_sub, source_id, platform, channel, score, signals, sample, window_start, window_end, status, block_reason, clip_file, clip_bytes, clip_duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id, source_id, platform, channel, score, signals, sample, window_start, window_end, status, block_reason, clip_file, clip_bytes, clip_duration_ms, created_at`,
        )
        .bind(
          crypto.randomUUID(),
          owner,
          sourceId,
          platform,
          channel,
          Math.round(score),
          JSON.stringify({
            chatZ: num(signals.chatZ, -100, 100) ?? 0,
            messages: num(signals.messages, 0, 100_000) ?? 0,
            keywords,
            emoteBurst: num(signals.emoteBurst, 0, 1000) ?? 0,
            windowSeconds: num(signals.windowSeconds, 1, 600) ?? 30,
          }),
          JSON.stringify(sample),
          Math.round(windowStart),
          Math.round(windowEnd),
          status,
          blockReason,
          clipFile,
          clipBytes,
          clipDurationMs,
          Date.now(),
        )
        .first<CandidateRow>()
      if (row) accepted.push(mapCandidate(row))
    }
    return c.json({ accepted }, 201)
  })

  app.post('/api/runner/events', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const list =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).events
        : null
    if (!Array.isArray(list) || list.length > 20)
      return c.json({ error: 'Send 1-20 events.' }, 400)
    const db = c.get('db') ?? c.env.DB!
    const owner = c.get('runner').owner_sub
    const now = Date.now()
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      const stage = str(record.stage, 24)
      const message = str(record.message, 300)
      const level = str(record.level, 8) ?? 'info'
      if (!stage || !message) continue
      await db
        .prepare(
          'INSERT INTO events (id, owner_sub, level, stage, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(
          crypto.randomUUID(),
          owner,
          LEVELS.has(level) ? level : 'info',
          stage,
          message,
          now,
        )
        .run()
    }
    // Keep the feed readable: trim anything past the newest 500 per owner.
    await db
      .prepare(
        `DELETE FROM events WHERE owner_sub = ? AND id NOT IN (
           SELECT id FROM events WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 500
         )`,
      )
      .bind(owner, owner)
      .run()
    return c.json({ ok: true }, 201)
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
