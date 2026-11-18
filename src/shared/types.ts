export type Platform = 'twitch' | 'kick'

export type Source = {
  id: string
  platform: Platform
  channel: string
  label: string | null
  active: boolean
  /** Set when the owner added the channel; null means it is not allowed to clip. */
  approvedAt: number | null
  /** Last category/game the platform reported, when it reports one. */
  category: string | null
  live: boolean
  viewers: number | null
  liveCheckedAt: number | null
  createdAt: number
}

/** Owner-level guardrails. Applied before a clip is cut and again on arrival. */
export type Policy = {
  /** Kill switch: nothing is captured or queued while true. */
  paused: boolean
  /** Empty means "any category". Otherwise the category must match exactly. */
  allowedCategories: string[]
  /** Case-insensitive terms; a chat sample or transcript hit blocks the moment. */
  blockedTerms: string[]
  updatedAt: number
}

export type CandidateStatus = 'new' | 'approved' | 'rejected' | 'blocked'

export type Signals = {
  chatZ: number
  messages: number
  keywords: string[]
  emoteBurst: number
  windowSeconds: number
}

/** Metadata for a clip cut on the runner; the media itself stays there. */
export type ClipInfo = {
  fileName: string
  bytes: number
  durationMs: number
}

export type Candidate = {
  id: string
  sourceId: string
  platform: Platform
  channel: string
  score: number
  signals: Signals
  sample: string[]
  windowStart: number
  windowEnd: number
  status: CandidateStatus
  /** Why the policy blocked it, when status is `blocked`. */
  blockReason: string | null
  clip: ClipInfo | null
  createdAt: number
}

export type RunnerInfo = {
  id: string
  name: string
  lastSeenAt: number | null
  online: boolean
  createdAt: number
}

export type LogEvent = {
  id: string
  level: 'info' | 'warn' | 'error'
  stage: string
  message: string
  createdAt: number
}

export type Overview = {
  sources: Source[]
  candidates: Candidate[]
  events: LogEvent[]
  runners: RunnerInfo[]
  policy: Policy
}

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}
