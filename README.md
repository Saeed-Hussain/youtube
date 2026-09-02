# ClipForge

Upload a subtitle file, your clips and a voiceover. Get back a finished video where
each character is on screen at the exact moment their name is spoken.

**Your clip filenames are the cast.** No database. Deploys to Vercel.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

FFmpeg is bundled, so nothing needs installing. If you have your own build on
`PATH` it is preferred locally, since it usually has hardware encoders the
bundled binary lacks; `FFMPEG_PATH` pins a specific one.

The badge in the header tells you whether FFmpeg was found and whether hardware
encoding is available, before you upload anything.

```bash
npm run build && npm start   # production
npm test                     # 34 unit tests
npm run typecheck
```

---

## The two rules

Everything else follows from these.

### 1. The clip filenames define the cast

Name a file `drake_court_01.mp4` and Drake is a character. Nothing is guessed
from the subtitles.

An earlier version tried to *discover* characters by working out which
capitalised words in the script were proper nouns. On a real 23-minute script it
invented people — `Courts`, `Appeals`, `Whatever`, `American` — because English
capitalises the first word of every sentence and no heuristic fully separates a
name from a sentence opener. Meanwhile you had already told the system exactly
who mattered, when you named your footage.

The subtitles are consulted for exactly one question: **how much of the filename
is the name?** `kendrick_lamar_grammys.mp4` offers three readings — `kendrick`,
`kendrick lamar`, `kendrick lamar grammys` — and the right one is the longest
that the script actually says. The same rule gives `drake_court_01.mp4` → *Drake*
and `umg_building.mp4` → *UMG*, with no per-file configuration.

Shot qualifiers are stripped automatically: `wide`, `closeup`, `4k`, `1080p`,
`v2`, `final`, `take3`, plain numbers, and about sixty more. A clip whose
filename names nobody in the script becomes b-roll. To override any of it, click
**tag** on the clip and type the name.

### 2. Cuts follow the names, not the subtitle lines

A cut is placed wherever the subject changes, at the millisecond the new name is
spoken. Subtitle line breaks are an artefact of how the captions were formatted —
they have nothing to do with who is being talked about, so they never constrain
where a cut can fall.

This is what makes one line naming three people work:

```
00:00:09,866 --> 00:00:15,000
Drake and Kendrick and Faisal all signed the very same agreement.
```

```
 9866 – 10241   375ms   Drake      drake_stage.mp4
10241 – 10865   624ms   Kendrick   kendrik_superbowl.mp4
10865 – 14798  3933ms   Faisal     faisal_desk.mp4
```

Three shots, two of them well under a second, all inside a single cue. The
pacing preset sets a floor for shots — but **names always win over pacing**: a
named shot is never merged into a *different* character to satisfy a minimum,
because showing the wrong face is worse than a fast cut.

Cuts are also pulled back to the nearest clause boundary (a comma, `and`,
`while`) within a few words, so they land on the natural beat instead of a frame
after the name.

---

## Misspelled names

Transcribers and ASR get names wrong constantly. All of these resolve to the same
character, in both directions — a typo in the *filename* and a typo in the
*script*:

```
Kendrick Lamar   Kendrick   Kendrik   Kendrcik   Kendrick's   K. Lamar   KL
```

Three mechanisms, in order:

- **Edit distance** (Damerau–Levenshtein, so a transposition costs one edit not
  two) with a budget that scales with name length — 0 edits at four characters, 3
  at eleven. Tight enough that `Drake` never matches `Blake` or `Drama`.
- **Phonetic matching** (Double Metaphone) for respellings edit distance misses,
  such as `Faysal` for `Faisal`.
- **Canonicalisation**, so the spelling the script uses most is what gets
  displayed, and the Cast panel shows a `2 spellings fixed` badge naming the
  variants it folded in.

Every correction is visible in the UI rather than silent, so a *wrong* match is
something you can see before rendering.

---

## What it guarantees

Enforced in code and covered by tests, not aspirations:

| Guarantee | Where |
|---|---|
| Shots tile the timeline exactly — no gaps, no overlaps | `closeGaps` |
| Every cut sits on a word onset from the SRT | `buildSegments` |
| The finished video is exactly as long as the voiceover | `frameSpans` |
| A character is on screen while their own name is spoken | `buildSegments` |
| A named shot is never merged into a different character | `enforceFloors` |
| No shot runs past the pacing cap | `enforceCeiling` |

**Zero drift** is the important one. Asking FFmpeg for `-t 3.417` gives you
however many frames fit in 3.417 seconds, rounded — do that 400 times and the
rounding compounds into seconds of desync by the end of the video. Instead each
boundary is rounded to an absolute frame number and a shot's length is the
*difference* between two of them, so the errors telescope away and the sum is
exact however many cuts there are.

---

## Design

