# ffmpeg recipes

Phase B (capture + render) builds on these commands. They are recorded here so
the pipeline is written once, correctly, instead of re-derived from memory.

## The ring buffer (why capture is continuous)

A moment is only recognised 20–40 seconds after it happens, so the runner must
already hold the recent past. Capture continuously into short segments and keep
a window on disk:

```sh
ffmpeg -hide_banner -loglevel warning \
  -i "$STREAM_HLS" \
  -c copy -f segment -segment_time 6 -segment_wrap 30 \
  -reset_timestamps 1 \
  "$BUF/seg_%03d.ts"
```

- `-segment_time 6` + `-segment_wrap 30` = 30 segments × 6 s ≈ 3 minutes of tail.
- `-c copy` means no transcoding: cheap on an old Intel Mac.
- When a moment is confirmed at time `T`, join the segments covering
  `[T-35s, T+5s]` and cut precisely from that.

Concatenate and cut in one pass:

```sh
printf "file '%s'\n" "$BUF"/seg_0{07,08,09,10,11,12}.ts > "$TMP/list.txt"
ffmpeg -hide_banner -f concat -safe 0 -i "$TMP/list.txt" \
  -ss 12.4 -t 30 -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 128k \
  -movflags +faststart "$TMP/moment.mp4"
```

## Bandwidth: buffer small, re-fetch the moment at full quality

Buffering every stream at full quality costs ~2.7 GB per hour per channel
(6 Mbps). Buffer at 480p and, once a moment is confirmed, fetch only that window
again at best quality:

```sh
# detection buffer
ffmpeg -i "$(yt-dlp -g -f 'bv*[height<=480]+ba/b[height<=480]' "$URL")" …

# the confirmed 40 seconds, at source quality
yt-dlp -f 'bv*+ba/b' --download-sections '*00:12:30-00:13:10' \
  -o "$TMP/moment.%(ext)s" "$URL"
```

Check the result with `ffprobe -v error -show_entries format=duration -of csv=p=0`.

## 9:16, blurred fill (safe default)

Crops nothing away and needs no face tracking, which is why it is the default:

```sh
ffmpeg -y -i moment.mp4 -filter_complex "\
[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,\
boxblur=28:2,eq=brightness=-0.08[bg];\
[0:v]scale=1080:-2[fg];\
[bg][fg]overlay=(W-w)/2:(H-h)/2[out]" \
  -map "[out]" -map 0:a \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart vertical.mp4
```

## 9:16, centre crop (variant)

```sh
ffmpeg -y -i moment.mp4 -vf "crop=ih*9/16:ih,scale=1080:1920" …
```

Face tracking (`sendcmd` + `crop` with per-frame x offsets, or OpenCV on the
runner) is a later optimisation: it is the step that usually breaks, so it is not
in the default path.

## Karaoke captions (ASS, burned in)

Generate one `Dialogue` per 2–4 word cue from Whisper word timings. A cue that
highlights word by word uses inline karaoke tags:

```
[Script Info]
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Montserrat ExtraBold,96,&H00FFFFFF,&H0000D7FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,2,90,90,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:02.10,Cap,,0,0,0,,{\k30}NO {\k45}WAY
```

Burn it (single quotes inside the filter are fragile — use a filter script file
for anything longer):

```sh
ffmpeg -y -i vertical.mp4 -vf "subtitles=captions.ass:fontsdir=./fonts" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a copy out.mp4
```

Keep cues to 3–4 words, uppercase, ~90 px on a 1080-wide frame, bottom margin
above the platform UI (≈520 px from the bottom is a safe band).

## Hook overlay (first 2 seconds)

Either a second ASS style with a large centred `Dialogue` for 0–2 s, or
`drawtext` when the text is fixed:

```sh
ffmpeg -y -i vertical.mp4 -vf "drawtext=fontfile=./fonts/Anton.ttf:text='HE COOKED THE ENTIRE LOBBY':fontsize=84:fontcolor=white:borderw=6:bordercolor=black:x=(w-text_w)/2:y=140:enable='lt(t,2)'" …
```

## Loudness and delivery

Platforms normalise towards roughly −14 LUFS; matching it keeps clips from
sounding quiet next to everyone else's:

```sh
ffmpeg -y -i out.mp4 -af "loudnorm=I=-14:TP=-1.5:LRA=11" \
  -c:v copy -c:a aac -b:a 192k final.mp4
```

Delivery settings that avoid platform re-encode surprises: H.264 High,
`-pix_fmt yuv420p`, `-movflags +faststart`, 1080×1920, 30 or 60 fps, AAC stereo.

## Thumbnail

```sh
ffmpeg -y -ss 0.6 -i final.mp4 -frames:v 1 -q:v 3 thumb.jpg
```
