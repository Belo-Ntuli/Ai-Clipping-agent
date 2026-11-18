# Platform API notes

Verified facts this project depends on. When something here turns out to be
wrong, fix it here first, then the code. Written 2026-11-18.

## Twitch

**Live status** — `GET https://api.twitch.tv/helix/streams?user_login=a&user_login=b`.
Accepts an app access token (client credentials) or a user token. One request
covers up to 100 channels; only live channels are returned, so presence in the
response *is* the live signal. Rate limits are a token bucket per client id;
read the `Ratelimit-*` response headers instead of hard-coding a number.

**Chat** — IRC over WebSocket at `wss://irc-ws.chat.twitch.tv:443`. Anonymous
read works with `PASS justinfan<number>` + `NICK justinfan<number>`; no OAuth and
no inbound port. `CAP REQ :twitch.tv/tags` adds tags (emotes, badges). Reply to
`PING` with `PONG :tmi.twitch.tv` or the socket drops. EventSub WebSocket is the
production alternative but needs a user token for chat subscriptions.

**Creating a clip** — `POST https://api.twitch.tv/helix/clips?broadcaster_id=…`.
Requires a **user** access token with `clips:edit`. The capture window is about
90 seconds: roughly 85 seconds before the call and 5 after, so it cannot reach
further back than that. Creation is asynchronous — poll `GET /helix/clips` for
the returned id; if it has not appeared within about 60 seconds, treat it as
failed. Clips are 5–60 seconds long and the `edit_url` stays valid for 24 hours.

**Clip from VOD (open beta)** — creates a clip from a video id, which includes
the current stream when VODs are enabled. That is the escape hatch when a moment
is detected later than 85 seconds, and the basis for post-stream passes.

**Not verified:** whether an ordinary user token can clip a channel the account
does not moderate. Test it against a live third-party channel before relying on
it; the ring-buffer capture path is the fallback.

## Kick

**OAuth 2.1** on `id.kick.com` (`/oauth/authorize`, `/oauth/token`,
`/oauth/revoke`). App access tokens via client credentials read public data;
user tokens via authorization code + PKCE. Register an app in account settings →
Developer (2FA required).

**Coverage** — the public API at `api.kick.com/public/v1` handles users,
channels, livestreams, categories, chat **sending**, moderation, channel
rewards, KICKs and ads. It has **no clip-creation endpoint**, which is why Kick
capture has to run through HLS + ffmpeg on the runner.

**Reading chat** — officially webhooks only: `POST /public/v1/events/subscriptions`
with `events: [{ name: "chat.message.sent", version: 1 }]`, `method: "webhook"`
and the `events:subscribe` scope. An app access token must pass
`broadcaster_user_id`; a user token infers it. The delivery URL is a setting on
the Kick app, and it **must be publicly reachable** — `localhost` will not work
without a tunnel. Verify `Kick-Event-Signature` against Kick's public key
(signature covers `message_id.timestamp.raw_body`); `Kick-Event-Message-Id` is
the idempotency key. Limits: 10,000 subscriptions per event type per app, but
only 1,000 for `chat.message.sent` on unverified apps.

Because of the public-URL requirement, the webhook receiver lives on the
dashboard (always up, public), which stores messages and lets the runner pull
them — no tunnel on the Mac. Kick's own site also exposes an undocumented
Centrifugo/Pusher WebSocket (`chatrooms.{id}.v2`, `Origin: kick.com`); it works
today but is not a contract, so it is only a latency fallback.

**No clip endpoint, no documented chat-read REST.** Do not invent either.

## TikTok (phase C)

Two paths: **Direct Post** (`/v2/post/publish/video/init/`, scope
`video.publish`) publishes to the profile; **Upload**
(`/v2/post/publish/inbox/video/init/`, scope `video.upload`) drops the video in
the creator's inbox as a draft. Upload is worth starting with because it avoids
the audit gate on visibility while you test.

The audit gate is strict: content from **unaudited** clients is restricted to
private (`SELF_ONLY`) viewing, capped at 5 posting users per 24 hours, and those
accounts must be private at the time of posting. Lifting it requires an audit
against TikTok's terms. Even audited clients face a creator cap and roughly 15
posts per day per creator. Each user token is limited to 6 requests per minute.
App review expects a real website with privacy policy and terms and says apps
must not be for private or personal use — the dashboard origin can serve as that
website.

## YouTube (phase C)

`videos.insert` has its **own quota bucket since 1 June 2026**: 100 calls/day at
1 unit each, per Google Cloud project (not per channel). `search.list` has
another 100/day bucket; every other method shares 10,000 units/day. Quotas reset
at midnight Pacific. Max upload size is 256 GB.

OAuth: an external app whose publishing status is **Testing** gets refresh
tokens that **expire after 7 days**, with at most 100 test users. Moving to
production unlocks long-lived tokens but `youtube.upload` is a sensitive scope,
so it needs verification. Build the reconnect path: expect to re-authorize
weekly while the app is in Testing, and surface it as a banner plus a runner
event instead of failing silently. Google accepts `http://localhost` redirect
URIs for development, so no HTTPS or public domain is needed to set this up. The
scope string is `https://www.googleapis.com/auth/youtube.upload`.

**Shorts classification:** there is no Shorts endpoint, no `publishAsShort`
flag, and no hashtag requirement. `videos.insert` is the only upload method, and
YouTube decides after the fact from the file: **square or vertical, 3 minutes or
less** for uploads on or after 15 Oct 2024. A 16:9 file stays long-form however
short it is. Also: a Short **over one minute** with an active Content ID claim is
blocked worldwide, which matters when the footage is someone else's stream.
Setup walkthrough: [youtube-setup.md](youtube-setup.md).

## Content Rewards

A clipping/UGC campaign marketplace (contentrewards.com; formerly ran on Whop).
The flow is not ours to change:

1. You connect the accounts you post from (TikTok, Instagram, YouTube, X,
   Facebook). Instagram must be a **Business** account. Whop-linked accounts do
   not count.
2. You pick a campaign, which sets the rate (CPM, per post, retainer or pool
   split), the minimum a clip must earn before it pays, the maximum one clip can
   earn, the accepted platforms and the brief.
3. You post from your own account, then **submit the link within 30 minutes**.
4. Only approved posts pay.

There is **no public submission API**, so submission is assisted: generate the
caption and hashtags to the brief, copy to clipboard, deep-link the campaign
page, record the post URL, and track the 30-minute window and per-clip earnings
in the dashboard.

## Not available anywhere (do not promise it)

- Retention / watch-time / average-view-duration from any posting API. Use early
  view velocity (first 60–90 minutes) as the bandit signal instead.
- A Kick clip-creation endpoint.
- A Content Rewards submission API.
- Downloading a YouTube live stream for redistribution. Clip sources are
  campaign-supplied footage or channels whose brief grants clip rights.
