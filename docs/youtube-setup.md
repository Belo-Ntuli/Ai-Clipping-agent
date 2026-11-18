# Getting YouTube working

YouTube plays two roles in this tool, and they are not equally legal:

1. **Posting target** (what you actually want): upload finished clips as Shorts to
   your own channel, then submit the link to a Content Rewards campaign. This
   needs OAuth credentials — covered below.
2. **Source** (watching streams to find moments): do not capture YouTube live
   streams and re-upload them. YouTube's terms do not allow it, and the footage
   belongs to the streamer unless a brief grants clip rights. Where a campaign
   supplies a VOD or playlist, clipping *that* is fine — same pipeline, sourced
   from a file instead of a live buffer.

Twitch and Kick are the live sources. YouTube is the distribution channel.

## What you need from Google

One Google Cloud project, one OAuth client, and the `youtube.upload` scope. Free,
no company needed, and **no verification** as long as the app stays in Testing
and only your own account signs in.

### 1. Create the project

1. https://console.cloud.google.com → project selector → **New project**.
   Name it something like `clipper`.
2. With it selected, go to **APIs & Services → Library**, search
   **YouTube Data API v3**, and **Enable** it.

### 2. Consent screen

**APIs & Services → OAuth consent screen** (newer consoles call it *Google Auth
Platform → Branding / Audience*):

- User type: **External**.
- App name, support email, developer contact: your own details are fine.
- **Audience → Test users → Add users**: add the Google account that owns the
  YouTube channel. Without this, sign-in fails with `403 access_denied`.
- Leave publishing status at **Testing** for now.

### 3. OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID**:

- Application type: **Web application**.
- **Authorized redirect URIs** — register both; these are the two places the
  dashboard can call back to:
  - `http://localhost:5173/api/youtube/callback` (or whatever port `bun run dev`
    prints — the port must match exactly)
  - `https://<your-sites-domain>/api/youtube/callback` (add later, if you publish)
- Save, then copy the **Client ID** and the **Client secret** (shown once).

Google explicitly allows `http://localhost` redirect URIs for development, so you
do not need HTTPS or a public domain to get this working on your Mac.

### 4. Hand the credentials over safely

Put them in the project's env file yourself, or in the Desktop/Sites secrets
field — **never into the chat**. The names the app will read:

```
GOOGLE_CLIENT_ID= 253051668317-24tnvjoq1mh56a3ioe190fdioqqbjh6t.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET= 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
```

The account's OAuth tokens get stored server-side (encrypted) after you click
"Connect YouTube" in the dashboard. The runner never sees them.

## The two traps

**1. Refresh tokens expire every 7 days while the app is in Testing.**
This is the one that silently kills unattended uploads: an external client in
Testing gets a refresh token that dies after 7 days, and only the *next* upload
fails. Options, cheapest first:

- Accept a weekly "Reconnect YouTube" click. The dashboard shows a banner and the
  runner logs an event instead of failing silently.
- Move the app to **In production**. That unlocks long-lived tokens, but
  `youtube.upload` is a sensitive scope, so it needs Google verification (public
  homepage, privacy policy, terms, demo video). Overkill for one person's
  channel.

**2. Uploads have their own quota bucket: 100 per day.**
Since 1 June 2026 `videos.insert` is billed to a separate bucket of **100 calls
per day, 1 unit each**, per Cloud project — not per channel. Everything else
(e.g. `videos.list`) shares 10,000 units a day, and `search.list` gets its own
100/day. Resets at midnight Pacific.

Practical implication: 100 uploads/day is plenty, but a retry loop that re-posts
on a transient error can eat it. Posting must be idempotent — record the video id
before retrying.

## What a Short actually is

There is no Shorts endpoint, no `publishAsShort` flag, and no hashtag
requirement. `videos.insert` is the only upload method. YouTube classifies a
video as a Short **after** upload, from the file itself: **square or vertical,
3 minutes or less** (for uploads on or after 15 Oct 2024). A 16:9 file stays a
regular video no matter how short it is.

Our renderer output already qualifies: 1080×1920, 30–44 seconds. Nothing extra
to set — it just has to stay vertical and under 3 minutes.

One caveat worth knowing: a Short **longer than one minute** with an active
Content ID claim is blocked worldwide rather than monetised. For clips of other
people's streams that is a real risk, which is another reason campaign-supplied
footage (where rights are granted) is the safe source.

## Upload mechanics (what the code will do)

```
POST https://www.googleapis.com/upload/youtube/v3/videos
     ?uploadType=resumable&part=snippet,status
Authorization: Bearer <access token>
```

1. Send metadata, receive a resumable session URI.
2. PUT the file in chunks that are multiples of 256 KB.
3. `snippet.title` (≤100 chars, no `<` or `>`), `snippet.description`,
   `snippet.tags`, `status.privacyStatus`.
4. `status.selfDeclaredMadeForKids` is **required** — `false` unless the content
   is for kids.
5. Keep the returned video `id`: it is the campaign submission link
   (`https://youtube.com/shorts/<id>`) and the key for tracking views later.

Max file size is 256 GB; our clips are a few MB.

## Checklist before I wire it up

- [x] YouTube Data API v3 enabled on the project
- [x] OAuth consent screen: External, your channel's account added as a test user
- [x] OAuth client of type **Web application**
- [x] Redirect URI `http://localhost:<dev port>/api/youtube/callback` registered
- [x] `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the project's env/secrets
- [x] Decided: weekly reconnect while in Testing, or start verification

Once those are in place I can build the connect flow, the upload adapter, and the
per-clip posting history that the campaign submission step needs.
