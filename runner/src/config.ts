import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ClipConfig = {
  enabled: boolean
  segmentSeconds: number
  segments: number
  preRollSeconds: number
  durationSeconds: number
  postRollSeconds: number
}

export type RunnerConfig = {
  dashboardUrl: string
  tickSeconds: number
  scoreThreshold: number
  cooldownSeconds: number
  historyBuckets: number
  maxChannels: number
  token: string
  clip: ClipConfig
  bufferRoot: string
  clipsRoot: string
  twitch: { clientId: string; clientSecret: string }
  kick: { clientId: string; clientSecret: string }
}

/** The runner directory, so `launchd` and any cwd behave the same. */
export const runnerRoot = dirname(import.meta.dir)

/**
 * Bun loads `.env` from the process cwd, which is not reliable once launchd
 * starts us. Read it from the runner directory explicitly and never override
 * variables that are already set in the environment.
 */
function loadDotEnv(root: string) {
  const path = join(root, '.env')
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const split = line.indexOf('=')
    if (split < 1) continue
    const key = line.slice(0, split).trim()
    const value = line.slice(split + 1).trim().replace(/^["']|["']$/g, '')
    if (key && process.env[key] === undefined) process.env[key] = value
  }
}

type FileShape = {
  dashboardUrl?: unknown
  tickSeconds?: unknown
  scoreThreshold?: unknown
  cooldownSeconds?: unknown
  historyBuckets?: unknown
  maxChannels?: unknown
  bufferDir?: unknown
  clipsDir?: unknown
  clip?: {
    enabled?: unknown
    segmentSeconds?: unknown
    segments?: unknown
    preRollSeconds?: unknown
    durationSeconds?: unknown
    postRollSeconds?: unknown
  }
  twitch?: { clientId?: unknown; clientSecret?: unknown }
  kick?: { clientId?: unknown; clientSecret?: unknown }
}

const positive = (value: unknown, fallback: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
    ? value
    : fallback

export function loadConfig(): RunnerConfig {
  loadDotEnv(runnerRoot)
  const path = join(runnerRoot, 'runner.json')
  const file: FileShape = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as FileShape)
    : {}
  const dashboardUrl =
    process.env.CLIPPER_DASHBOARD_URL ||
    (typeof file.dashboardUrl === 'string' && file.dashboardUrl) ||
    'http://localhost:5173'
  const token = process.env.CLIPPER_RUNNER_TOKEN?.trim() || ''
  const preRollSeconds = positive(file.clip?.preRollSeconds, 40, 600)
  const postRollSeconds = positive(file.clip?.postRollSeconds, 4, 120)
  return {
    dashboardUrl: dashboardUrl.replace(/\/$/, ''),
    tickSeconds: positive(file.tickSeconds, 30, 600),
    scoreThreshold: positive(file.scoreThreshold, 55, 100),
    cooldownSeconds: positive(file.cooldownSeconds, 90, 3600),
    historyBuckets: positive(file.historyBuckets, 8, 40),
    maxChannels: positive(file.maxChannels, 5, 50),
    token,
    clip: {
      enabled: file.clip?.enabled !== false,
      segmentSeconds: positive(file.clip?.segmentSeconds, 6, 60),
      segments: positive(file.clip?.segments, 30, 600),
      preRollSeconds,
      postRollSeconds,
      durationSeconds: positive(
        file.clip?.durationSeconds,
        preRollSeconds + postRollSeconds,
        900,
      ),
    },
    bufferRoot:
      typeof file.bufferDir === 'string' && file.bufferDir
        ? file.bufferDir
        : join(runnerRoot, 'buffer'),
    clipsRoot:
      typeof file.clipsDir === 'string' && file.clipsDir
        ? file.clipsDir
        : join(runnerRoot, 'clips'),
    twitch: {
      clientId:
        process.env.TWITCH_CLIENT_ID?.trim() ||
        (typeof file.twitch?.clientId === 'string' ? file.twitch.clientId : ''),
      clientSecret:
        process.env.TWITCH_CLIENT_SECRET?.trim() ||
        (typeof file.twitch?.clientSecret === 'string'
          ? file.twitch.clientSecret
          : ''),
    },
    kick: {
      clientId:
        process.env.KICK_CLIENT_ID?.trim() ||
        (typeof file.kick?.clientId === 'string' ? file.kick.clientId : ''),
      clientSecret:
        process.env.KICK_CLIENT_SECRET?.trim() ||
        (typeof file.kick?.clientSecret === 'string'
          ? file.kick.clientSecret
          : ''),
    },
  }
}
