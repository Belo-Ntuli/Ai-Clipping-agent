import { spawn } from 'node:child_process'

/**
 * Twitch and Kick do not expose a plain HLS URL through their public APIs, so
 * the runner asks a resolver that already knows how: streamlink, then yt-dlp.
 * Both are optional tools; without one the runner still watches chat and
 * detects moments, it just cannot buffer or cut video.
 */
const RESOLVERS: Array<{ command: string; args: (pageUrl: string) => string[] }> =
  [
    { command: 'streamlink', args: (url) => ['--stream-url', url, 'best'] },
    {
      command: 'yt-dlp',
      args: (url) => ['-g', '-f', 'bv*+ba/b', '--no-warnings', url],
    },
  ]

export function pageUrl(platform: 'twitch' | 'kick', channel: string): string {
  return platform === 'twitch'
    ? `https://www.twitch.tv/${channel}`
    : `https://kick.com/${channel}`
}

export function availableResolvers(): string[] {
  return RESOLVERS.filter((resolver) => Boolean(Bun.which(resolver.command))).map(
    (resolver) => resolver.command,
  )
}

async function run(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already exited */
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** First playable URL for a live channel, or null when no resolver exists. */
export async function resolveStreamUrl(
  platform: 'twitch' | 'kick',
  channel: string,
  timeoutMs = 25_000,
): Promise<string | null> {
  const target = pageUrl(platform, channel)
  const errors: string[] = []
  for (const resolver of RESOLVERS) {
    if (!Bun.which(resolver.command)) continue
    const result = await run(resolver.command, resolver.args(target), timeoutMs)
    if (result.code === 0) {
      const url = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('http'))
      if (url) return url
    }
    errors.push(
      `${resolver.command}: ${(result.stderr || 'no url').trim().slice(0, 160)}`,
    )
  }
  if (errors.length)
    throw new Error(`could not resolve a stream URL (${errors.join('; ')})`)
  return null
}
