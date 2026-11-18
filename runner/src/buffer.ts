import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

export type Segment = { path: string; startMs: number; endMs: number }

export type CutResult = {
  path: string
  bytes: number
  durationMs: number
  segments: number
  /** How much of the requested window was not yet buffered. */
  missedMs: number
}

export type RingBufferOptions = {
  dir: string
  /** ffmpeg input arguments, e.g. ['-i', url] or a lavfi test source. */
  inputArgs: string[]
  /** Extra output arguments, placed just before the segment muxer. */
  outputArgs?: string[]
  /** `-c copy` for HLS/TS inputs; re-encode for raw sources such as lavfi. */
  copy?: boolean
  segmentSeconds?: number
  /** How many segments to keep on disk: the ring. */
  segments?: number
  ffmpeg?: string
}

/**
 * `-segment_list_type csv` writes `filename,start,end` per closed segment.
 * Times are seconds relative to the input; absolute times are derived by the
 * caller when it supplies a start instant.
 */
export function parseSegmentIndex(csv: string): Array<{
  path: string
  start: number
  end: number
}> {
  const out: Array<{ path: string; start: number; end: number }> = []
  for (const row of csv.split('\n')) {
    const line = row.trim()
    if (!line) continue
    const parts = line.split(',')
    if (parts.length < 3) continue
    const path = parts[0]!.trim()
    // ffmpeg is still writing the last row, so a field can be empty; Number('')
    // is 0, which would otherwise be accepted as a real timestamp.
    const readNumber = (value: string | undefined) => {
      const trimmed = (value ?? '').trim()
      return trimmed ? Number(trimmed) : Number.NaN
    }
    const start = readNumber(parts[1])
    const end = readNumber(parts[2])
    if (!path || !Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ path, start, end })
  }
  return out.sort((left, right) => left.start - right.start)
}

export function probeDurationMs(path: string): number | null {
  const result = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) return null
  const seconds = Number((result.stdout || '').trim())
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
}

/**
 * Continuous capture into short segments, holding only the recent tail.
 *
 * A funny moment is recognised after it happens, so nothing may start
 * recording on detection: the buffer must already own the last minute or so.
 * ffmpeg writes the segments and its own index, and `cut` concatenates the
 * overlapping ones back into a single file.
 */
export class RingBuffer {
  private child: ReturnType<typeof spawn> | null = null
  private readonly segmentSeconds: number
  private readonly segments: number
  private readonly ffmpeg: string
  private startedAt = 0
  private stopped = false

  constructor(private readonly options: RingBufferOptions) {
    this.segmentSeconds = options.segmentSeconds ?? 6
    this.segments = options.segments ?? 30
    this.ffmpeg = options.ffmpeg ?? 'ffmpeg'
  }

  get dir() {
    return this.options.dir
  }

  get running() {
    return Boolean(this.child) && !this.stopped
  }

  get tailMs() {
    return this.segmentSeconds * this.segments * 1000
  }

  get indexFile() {
    return join(this.options.dir, 'index.csv')
  }

  start() {
    if (this.child) return
    mkdirSync(this.options.dir, { recursive: true })
    rmSync(this.indexFile, { force: true })
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...this.options.inputArgs,
      ...(this.options.outputArgs ?? []),
      ...(this.options.copy
        ? ['-c', 'copy']
        : [
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '26',
            '-c:a',
            'aac',
            '-b:a',
            '96k',
          ]),
      '-f',
      'segment',
      '-segment_time',
      String(this.segmentSeconds),
      '-segment_wrap',
      String(this.segments),
      '-reset_timestamps',
      '1',
      '-segment_list',
      this.indexFile,
      '-segment_list_type',
      'csv',
      join(this.options.dir, 'seg_%05d.ts'),
    ]
    this.startedAt = Date.now()
    this.stopped = false
    this.child = spawn(this.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child.stderr?.on('data', () => {
      /* ffmpeg warnings are surfaced by a failed cut, not per line */
    })
    this.child.on('exit', () => {
      this.child = null
    })
  }

  stop() {
    this.stopped = true
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    this.child = null
  }

  /** Closed segments currently on disk, newest last. */
  segmentsNow(): Segment[] {
    if (!existsSync(this.indexFile)) return []
    let csv = ''
    try {
      csv = readFileSync(this.indexFile, 'utf8')
    } catch {
      return []
    }
    return parseSegmentIndex(csv)
      .slice(-this.segments)
      // ffmpeg writes the index with a bare file name even when given an
      // absolute output path, so resolve it against the buffer directory.
      .map((entry) => ({
        ...entry,
        path: isAbsolute(entry.path)
          ? entry.path
          : join(this.options.dir, basename(entry.path)),
      }))
      .filter((entry) => existsSync(entry.path))
      .map((entry) => ({
        path: entry.path,
        startMs: Math.round(entry.start * 1000),
        endMs: Math.round(entry.end * 1000),
      }))
  }

  /**
   * Cuts `durationMs` starting at a wall-clock instant out of the buffered
   * segments. Segment index times are relative to when ffmpeg started, so the
   * caller stays on wall clock and the conversion happens here.
   * Throws when nothing overlapping is on disk yet.
   */
  cut(wallStartMs: number, durationMs: number, outPath: string): CutResult {
    const startMs = Math.max(0, wallStartMs - this.startedAt)
    const all = this.segmentsNow()
    if (!all.length)
      throw new Error('ring buffer is empty: no closed segments yet')
    const endMs = startMs + durationMs
    const overlapping = all.filter(
      (segment) => segment.endMs > startMs && segment.startMs < endMs,
    )
    if (!overlapping.length)
      throw new Error('requested window is outside the buffered tail')
    const first = overlapping[0]!
    const actualStart = Math.max(startMs, first.startMs)
    const missedMs = actualStart - startMs
    const takeMs = Math.min(durationMs, all[all.length - 1]!.endMs - actualStart)
    if (takeMs <= 500) throw new Error('requested window is too small to cut')

    mkdirSync(dirname(outPath), { recursive: true })
    const listFile = `${outPath}.txt`
    writeFileSync(
      listFile,
      overlapping.map((segment) => `file '${segment.path}'`).join('\n') + '\n',
    )
    const result = spawnSync(
      this.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-ss',
        ((actualStart - first.startMs) / 1000).toFixed(3),
        '-t',
        (takeMs / 1000).toFixed(3),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        outPath,
      ],
      { encoding: 'utf8' },
    )
    rmSync(listFile, { force: true })
    if (result.status !== 0 || !existsSync(outPath))
      throw new Error(
        `ffmpeg cut failed: ${(result.stderr || '').trim().slice(-300) || `exit ${result.status}`}`,
      )
    return {
      path: outPath,
      bytes: statSync(outPath).size,
      durationMs: probeDurationMs(outPath) ?? takeMs,
      segments: overlapping.length,
      missedMs: Math.max(0, missedMs),
    }
  }
}
