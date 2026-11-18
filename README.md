# Clipper

An agent that watches live streams, flags the moments worth clipping, and hands
them to you for approval. Phase A is the watch loop and the dashboard; capture,
rendering, posting and campaign submission follow.

```
runner (your Mac)                          dashboard (Sites)
  watchlist ───────────────────────────────► sources, candidates, review
  30s tick: live check + chat scoring         approve / reject, runner tokens
  candidates ──────────────────────────────►  agent log, live status
```

The runner pulls its watchlist from the dashboard every tick, so the dashboard
is the source of truth and the Mac never needs an inbound port or a tunnel.

## Start

```sh
bun install
bun run dev                     # dashboard

bun run runner demo             # cut a clip from a synthetic stream
bun run runner mock             # whole pipe, no credentials needed
bun run runner doctor           # credentials + ffmpeg + resolvers + disk
bun run runner start            # watch the dashboard watchlist
```

`demo` and `mock` need no credentials. For real streams, create a runner in the
dashboard's **Runners** tab, paste the token into `runner/.env`, add a Twitch or
Kick channel under **Channels**, and install `ffmpeg` plus `streamlink` (or
`yt-dlp`). See [SETUP.md](SETUP.md) for app registration, auto-start and moving
machines.

## What the runner does each tick

1. Reports which channels are live and picks up watchlist changes.
2. Buffers every live channel continuously into 6-second segments, keeping a
   3-minute tail on disk (`runner/buffer/`).
3. Computes a chat signal per channel: message velocity against its own rolling
   baseline (z-score), whole-word hit words, and emote bursts counted across
   distinct messages.
4. Scores it 0–100. Above the threshold, with a per-channel cooldown, it waits
   for the post-roll and **cuts the moment out of the buffer** into
   `runner/clips/`, then posts the candidate with the clip's metadata.
5. Everything appears in the dashboard: **Live** for the feed, **Review** to
   approve or reject.

Detection is chat-only, and the UI says so: a candidate with a clip means video
was buffered, not that audio was analysed. Clip files stay on the runner — the
dashboard stores metadata only, because a personal Mac is not a media host.
Audio loudness and the Whisper transcript join the score with rendering.

## Watching it work without a stream

`bun run runner replay <video-file>` pushes a local video through the real
pipeline: it is paced and buffered into 2-second segments exactly like a live
channel, an 8-second moment is cut out of the buffer, and the candidate is posted
with the clip's metadata. It needs a channel on the watchlist and a runner token,
and it prints what the dashboard did with the moment — including when your
content rules refuse it.

That is the honest test of the path before any platform is involved. Live
channels use the same code; the only difference is where the video comes from.

## Content rules

Guardrails live in **Channels → Content rules**, and they are enforced twice: on
the runner before anything is encoded, and again on the dashboard when a moment
arrives. Adding a channel *is* the approval; a moment in a category you did not
allow, or whose chat contains a blocked word, is stored as `blocked` with a
readable reason and never enters the review queue. **Pause all clipping** is a
hard stop for capture, not just for publishing.

The rules are deliberately literal: categories match exactly (case-insensitive),
blocked words are plain substrings of the chat sample, and an unknown category is
refused while a category allowlist is set. Failing closed is the point. One
implementation, `src/shared/policy.ts`, is shared by the runner, the dashboard
and the tests.

## Layout

```
src/worker/    Hono routes: dashboard API and runner token API
src/client/    React dashboard (JARVIS HUD skin)
src/shared/    shared types and the content-policy screen
runner/src/    config, twitch, kick, score, buffer, stream, api, mock, CLI
docs/          platform-apis.md, ffmpeg-recipes.md, youtube-setup.md
```

Read [AGENTS.md](AGENTS.md) for the invariants, and
[docs/platform-apis.md](docs/platform-apis.md) before touching a platform API.

## Checks

```sh
bun run typecheck
bun test
bun run build
```