A light, print-like surface with a single elevation system. Every shadow is two
layers — a tight contact shadow that anchors an element and a wide ambient one
that gives it mass — always offset straight down, so the whole interface is lit
by one consistent overhead source.

Depth carries meaning rather than decoration:

- **Raised** — buttons and chips get a bevel highlight plus a drop shadow, lift
  1px on hover, and on press translate down while the shadow collapses to an
  inset. Moving the element and its shadow together is what sells a press.
- **Recessed** — inputs, sliders, progress meters and timeline lanes are cut
  *into* the surface. Because they are the inverse of a button, the two never
  read as the same kind of control.
- **Layered** — panels sit at elevation 2; the result player and shot inspector
  rise to 3 when present, because they are the thing you are looking at.

Timeline blocks get their volume from a top-edge highlight and a contact shadow
rather than a border, which at two pixels wide would consume the whole block.

---

## Speed

The previous version ran FFmpeg in the browser through WebAssembly — no
SIMD-tuned assembly, no multi-process parallelism, roughly an order of magnitude
slower than a native binary.

This one runs native FFmpeg server-side and encodes shots in parallel across
cores, then joins them with `-c:v copy`, so the final assembly re-encodes nothing
and completes at disk speed whether the video is two minutes or two hours.

Hardware encoding (NVENC / QSV / AMF / VideoToolbox) is used when it is genuinely
available — verified with a real one-frame test encode at startup, because every
Windows FFmpeg build lists `h264_nvenc` whether or not there is an NVIDIA card in
the machine.

Four further things that measurably matter, on a 4-core machine with QSV:

| | before | after |
|---|---|---|
| Render, 46.5s output | 19.5s | **13.3s** |
| Progress poll payload | 10KB–150KB | **132 bytes** (77× smaller) |
| Manifest writes per render | ~6.6MB of churn | ~200 bytes per update |

- **Adaptive filter chain.** Scale, pad and fps are dropped per-clip when the
  source already matches the output. A library that is already 1080p30 reduces
  to a bare pixel-format conversion instead of pushing every frame through
  swscale for no change in the picture.
- **Thread pinning.** Shots encode several at a time; left alone each libx264
  process spawns one thread per core, so N processes fight over N×cores threads.
  Dividing the cores between workers stops them competing.
- **Progress sidecar.** Render progress is written to its own ~200 byte file, so
  reporting it no longer re-serialises the whole manifest, and the browser polls
  that instead of pulling the entire shot list several times a second.
- **Single-pass lane bucketing.** The timeline buckets shots by character in one
  pass rather than filtering the full list once per lane — the naive version
  rebuilt ~1900 throwaway objects on every render, including every progress tick.

---

## End-to-end verification

```bash
npm run e2e:fixtures            # generate colour-coded test clips
npm run build && npm start -- -p 3111
npm run e2e
```

Each fixture clip is a single flat colour, so sampling the centre pixel of a
rendered frame identifies exactly which source clip was on screen at that
instant. "Did every clip land in its place" becomes an assertion instead of
something you have to watch the video to check. The fixtures deliberately mix
resolutions (640×480, 1080×1920, 1920×1080), frame rates (24/25/30) and durations
(1s–20s), include a misspelling, and use a voiceover ten seconds longer than the
subtitles.

```
=== VERIFICATION ===
voiceover source : 46.500s
output video     : 46.500s  (1395 frames @30fps = 46.500s)
video vs audio   : 28.0ms  PASS (under one frame)

12/12 shots show the correct clip.
```

---

## Deploying to Vercel

```bash
vercel deploy
```

Then **create a Blob store** in the project's Storage tab and redeploy. That is
the one manual step, and without it the app will tell you so on load rather than
failing later.

### What had to change to make this work

Vercel imposes four hard constraints, and each one needed an architectural
answer rather than a setting:

| Constraint | How it is handled |
|---|---|
| **No FFmpeg on the host** | `ffmpeg-static` is bundled into the function (~79MB of a 250MB budget) and, since files unpacked into a serverless bundle have no executable bit, copied to `/tmp` and chmodded on first use. `ffprobe` is *not* shipped — it would add 171MB — so media is probed by parsing `ffmpeg -i` instead. |
| **Read-only filesystem** | Nothing writes to disk. All state goes through a storage adapter: the local filesystem in development, Vercel Blob in production. `/tmp` is used only as scratch space inside a single invocation. |
| **4.5MB request body cap** | Clips never touch a function. The browser requests a scoped, single-use token from `/api/blob-upload` and streams the file straight to Blob, then tells the server about it via `/api/jobs/:id/register`. |
| **60s execution limit** | The render is a resumable state machine the client drives one step at a time. |

### How the chunked render works

A twenty-minute video takes far longer to encode than any function may run, and
work started with `void` is killed the moment the response is sent. So the
render is split into steps that each fit inside one invocation:

