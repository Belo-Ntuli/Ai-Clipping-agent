import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, statfsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { screenMoment } from '../../src/shared/policy'
import type { Policy, Source } from '../../src/shared/types'
import {
  DashboardClient,
  type CandidatePayload,
  type EventPayload,
  type Observed,
} from './api'
import { RingBuffer, probeDurationMs } from './buffer'
import { loadConfig, runnerRoot } from './config'
import { KickClient } from './kick'
import { MockChat } from './mock'
import { ChatMeter, scoreSignal } from './score'
import { availableResolvers, resolveStreamUrl } from './stream'
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
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_')
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`

type State = {
  source: Source
  meter: ChatMeter
  /** Last category seen for this channel; drives the category allowlist. */
  category?: string | null
  stopChat?: () => void
  lastCandidateAt: number
  chatConnected: boolean
  buffer?: RingBuffer
  captureStarting?: boolean
  captureWarned?: boolean
}

const mockSource: Source = {
  id: 'mock-stream',
  platform: 'twitch',
  channel: 'mock-stream',
  label: 'Mock stream',
  active: true,
  approvedAt: Date.now(),
  category: 'Just Chatting',
  live: true,
  viewers: 1234,
  liveCheckedAt: null,
  createdAt: Date.now(),
}

/**
 * Until the dashboard answers, nothing is known to be refused: an empty
 * category allowlist means "any", and the owner's real list, blocklist and
 * kill switch arrive with the first heartbeat.
 */
const neutralPolicy: Policy = {
  paused: false,
  allowedCategories: [],
  blockedTerms: [],
  updatedAt: 0,
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
  let policy: Policy = neutralPolicy
  let pausedNoted = false
  const warnedApproval = new Set<string>()
  let known: Source[] = []
  let observed: Observed[] = []
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

  const flushEvents = async () => {
    const batch = events.splice(0, events.length)
    if (!batch.length) return
    await api.events(batch)
  }

  const shutdown = () => {
    if (stopping) return
    stopping = true
    for (const state of states.values()) {
      state.stopChat?.()
      state.buffer?.stop()
    }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  /**
   * Starts buffering a live channel. Stream URLs come from streamlink/yt-dlp;
   * without either, detection still runs but no video is captured.
   */
  const ensureCapture = async (state: State) => {
    if (!config.clip.enabled || state.buffer || state.captureStarting) return
    state.captureStarting = true
    try {
      if (!availableResolvers().length) {
        if (!state.captureWarned) {
          state.captureWarned = true
          note(
            'warn',
            'capture',
            'Install streamlink or yt-dlp to buffer video. Detection still runs on chat.',
          )
        }
        return
      }
      const url = await resolveStreamUrl(state.source.platform, state.source.channel)
      if (!url) return
      const buffer = new RingBuffer({
        dir: join(config.bufferRoot, safeName(state.source.id)),
        inputArgs: ['-i', url],
        copy: true,
        segmentSeconds: config.clip.segmentSeconds,
        segments: config.clip.segments,
      })
      buffer.start()
      state.buffer = buffer
      note(
        'info',
        'capture',
        `Buffering ${state.source.channel} (${Math.round(buffer.tailMs / 1000)}s tail).`,
      )
    } catch (error) {
      if (!state.captureWarned) {
        state.captureWarned = true
        note('warn', 'capture', `${state.source.channel}: ${errorText(error)}`)
      }
    } finally {
      state.captureStarting = false
    }
  }

  /**
   * Cuts the moment out of the ring buffer and posts it. Runs off the tick so
   * a slow cut cannot delay the next scan.
   */
  const deliver = async (state: State, payload: CandidatePayload) => {
    const buffer = state.buffer
    if (buffer?.running && config.clip.enabled) {
      await sleep(config.clip.postRollSeconds * 1000)
      const outPath = join(
        config.clipsRoot,
        `${state.source.platform}-${safeName(state.source.channel)}-${payload.windowEnd}.mp4`,
      )
      try {
        const cut = buffer.cut(
          payload.windowEnd - config.clip.preRollSeconds * 1000,
          config.clip.durationSeconds * 1000,
          outPath,
        )
        payload.clip = {
          fileName: basename(cut.path),
          bytes: cut.bytes,
          durationMs: cut.durationMs,
        }
        note(
          'info',
          'cutter',
          `Cut ${(cut.durationMs / 1000).toFixed(1)}s from ${cut.segments} segment(s) in ${state.source.channel} (${mb(cut.bytes)}${cut.missedMs > 500 ? `, ${Math.round(cut.missedMs / 1000)}s not yet buffered` : ''}).`,
        )
      } catch (error) {
        note(
          'warn',
          'cutter',
          `No clip for ${state.source.channel}: ${errorText(error)}`,
        )
      }
    }
    try {
      const result = await api.candidates([payload])
      if (!result.accepted.length)
        note('info', 'runner', 'Dashboard already had that moment.')
    } catch (error) {
      note('error', 'runner', errorText(error))
    }
  }

  const mock = mode === 'mock' ? new MockChat() : null
  note(
    'info',
    'scout',
    mode === 'mock'
      ? 'Mock mode: synthetic chat and a synthetic video stream, no credentials needed.'
      : `Connected to ${config.dashboardUrl}`,
  )
  const intervalMs = (mode === 'mock' ? 5 : config.tickSeconds) * 1000

  // Mock mode is fully local: one synthetic channel, no Twitch connection, and
  // a lavfi video source so the ring buffer and cut path run for real.
  if (mode === 'mock' && mock) {
    known = [mockSource]
    const meter = new ChatMeter(config.historyBuckets)
    const state: State = {
      source: mockSource,
      meter,
      category: mockSource.category,
      lastCandidateAt: 0,
      chatConnected: true,
    }
    if (config.clip.enabled) {
      rmSync(join(config.bufferRoot, 'mock'), { recursive: true, force: true })
      const buffer = new RingBuffer({
        dir: join(config.bufferRoot, 'mock'),
        inputArgs: [
          '-re',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=640x360:rate=30',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
        ],
        copy: false,
        // A synthetic source has no HLS keyframes, so force one every 2s or
        // the segmenter cannot honour segmentSeconds.
        outputArgs: ['-force_key_frames', 'expr:gte(t,n_forced*2)'],
        segmentSeconds: 2,
        segments: 20,
      })
      buffer.start()
      state.buffer = buffer
    }
    states.set(mockSource.id, state)
    mock.start((text) => meter.add(text))
  }

  while (!stopping) {
    const startedAt = Date.now()
    try {
      // 1. Reconcile the watchlist reported by the last heartbeat.
      if (policy.paused !== pausedNoted) {
        pausedNoted = policy.paused
        note(
          policy.paused ? 'warn' : 'info',
          'policy',
          policy.paused
            ? 'Clipping is paused in the dashboard: nothing is watched or cut.'
            : 'Clipping resumed.',
        )
      }
      const current = new Map(known.map((source) => [source.id, source]))
      for (const [id, state] of states) {
        const fresh = current.get(id)
        // Removed, paused, or no longer approved: tear the watch down.
        if (!fresh || !fresh.active || fresh.approvedAt === null) {
          state.stopChat?.()
          state.buffer?.stop()
          states.delete(id)
        }
      }
      for (const source of known) {
        if (!source.active || source.platform === 'kick') continue
        if (source.approvedAt === null) {
          if (!warnedApproval.has(source.id)) {
            warnedApproval.add(source.id)
            note(
              'warn',
              'policy',
              `${source.channel} is not approved by you, so it is not being watched.`,
            )
          }
          continue
        }
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
        live.set(mockSource.channel, {
          live: true,
          viewers: 1234,
          category: mockSource.category,
        })
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

      // 3. Chat and capture follow live status.
      for (const state of states.values()) {
        // Paused is a hard stop for capture, not just for publishing.
        if (policy.paused) {
          state.stopChat?.()
          state.stopChat = undefined
          state.buffer?.stop()
          state.buffer = undefined
          continue
        }
        const info = live.get(state.source.channel)
        state.category = info?.category ?? state.source.category ?? null
        const isLive = info?.live ?? false
        if (!isLive) {
          if (state.stopChat) {
            state.stopChat()
            state.stopChat = undefined
            state.chatConnected = false
          }
          if (state.buffer) {
            state.buffer.stop()
            state.buffer = undefined
          }
          continue
        }
        if (mode !== 'mock' && !state.stopChat) {
          state.stopChat = twitch.watchChat(
            state.source.channel,
            (text) => state.meter.add(text),
            (chatState) => {
              if (chatState === 'open' && !state.chatConnected) {
                state.chatConnected = true
                note('info', 'scout', `Reading chat in ${state.source.channel}.`)
              }
            },
          )
          note(
            'info',
            'scout',
            `${state.source.channel} is live${info?.viewers ? ` (${info.viewers.toLocaleString()} viewers)` : ''}.`,
          )
        }
        void ensureCapture(state)
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
        if (mode !== 'mock' && now - state.lastCandidateAt < 0) continue
        state.lastCandidateAt = now
        const sample = state.meter.sample(now, windowSeconds)
        const payload: CandidatePayload = {
          sourceId: state.source.id,
          platform: state.source.platform,
          channel: state.source.channel,
          score,
          signals: signal,
          sample,
          windowStart: now - windowSeconds * 1000,
          windowEnd: now,
        }
        const verdict = screenMoment(
          {
            platform: state.source.platform,
            channel: state.source.channel,
            category: state.category ?? null,
            sample,
          },
          policy,
        )
        if (!verdict.allowed) {
          // Refused before any encoding work: no clip is cut. The dashboard is
          // told anyway so the owner can see the refusal and its reason.
          note(
            'info',
            'policy',
            `Refused a moment in ${state.source.channel}: ${verdict.reason}.`,
          )
          void api
            .candidates([payload])
            .catch((error) => note('error', 'runner', errorText(error)))
          continue
        }
        note(
          'info',
          'spotter',
          `Candidate in ${state.source.channel}: score ${score}, ${signal.messages} messages, ${signal.keywords.join(', ') || 'no key words'}.`,
        )
        void deliver(state, payload)
      }

      // 5. Report live state and pick up watchlist changes in one round trip.
      observed = []
      if (mode === 'mock') {
        const beat = await api.heartbeat([])
        if (beat.policy) policy = beat.policy
      } else {
        for (const source of known) {
          const info = live.get(source.channel)
          observed.push({
            sourceId: source.id,
            live: info?.live ?? false,
            viewers: info?.viewers ?? null,
            category: info?.category ?? source.category ?? null,
          })
        }
        const beat = await api.heartbeat(observed)
        known = beat.sources
        if (beat.policy) policy = beat.policy
      }

      await flushEvents()
    } catch (error) {
      note('error', 'runner', errorText(error))
      try {
        await flushEvents()
      } catch {
        /* the next tick retries the connection */
      }
    }

    if (stopping) break
    const elapsed = Date.now() - startedAt
    await sleep(Math.max(1000, intervalMs - elapsed))
  }

  mock?.stop()
  for (const state of states.values()) {
    state.stopChat?.()
    state.buffer?.stop()
  }
  console.log('Runner stopped.')
}

/**
 * Proves the ring buffer and the cut with a synthetic stream: no credentials,
 * no network, real ffmpeg. This is the fast check when something looks wrong.
 */
async function runDemo() {
  if (!Bun.which('ffmpeg')) {
    console.error('ffmpeg not found. Install it first: brew install ffmpeg')
    process.exit(1)
  }
  const dir = join(config.bufferRoot, 'demo')
  rmSync(dir, { recursive: true, force: true })
  const seconds = config.clip.segmentSeconds
  const buffer = new RingBuffer({
    dir,
    inputArgs: [
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
    ],
    copy: false,
    outputArgs: ['-force_key_frames', 'expr:gte(t,n_forced*2)'],
    segmentSeconds: 2,
    segments: Math.max(10, Math.ceil(20 / 2)),
  })
  console.log(
    `Buffering a synthetic stream for ${seconds + 6}s (segments of 2s)...`,
  )
  buffer.start()
  await sleep((seconds + 6) * 1000)
  const segments = buffer.segmentsNow()
  console.log(`closed segments on disk: ${segments.length}`)
  if (!segments.length) {
    buffer.stop()
    console.error('No segments were written; ffmpeg did not start.')
    process.exit(1)
  }
  const last = segments[segments.length - 1]!
  const start = Date.now() - 8000
  const outPath = join(config.clipsRoot, `demo-${Date.now()}.mp4`)
  const cut = buffer.cut(start, 6000, outPath)
  buffer.stop()
  console.log(
    [
      '',
      'Cut result',
      `  file:      ${cut.path}`,
      `  size:      ${mb(cut.bytes)}`,
      `  duration:  ${(cut.durationMs / 1000).toFixed(2)}s`,
      `  segments:  ${cut.segments}`,
      `  missed:    ${Math.round(cut.missedMs)}ms (before the buffer started)`,
    ].join('\n'),
  )
}

/**
 * Replays a local video file through the real pipeline: buffered into segments
 * exactly like a live stream, a moment cut out of the buffer, and the candidate
 * posted to the dashboard. This is how you watch the agent work on footage you
 * already have, with no platform and no credentials involved.
 */
async function runReplay(input: string) {
  if (!Bun.which('ffmpeg') || !Bun.which('ffprobe')) {
    console.error('ffmpeg/ffprobe not found. Install them first: brew install ffmpeg')
    process.exit(1)
  }
  if (!input) {
    console.error('Usage: bun run runner replay <video-file>')
    process.exit(1)
  }
  const file = resolve(input)
  if (!existsSync(file)) {
    console.error(`No such file: ${file}`)
    process.exit(1)
  }
  const totalMs = probeDurationMs(file) ?? 0
  if (totalMs < 8000) {
    console.error(
      `Need at least 8s of video; ${basename(file)} is ${(totalMs / 1000).toFixed(1)}s.`,
    )
    process.exit(1)
  }

  const dir = join(config.bufferRoot, 'replay')
  rmSync(dir, { recursive: true, force: true })
  const segmentSeconds = 2
  const playMs = Math.min(totalMs, 120_000)
  const buffer = new RingBuffer({
    dir,
    // -re paces the file like a live stream, so the buffer sees one chunk per
    // moment of wall-clock time exactly as it would on a real channel.
    inputArgs: ['-re', '-i', file],
    copy: false,
    outputArgs: ['-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`],
    segmentSeconds,
    segments: Math.ceil(playMs / (segmentSeconds * 1000)) + 4,
  })
  console.log(
    `Replaying ${basename(file)} (${(totalMs / 1000).toFixed(1)}s) into ${segmentSeconds}s segments...`,
  )
  buffer.start()
  await sleep(playMs + 2500)
  const segments = buffer.segmentsNow()
  console.log(`closed segments on disk: ${segments.length}`)
  if (!segments.length) {
    buffer.stop()
    console.error('No segments were written; ffmpeg did not read that file.')
    process.exit(1)
  }

  const outPath = join(config.clipsRoot, `replay-${Date.now()}.mp4`)
  const cut = buffer.cut(Date.now() - 8000, 8000, outPath)
  buffer.stop()
  console.log(
    [
      '',
      'Cut result',
      `  file:      ${cut.path}`,
      `  size:      ${mb(cut.bytes)}`,
      `  duration:  ${(cut.durationMs / 1000).toFixed(2)}s`,
      `  segments:  ${cut.segments}`,
    ].join('\n'),
  )

  if (!config.token) {
    console.log('\nNo runner token, so the clip stayed local. Add one to runner/.env to post it.')
    return
  }
  try {
    const beat = await api.heartbeat([])
    const source = beat.sources.find((item) => item.approvedAt !== null)
    if (!source) {
      console.log('\nNo approved channel on the watchlist, so the clip stayed local.')
      return
    }
    const now = Date.now()
    const result = await api.candidates([
      {
        sourceId: source.id,
        platform: source.platform,
        channel: source.channel,
        score: 72,
        signals: {
          chatZ: 2.6,
          messages: 34,
          keywords: ['no way', 'clip it'],
          emoteBurst: 6,
          windowSeconds: 30,
        },
        sample: ['NO WAY', 'clip that', 'KEKW'],
        windowStart: now - 30_000,
        windowEnd: now,
        clip: {
          fileName: basename(cut.path),
          bytes: cut.bytes,
          durationMs: cut.durationMs,
        },
      },
    ])
    const posted = result.accepted[0] as
      | { status?: string; blockReason?: string | null }
      | undefined
    const outcome =
      posted?.status === 'blocked'
        ? `refused by your content rules (${posted.blockReason ?? 'no reason given'}), so no clip is queued`
        : posted
          ? 'accepted, open the Review tab'
          : 'not accepted (this window was already recorded)'
    console.log(`\nPosted to ${config.dashboardUrl} as ${source.channel}: ${outcome}`)
  } catch (error) {
    console.log(`\nDashboard not reached: ${errorText(error)}`)
  }
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

  if (Bun.which('ffmpeg') && Bun.which('ffprobe'))
    ok('ffmpeg available', spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout?.split('\n')[0]?.trim())
  else
    bad('ffmpeg missing', 'Needed to buffer and cut clips: brew install ffmpeg')

  const resolvers = availableResolvers()
  if (resolvers.length) ok('Stream resolver available', resolvers.join(', '))
  else
    warn(
      'No stream resolver',
      'Install streamlink or yt-dlp, otherwise chat detection runs without video',
    )

  try {
    const stats = statfsSync(runnerRoot)
    const freeGb = (stats.bavail * stats.bsize) / 1024 ** 3
    const tailMinutes = (config.clip.segments * config.clip.segmentSeconds) / 60
    if (freeGb < 5) warn('Low disk space', `${freeGb.toFixed(1)} GB free`)
    else
      ok(
        'Disk space',
        `${freeGb.toFixed(1)} GB free, buffer tail ${tailMinutes.toFixed(1)} min per live channel`,
      )
  } catch {
    warn('Disk space unknown', 'statfs is unavailable here')
  }

  console.log(lines.join('\n'))
  const blocking = lines.some((line) => line.includes('\u2717'))
  console.log(
    blocking
      ? '\nFix the items marked \u2717 before starting.'
      : '\nReady. Try: bun run demo  (synthetic clip) or bun run start',
  )
  process.exit(blocking ? 1 : 0)
}

const command = process.argv[2] ?? 'start'
if (command === 'doctor') await runDoctor()
else if (command === 'demo') await runDemo()
else if (command === 'replay') await runReplay(process.argv[3] ?? '')
else if (command === 'start' || command === 'mock') await runStart(command)
else {
  console.log(
    [
      'Clipper runner',
      '',
      '  bun run doctor   check config, credentials, ffmpeg, resolvers and disk',
      '  bun run demo     cut a clip from a synthetic stream (no credentials)',
      '  bun run replay F buffer a local video, cut and post a real clip',
      '  bun run start    watch the dashboard watchlist',
      '  bun run mock     synthetic chat and video, no credentials needed',
      '',
      'Config: runner/runner.json + runner/.env',
    ].join('\n'),
  )
  process.exit(command === 'help' || command === '--help' ? 0 : 1)
}
