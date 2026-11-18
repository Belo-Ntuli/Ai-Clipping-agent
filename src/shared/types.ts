export type Platform = 'twitch' | 'kick'

export type Source = {
  id: string
  platform: Platform
  channel: string
  label: string | null
  active: boolean
  live: boolean
  viewers: number | null
  liveCheckedAt: number | null
  createdAt: number
}

export type CandidateStatus = 'new' | 'approved' | 'rejected'

export type Signals = {
  chatZ: number
  messages: number
  keywords: string[]
  emoteBurst: number
  windowSeconds: number
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
}

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
}