```
POST /render          set up: normalise audio, pick encoder, compute frame budget
POST /render/step  ×N  encode shots  ->  fold into parts  ->  concatenate
```

Each step works until a time budget expires, records exactly where it stopped in
the manifest, and returns `{ more: true }`. The next call — almost certainly on a
different instance with a different `/tmp` — reads that state and continues. A
dropped call costs one retry, not the render.

The middle stage exists purely to bound `/tmp`: pulling several hundred finished
segments down at once would exceed the 512MB scratch space, so segments are
folded into part files in groups of 40, and only the handful of parts is needed
at the end.

### Limits you should know about

These are honest constraints of the platform, not bugs:

- **Hobby caps functions at 60s and 2048MB.** Both are set in `vercel.json`;
  asking for more fails the deploy. On Vercel, vCPU is allocated in proportion
  to memory (roughly one per 1769MB), so a Hobby function has about **one core**
  and encodes one shot at a time. A long video therefore means a lot of short
  steps.

  On Pro, raise all three together for far fewer, longer steps:

  ```jsonc
  // vercel.json
  { "maxDuration": 300, "memory": 3009 }   // 3009MB ~= 2 vCPU
  ```
  ```bash
  CLIPFORGE_STEP_BUDGET_MS=280000
  ```

  Concurrency is derived from the function's real memory allocation rather than
  `os.cpus()`, which reports the shared host and would have the renderer spawn
  eight encoders on a single core. `CLIPFORGE_CORES` overrides the calculation.
- **The browser tab must stay open** during a render, because the client drives
  the loop. Closing it pauses the render; reopening the job resumes it, since
  all progress is in the manifest.
- **No hardware encoding.** The bundled FFmpeg is CPU-only, so renders are
  slower than on a machine with NVENC or QSV.
- **Blob storage is billed** by volume and bandwidth. Jobs older than 24 hours
  are pruned when a new one starts.
- **Cold starts pay ~80MB** of `/tmp` writes to stage the FFmpeg binary, once
  per instance.

If any of that is unwelcome, the same codebase runs unchanged on a normal server
— set `CLIPFORGE_DATA` to a writable path, install FFmpeg, and it uses the
filesystem and the system binary automatically.

### Local development

Nothing above applies locally. With no `BLOB_READ_WRITE_TOKEN` set, the app uses
the filesystem and your own FFmpeg, and uploads go through the server:

```bash
npm run dev
```

### Checking a deployment

`GET /api/system` reports every requirement before you upload anything, and the
UI shows the same as a banner:

```json
{ "ready": true, "storageWritable": true, "storageKind": "blob",
  "ffmpeg": "ffmpeg version 6.0", "encoder": "x264", "concurrency": 3 }
```

`storageKind: "local"` on a Vercel deployment means no Blob store is attached —
that is the one failure worth watching for.

---

## Layout

```
src/lib/
  srt.ts        tolerant SRT/VTT parser -> word-level timeline
  cast.ts       clip filenames -> characters -> mentions
  fuzzy.ts      edit distance + phonetic matching
  segment.ts    mentions -> cut points
  plan.ts       cut points -> shot list (which clip, which seconds)
  ffmpeg.ts     FFmpeg: binary resolution, probing, encoding, frame maths
  render.ts     the chunked, resumable render state machine
  storage.ts    one interface over the filesystem and Vercel Blob
  ingest.ts     validating and attaching an uploaded file
  pipeline.ts   analysis orchestration
  jobs.ts       job manifests

src/app/api/
  blob-upload           issues scoped tokens for direct browser uploads
  jobs/[id]/register    attaches a directly-uploaded file
  jobs/[id]/render      starts a render
  jobs/[id]/render/step advances it by one invocation
  jobs/[id]/progress    ~200 byte poll payload
  files/[...key]        serves local objects in development only

src/components/ Timeline  ShotInspector  CastPanel  ClipLibrary  DropZone
tests/          unit tests + e2e harness
legacy/         the previous single-file build, kept for reference
```

A job is a manifest plus its media, under the `jobs/<uuid>/` prefix — in `.data`
locally, in Blob on Vercel. Jobs older than 24 hours are pruned when a new one
starts.

---

## Notes and limits

- **A character with no clip is not in the edit.** That is the point of rule 1 —
  if you want someone on screen you need footage for them, or a name in *Extra
  names* plus a tagged clip.
- **Timing still comes from the SRT.** Cue *structure* is ignored, but the
  word-level timings the cues imply are the only clock available. If your
  subtitles are misaligned with your voiceover, the cuts inherit that.
- **`ffmpeg-static` downloads its binary in a postinstall script.** If a build
  environment disables install scripts, the binary will be missing and
  `/api/system` will say so.
