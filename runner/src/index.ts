import { spawnSync } from 'node:child_process'
import { statfsSync } from 'node:fs'
import type { Source } from '../../src/shared/types'
import {
  DashboardClient,
  type CandidatePayload,
  type EventPayload,
  type Observed,
} from './api'
import { loadConfig, runnerRoot } from './config'
import { KickClient } from './kick'
import { MockChat } from './mock'
import { ChatMeter, scoreSignal } from './score'
import { TwitchClient, type LiveInfo } from './twitch'

const config = loadConfig()
const api = new DashboardClient(config.dashboardUrl, config.token)
const twitch = new TwitchClient(
  config.twitch.clientId,
  config.twitch.clientSecret,
)
const kick = new KickClient(config.kick.clientId, config.kick.clientSecret)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

type State = {
  source: Source
  meter: ChatMeter
  stopChat?: () => void
  lastCandidateAt: number
  chatConnected: boolean
}

const mockSource: Source = {
  id: 'mock-stream',
  platform: 'twitch',
  channel: 'mock-stream',
  label: 'Mock stream',
  active: true,
  live: true,
  viewers: 1234,
  liveCheckedAt: null,
  createdAt: Date.now(),
}

async function runStart(mode: 'start' | 'mock') {
  if (!config.token) {
    console.error(
      'Missing CLIPPER_RUNNER_TOKEN.\n' +
        'Create a runner in the dashboard (Runners tab), then: cp runner/.env.example runner/.env and paste the token.',
    )
    process.exit(1)
  }

  const states = new Map<string, State>()
  let known: Source[] = []
  let observed: Observed[] = []
  let candidates: CandidatePayload[] = []
  let events: EventPayload[] = []
  let stopping = false
  let warnedCreds = false
  const warnedKick = new Set<string>()

  const note = (
    level: EventPayload['level'],
    stage: string,
    message: string,
  ) => {
    events.push({ level, stage, message })
    const stamp = new Date().toLocaleTimeString()
    console.log(`${stamp} ${stage.padEnd(8)} ${message}`)
  }

  const shutdown = () => {
    if (stopping) return
    stopping = true
    for (const state of states.values()) state.stopChat?.()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const mock = mode === 'mock' ? new MockChat() : null
  note(
    'info',
    'scout',
    mode === 'mock'
      ? 'Mock mode: synthetic chat, no platform credentials needed.'
      : `Connected to ${config.dashboardUrl}`,
  )
  const intervalMs = (mode === 'mock' ? 5 : config.tickSeconds) * 1000

  // Mock mode is fully local: one synthetic channel, no Twitch connection.
  if (mode === 'mock' && mock) {
    known = [mockSource]
    const meter = new ChatMeter(config.historyBuckets)
    states.set(mockSource.id, {
      source: mockSource,
      meter,
      lastCandidateAt: 0,
      chatConnected: true,
    })
    mock.start((text) => meter.add(text))
  }

  while (!stopping) {
    const startedAt = Date.now()
    try {
      // 1. Reconcile the watchlist reported by the last heartbeat.
      const dashboardIds = new Set(known.map((source) => source.id))
      for (const [id, state] of states) {
        if (!dashboardIds.has(id) || !state.source.active) {
          state.stopChat?.()
          states.delete(id)
        }
      }
      for (const source of known) {
        if (!source.active || source.platform === 'kick') continue
        if (!states.has(source.id))
          states.set(source.id, {
            source,
            meter: new ChatMeter(config.historyBuckets),
            lastCandidateAt: 0,
            chatConnected: false,
          })
        else states.get(source.id)!.source = source
      }

      // 2. Live status. Mock mode is always live; Kick is status-only for now.
      const live = new Map<string, LiveInfo>()
      if (mode === 'mock') {
        live.set(mockSource.channel, { live: true, viewers: 1234 })
      } else {
        const twitchLogins = known
          .filter((source) => source.platform === 'twitch' && source.active)
          .map((source) => source.channel)
          .slice(0, config.maxChannels)
        if (twitchLogins.length && !twitch.configured && !warnedCreds) {
          warnedCreds = true
          note(
            'warn',
            'scout',
            'TWITCH_CLIENT_ID/SECRET missing: live status and chat are off. Add them to runner/.env.',
          )
        }
        if (twitch.configured && twitchLogins.length) {
          try {
            for (const [login, info] of await twitch.liveStatus(twitchLogins))
              live.set(login, info)
          } catch (error) {
            note('warn', 'scout', errorText(error))
          }
        }
        const kickSlugs = known
          .filter((source) => source.platform === 'kick' && source.active)
          .map((source) => source.channel)
          .slice(0, config.maxChannels)
        if (kickSlugs.length && kick.configured) {
          try {
            for (const [slug, info] of await kick.liveStatus(kickSlugs))
              live.set(slug, info)
          } catch (error) {
            const message = errorText(error)
            if (!warnedKick.has(message)) {
              warnedKick.add(message)
              note('warn', 'scout', message)
            }
          }
        } else if (kickSlugs.length && !kick.configured) {
          for (const slug of kickSlugs)
            if (!warnedKick.has(slug)) {
              warnedKick.add(slug)
              note(
                'warn',
                'scout',
                `Kick status for ${slug} needs KICK_CLIENT_ID/SECRET.`,
              )
            }
        }
      }

      // 3. Chat connections follow live status.
      for (const state of states.values()) {
        if (mode === 'mock') continue
        const info = live.get(state.source.channel)
        const isLive = info?.live ?? false
        if (!isLive) {
          state.stopChat?.()
          state.stopChat = undefined
          state.chatConnected = false
          continue
        }
        if (state.stopChat) continue
        state.stopChat = twitch.watchChat(
          state.source.channel,
          (text) => state.meter.add(text),
          (chatState) => {
            if (chatState === 'open' && !state.chatConnected) {
              state.chatConnected = true
              note(
                'info',
                'scout',
                `Reading chat in ${state.source.channel}.`,
              )
            }
          },
        )
        note(
          'info',
          'scout',
          `${state.source.channel} is live${info?.viewers ? ` (${info.viewers.toLocaleString()} viewers)` : ''}.`,
        )
      }

      // 4. Score every watched channel once per tick.
      const now = Date.now()
      for (const state of states.values()) {
        const windowSeconds = Math.max(10, Math.round(intervalMs / 1000))
        const signal = state.meter.tick(now, windowSeconds)
        const score = scoreSignal(signal)
        if (
          score < config.scoreThreshold ||
          now - state.lastCandidateAt < config.cooldownSeconds * 1000
        )
          continue
        state.lastCandidateAt = now
        candidates.push({
          sourceId: state.source.id,
          platform: state.source.platform,
          channel: state.source.channel,
          score,
          signals: signal,
          sample: state.meter.sample(now, windowSeconds),
          windowStart: now - windowSeconds * 1000,
          windowEnd: now,
        })
        note(
          'info',
          'spotter',
          `Candidate in ${state.source.channel}: score ${score}, ${signal.messages} messages, ${signal.keywords.join(', ') || 'no key words'}.`,
        )
      }

      // 5. Report live state and pick up watchlist changes in one round trip.
      observed = []
      if (mode === 'mock') {
        await api.heartbeat([])
      } else {
        for (const source of known) {
          const info = live.get(source.channel)
          observed.push({
            sourceId: source.id,
            live: info?.live ?? false,
            viewers: info?.viewers ?? null,
          })
        }
        known = (await api.heartbeat(observed)).sources
      }

      // 6. Flush. Candidates first so their event lands in the same batch.
      if (candidates.length) {
        const result = await api.candidates(candidates)
        candidates = []
        if (!result.accepted.length)
          note('info', 'runner', 'Dashboard already had those moments.')
      }
      if (events.length) {
        await api.events(events)
        events = []
      }
    } catch (error) {
      note('error', 'runner', errorText(error))
      try {
        if (events.length) await api.events(events)
      } catch {
        /* the next tick retries the connection */
      }
      events = []
    }

    if (stopping) break
    const elapsed = Date.now() - startedAt
    await sleep(Math.max(1000, intervalMs - elapsed))
  }

  mock?.stop()
  for (const state of states.values()) state.stopChat?.()
  console.log('Runner stopped.')
}

async function runDoctor() {
  const lines: string[] = []
  const ok = (label: string, detail = '') =>
    lines.push(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`)
  const warn = (label: string, detail = '') =>
    lines.push(`  \u2022 ${label}${detail ? ` — ${detail}` : ''}`)
  const bad = (label: string, detail = '') =>
    lines.push(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`)

  console.log(`Clipper runner doctor\n  root: ${runnerRoot}`)
  console.log(`  bun:  ${typeof Bun !== 'undefined' ? Bun.version : 'unknown'}`)

  if (!config.token)
    bad(
      'Runner token missing',
      'Create a runner in the dashboard, then cp runner/.env.example runner/.env',
    )
  else ok('Runner token present')

  try {
    const result = await api.heartbeat([])
    ok(
      'Dashboard reachable',
      `${result.sources.length} channel(s) on the watchlist`,
    )
  } catch (error) {
    bad('Dashboard unreachable', errorText(error))
  }

  if (!twitch.configured)
    warn(
      'Twitch credentials missing',
      'Live status and chat need TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET',
    )
  else
    try {
      const probe = await twitch.liveStatus(['twitch'])
      ok('Twitch credentials work', `${probe.size} channel probed`)
    } catch (error) {
      bad('Twitch credentials rejected', errorText(error))
    }

  if (!kick.configured)
    warn(
      'Kick credentials missing',
      'Stream status needs KICK_CLIENT_ID / KICK_CLIENT_SECRET (chat arrives with the webhook receiver)',
    )
  else ok('Kick credentials present')

  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (ffmpeg.status === 0)
    ok('ffmpeg available', (ffmpeg.stdout || '').split('\n')[0]?.trim())
  else
    warn(
      'ffmpeg not found',
      'Only needed from phase B (capture and rendering): brew install ffmpeg',
    )

  try {
    const stats = statfsSync(runnerRoot)
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3
    if (freeGb < 5) warn('Low disk space', `${freeGb.toFixed(1)} GB free`)
    else ok('Disk space', `${freeGb.toFixed(1)} GB free`)
  } catch {
    warn('Disk space unknown', 'statfs is unavailable here')
  }

  console.log(lines.join('\n'))
  const blocking = lines.some((line) => line.includes('\u2717'))
  console.log(
    blocking
      ? '\nFix the items marked \u2717 before starting.'
      : '\nReady. Start with: bun run start  (or bun run mock to test without credentials)',
  )
  process.exit(blocking ? 1 : 0)
}

const command = process.argv[2] ?? 'start'
if (command === 'doctor') await runDoctor()
else if (command === 'start' || command === 'mock') await runStart(command)
else {
  console.log(
    [
      'Clipper runner',
      '',
      '  bun run doctor   check config, credentials, ffmpeg and disk',
      '  bun run start    watch the dashboard watchlist',
      '  bun run mock     synthetic chat, no credentials needed',
      '',
      'Config: runner/runner.json + runner/.env',
    ].join('\n'),
  )
  process.exit(command === 'help' || command === '--help' ? 0 : 1)
}
