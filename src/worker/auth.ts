import { createFreebuffAuth } from '@freebuff/auth'
import type { FreebuffAuth, FreebuffUser } from '@freebuff/auth'

export type Env = {
  ASSETS: Fetcher
  DB?: D1Database
  FREEBUFF_CLIENT_ID?: string
  FREEBUFF_ISSUER?: string
  APP_ORIGIN?: string
  /** Development only: extra hostnames allowed to use the preview identity. */
  LOCAL_PREVIEW_HOSTS?: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The preview identity exists so a first run works without provisioning. It is
 * limited to loopback, plus any hostname the operator names explicitly through
 * LOCAL_PREVIEW_HOSTS — a development affordance for inspecting the dashboard
 * through a tunnel. It is still refused the moment real auth is configured, and
 * a deployment never sets that variable.
 */
export function isLocalPreview(request: Request, env: Env): boolean {
  if (env.FREEBUFF_CLIENT_ID || env.APP_ORIGIN) return false
  const host = new URL(request.url).hostname
  if (LOOPBACK.has(host)) return true
  const extra = (env.LOCAL_PREVIEW_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return extra.includes(host)
}

let cached: { key: string; auth: FreebuffAuth } | undefined

export function getAuth(env: Env): FreebuffAuth | null {
  if (!env.FREEBUFF_CLIENT_ID || !env.APP_ORIGIN) return null
  // The canonical origin comes from Sites, never from a request Host header.
  const origin = new URL(env.APP_ORIGIN)
  const key = JSON.stringify([
    env.FREEBUFF_CLIENT_ID,
    env.FREEBUFF_ISSUER,
    env.APP_ORIGIN,
  ])
  if (cached?.key !== key) {
    cached = {
      key,
      auth: createFreebuffAuth({
        clientId: env.FREEBUFF_CLIENT_ID,
        issuer: env.FREEBUFF_ISSUER || undefined,
        baseUrl: env.APP_ORIGIN,
        allowInsecureLocalhost:
          origin.protocol === 'http:' && LOOPBACK.has(origin.hostname),
      }),
    }
  }
  return cached.auth
}

export async function currentUser(
  request: Request,
  env: Env,
): Promise<FreebuffUser | null> {
  const auth = getAuth(env)
  if (auth) return auth.getUser(request)
  // A single preview identity keeps first run usable without provisioning.
  // This fallback never applies on a hosted origin or to incomplete auth config.
  return isLocalPreview(request, env)
    ? { sub: 'local-preview', name: 'Local preview' }
    : null
}

export function appOrigin(request: Request, env: Env): string | null {
  return (
    env.APP_ORIGIN ||
    (isLocalPreview(request, env) ? new URL(request.url).origin : null)
  )
}
