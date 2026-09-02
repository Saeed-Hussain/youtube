/* ═══════════════════════════════════════════════════════════
   ClipForge — app.js  v6  (FFmpeg.wasm FAST renderer)
   Supabase Project : youtube  (uiiqbrauacuyisrgjvzw)

   What changed from v5:
   ─────────────────────
   • Render is no longer "play each clip in real time into a
     canvas". That approach was 4-50× slower than necessary.
   • New renderer uses FFmpeg.wasm:
       – FAST PATH:   if all clips are MP4/H.264 → stream-copy
                      concat (no re-encode → near-instant).
       – NORMAL PATH: re-encode + concat in a single pass with
                      multi-threaded WASM + SIMD.
   • Output is real .mp4 (H.264), not .webm.
   • Face scan, character tagging, transcript, script matching,
     Supabase save logic — all unchanged.
   • ffmpeg.wasm is lazy-loaded on first render (no upfront 30 MB).
   ═══════════════════════════════════════════════════════════ */
'use strict';

// ─────────────────────────────────────────────────────────────
// 1.  SUPABASE CONFIG
// ─────────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://uiiqbrauacuyisrgjvzw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpaXFicmF1YWN1eWlzcmdqdnp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2OTk0MjQsImV4cCI6MjA5NjI3NTQyNH0._uN-QwYt9xMgf_FJtIjaKtVPjDnoMZpe1YC-GvzTK8A';

// ─────────────────────────────────────────────────────────────
// 2.  SUPABASE CLIENT + DB HELPERS
// ─────────────────────────────────────────────────────────────
let db;

async function dbInsert(table, data) {
  const { data: row, error } = await db.from(table).insert(data).select().single();
  if (error) throw error;
  return row;
}
async function dbInsertMany(table, rows) {
  const { data, error } = await db.from(table).insert(rows).select();
  if (error) throw error;
  return data || [];
}
async function dbSelect(table, filters = {}) {
  let q = db.from(table).select('*').order('created_at', { ascending: false });
  Object.entries(filters).forEach(([col, val]) => { q = q.eq(col, val); });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
async function dbSelectWhere(table, col, val) {
  const { data, error } = await db.from(table).select('*').eq(col, val).order('clip_index');
  if (error) throw error;
  return data || [];
}
async function dbDelete(table, id) {
  const { error } = await db.from(table).delete().eq('id', id);
  if (error) throw error;
}
async function storageUpload(bucket, path, file) {
  const { error } = await db.storage.from(bucket).upload(path, file, { upsert: true });
  if (error) throw error;
  const { data } = db.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

// ─────────────────────────────────────────────────────────────
// 3.  SCHEMA BOOTSTRAP
// ─────────────────────────────────────────────────────────────
async function bootstrapSchema() {
  try {
    await db.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS project_clips (
          id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          created_at   timestamptz DEFAULT now(),
          project_id   uuid REFERENCES projects(id) ON DELETE CASCADE,
          clip_name    text NOT NULL,
          clip_index   int  NOT NULL DEFAULT 0,
          characters   text[] DEFAULT '{}',
          duration_sec numeric,
          file_size_mb numeric
        );
        ALTER TABLE project_clips ENABLE ROW LEVEL SECURITY;
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='project_clips' AND policyname='public_all_pc') THEN
            CREATE POLICY "public_all_pc" ON project_clips FOR ALL TO anon USING (true) WITH CHECK (true);
          END IF;
        END $$;
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS characters text[] DEFAULT '{}';
      `
    });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// 4.  GLOBAL STATE
// ─────────────────────────────────────────────────────────────
const STATE = {
  currentPage: 'dashboard',
  currentStep: 1,
  characters:  [],
  clipTagMap:  {},
  project: {
    title:        '',
    videoFiles:   [],
    scriptText:   '',
    audioFile:    null,
    analysis:     { faces: {}, transcript: '', scriptMatches: [] },
    renderedBlob: null,
    supabaseId:   null
  },
  faceApiReady: false,
  ffmpeg: null,
  ffmpegReady: false
};

// ─────────────────────────────────────────────────────────────
// 5.  DOM SHORTCUTS
// ─────────────────────────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ─────────────────────────────────────────────────────────────
// 5b. FILE BYTES CACHE
// ─────────────────────────────────────────────────────────────
// Browser File objects are handles, not in-memory copies. Re-reading the same
// File via .arrayBuffer() more than once (render pass → Filmora export →
// clip-ZIP export, etc.) can fail with a permission/read error if the
// underlying OS-level reference has gone stale (tab idle, file moved, input
// cleared, etc.) — "The requested file could not be read, typically due to
// permission problems that have occurred after a reference to a file was
// acquired." To avoid this, read each File's bytes ONCE, lazily, the first
// time it's needed, and cache the result. Every later read reuses the cache
// instead of touching the live File handle again.
const _fileBytesCache = new WeakMap(); // File -> Promise<ArrayBuffer>

function getFileBytes(file) {
  if (!_fileBytesCache.has(file)) {
    _fileBytesCache.set(file, file.arrayBuffer().catch(err => {
      _fileBytesCache.delete(file); // don't poison the cache with a failed read
      throw new Error(
        'Could not read "' + file.name + '" — the file reference may be stale ' +
        '(try re-adding it via the upload step). Original error: ' + err.message
      );
    }));
  }
  return _fileBytesCache.get(file);
}

// Returns a fresh, independent copy of the cached bytes every time. Some
// consumers (FFmpeg.wasm's writeFile / fetchFile) detach/transfer the
// ArrayBuffer they're given, which would corrupt the cache for later callers
// if we handed out the same buffer instance twice.
async function getFileBytesCopy(file) {
  const ab = await getFileBytes(file);
  return ab.slice(0);
}

// ─────────────────────────────────────────────────────────────
// 6.  NAVIGATION
// ─────────────────────────────────────────────────────────────
function goTo(page) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  const el = $('page-' + page);
  if (!el) { console.error('Missing page: page-' + page); return; }
  el.classList.add('active');
  document.querySelector('[data-page="' + page + '"]')?.classList.add('active');
  STATE.currentPage = page;
  $('topbarTitle').textContent = { dashboard: 'Dashboard', characters: 'Characters', upload: 'New Project', projects: 'Projects' }[page] || page;
  if (page === 'dashboard')  loadDashboard();
  if (page === 'characters') renderCharacters();
  if (page === 'projects')   loadProjects();
  if (page === 'upload') {
    STATE._videoFileStore = [];
    renderClipRows([]);
    $('videoFiles').value = '';
    goToStep(1);
  }
  if (window.innerWidth < 900) $('sidebar').classList.remove('open');
}

function goToStep(n) {
  $$('.step-content').forEach(s => s.classList.remove('active'));
  $$('.step').forEach((s, i) => {
    s.classList.remove('active', 'done');
    if (i + 1 < n)  s.classList.add('done');
    if (i + 1 === n) s.classList.add('active');
  });
  $('step' + n)?.classList.add('active');
  STATE.currentStep = n;
}

// ─────────────────────────────────────────────────────────────
// 7.  TOAST
// ─────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const icons = { success: '✓', error: '✕', info: '◎' };
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span>' + (icons[type] || '◎') + '</span><span>' + msg + '</span>';
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ─────────────────────────────────────────────────────────────
// 8.  PIPELINE LOG
// ─────────────────────────────────────────────────────────────
function log(msg, type = '') {
  console.log('[ClipForge]', msg);
  const entries = $('logEntries');
  if (!entries) return;
  const now = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = '<span class="log-time">' + now + '</span><span class="log-msg ' + type + '">' + msg + '</span>';
  entries.appendChild(el);
  entries.scrollTop = entries.scrollHeight;
}

// ─────────────────────────────────────────────────────────────
// 9.  PROGRESS BAR
// ─────────────────────────────────────────────────────────────
function setProgress(pct, label) {
  const fill = $('progressFill'), pctEl = $('progressPct'), lblEl = $('progressLabel');
  if (fill)  fill.style.width  = pct + '%';
  if (pctEl) pctEl.textContent = Math.round(pct) + '%';
  if (label && lblEl) lblEl.textContent = label;
}

// ─────────────────────────────────────────────────────────────
// 10. FACE-API.JS  (kept from v5; face-api is loaded from CDN
//     on first need, not on page boot)
// ─────────────────────────────────────────────────────────────
const FACEAPI_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

async function loadFaceApiLib() {
  if (window.faceapi) return;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.js';
    s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function loadFaceApiModels() {
  if (STATE.faceApiReady) return;
  try {
    log('Loading face-detection models…', 'info');
    await loadFaceApiLib();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(FACEAPI_MODELS),
      faceapi.nets.faceLandmark68Net.loadFromUri(FACEAPI_MODELS),
      faceapi.nets.faceRecognitionNet.loadFromUri(FACEAPI_MODELS)
    ]);
    STATE.faceApiReady = true;
    log('Face-api models loaded ✓', 'success');
  } catch (e) { log('Face-api load failed: ' + e.message, 'error'); }
}

async function getFaceDescriptor(imgEl) {
  try {
    const d = await faceapi.detectSingleFace(imgEl, new faceapi.TinyFaceDetectorOptions())
                           .withFaceLandmarks().withFaceDescriptor();
    return d?.descriptor || null;
  } catch { return null; }
}

function buildFaceMatcher() {
  if (!window.faceapi) return null;
  const labeled = STATE.characters
    .filter(c => c.descriptors?.length > 0)
    .map(c => new faceapi.LabeledFaceDescriptors(c.name, c.descriptors.map(d => new Float32Array(d))));
  return labeled.length ? new faceapi.FaceMatcher(labeled, 0.5) : null;
}

async function detectFacesInCanvas(canvas, matcher) {
  if (!matcher) return [];
  const dets = await faceapi.detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
                             .withFaceLandmarks().withFaceDescriptors();
  return dets.map(d => {
    const m = matcher.findBestMatch(d.descriptor);
    return { label: m.label, confidence: Math.round((1 - m.distance) * 100) };
  }).filter(r => r.label !== 'unknown' && r.confidence >= 50);
}

async function analyseVideoForFaces(videoFile, matcher) {
  return new Promise(resolve => {
    const results = {};
    const url = URL.createObjectURL(videoFile);
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let frameCount = 0;
    const INTERVAL = 5;

    video.src = url; video.muted = true; video.crossOrigin = 'anonymous';
    video.addEventListener('loadedmetadata', () => { canvas.width = video.videoWidth; canvas.height = video.videoHeight; });

    const finish = () => { URL.revokeObjectURL(url); resolve(results); };
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);

    const processFrame = async () => {
      if (video.ended || video.paused) return;
      ctx.drawImage(video, 0, 0);
      const faces = await detectFacesInCanvas(canvas, matcher);
      faces.forEach(f => { results[f.label] = (results[f.label] || 0) + 1; });
      frameCount++;
      const next = frameCount * INTERVAL;
      if (next >= video.duration) { finish(); return; }
      video.currentTime = next;
    };
    video.addEventListener('seeked', processFrame);
    video.addEventListener('canplay', () => { video.currentTime = 0; });
    video.load();
  });
}

// ─────────────────────────────────────────────────────────────
// 11. TRANSCRIPTION  (unchanged from v5)
// ─────────────────────────────────────────────────────────────
async function transcribeAudio(audioFile) {
  const pasted = $('transcriptText')?.value?.trim();
  if (pasted) {
    log('Using pasted transcript (' + pasted.split(/\s+/).length + ' words)', 'success');
    return pasted;
  }
  const name = (audioFile?.name || '').toLowerCase();
  if (audioFile && (name.endsWith('.txt') || name.endsWith('.srt') || name.endsWith('.vtt'))) {
    try {
      const text = await audioFile.text();
      // If it's an SRT, parse and store the timed entries before stripping
      if (name.endsWith('.srt') || name.endsWith('.vtt')) {
        STATE._srtEntries = parseSRT(text);
        log('SRT parsed — ' + STATE._srtEntries.length + ' timed entries stored ✓', 'success');
      }
      const clean = text
        .replace(/\d+\r?\n/gm, '')
        .replace(/[\d:,]+ --> [\d:,.]+/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/WEBVTT.*\n/g, '')
        .replace(/\n{2,}/g, ' ')
        .trim();
      log('Read transcript from file (' + clean.split(/\s+/).length + ' words)', 'success');
      return clean;
    } catch (e) {
      log('Could not read transcript file: ' + e.message, 'error');
    }
  }
  if (audioFile && (name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a') || name.endsWith('.ogg') || name.endsWith('.aac'))) {
    log('Audio file detected (' + audioFile.name + ') — will be encoded into video. Paste transcript text in the Voiceover box for script matching.', 'info');
    return '';
  }
  log('No transcript provided — paste one in the Voiceover box for better matching', 'info');
  return '';
}

// ─────────────────────────────────────────────────────────────
// 11b. SRT PARSER — extract word timings for exact clip durations
// ─────────────────────────────────────────────────────────────
/**
 * Parse an SRT file into an array of { start, end, text } objects (times in seconds).
 */
function parseSRT(srtText) {
  const entries = [];
  const blocks = srtText.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    const m = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const toSec = (h, min, s, ms) => +h * 3600 + +min * 60 + +s + +ms / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end   = toSec(m[5], m[6], m[7], m[8]);
    const text  = lines.slice(2).join(' ').replace(/<[^>]+>/g, '').trim();
    entries.push({ start, end, text });
  }
  return entries;
}

/**
 * Given SRT entries and a list of script lines (from splitParagraphs),
 * compute the [start, end] time range (seconds) that each script line occupies
 * in the voiceover audio.  This drives exact clip duration in the rendered video.
 *
 * Strategy v2 — fuzzy sliding-window alignment:
 *   1. Build a word-level timeline from SRT (each word gets interpolated start/end).
 *   2. For each script line, collect its meaningful tokens (stop-words removed).
 *   3. Slide a window over the word timeline looking for the best-scoring alignment
 *      (how many unique line tokens appear within the window).
 *   4. Within the best window, find the exact first/last matching token to tighten
 *      the start/end time, then add small breathing room padding.
 *   5. Advance the search cursor past the matched window so lines always go forward.
 */
function computeLineTimes(scriptLines, srtEntries) {
  if (!srtEntries || !srtEntries.length) return null;

  // ── Build flat word-level timeline ──────────────────────────
  const wordTimeline = []; // { word, start, end }
  for (const entry of srtEntries) {
    const words = entry.text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const dur   = (entry.end - entry.start) / Math.max(words.length, 1);
    words.forEach((w, i) => wordTimeline.push({
      word:  w,
      start: entry.start + i * dur,
      end:   entry.start + (i + 1) * dur
    }));
  }

  // Stop-words excluded from matching
  const STOP = new Set(['a','an','the','and','or','but','in','on','at','to','for',
    'of','with','by','from','is','are','was','were','be','been','being',
    'this','that','these','those','it','its','i','you','he','she','we','they',
    'do','does','did','will','would','can','could','should','may','might',
    'have','has','had','not','no','so','as','if','up','out','about','into',
    'just','also','all','who','what','when','where','why','how','there','here',
    'now','then','more','most','some','any','one','two','three','very','well']);

  function lineTokens(line) {
    return line.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
  }

  let searchStart = 0;
  const result = [];

  for (const line of scriptLines) {
    const tokens = lineTokens(line);
    if (!tokens.length) { result.push(null); continue; }

    const tokenSet   = new Set(tokens);
    // Window = 3× the unique token count, minimum 25 words, to give enough room
    const windowSize = Math.max(tokenSet.size * 3, 25);
    // Lookahead cap: don't scan too far past the cursor (avoids false-forward jumps)
    const searchEnd  = Math.min(searchStart + Math.max(windowSize * 8, 300), wordTimeline.length);

    let bestScore  = -1;
    let bestWStart = searchStart;

    for (let w = searchStart; w + tokens.length <= searchEnd; w++) {
      // Count unique tokens matched in this window
      let hits = 0;
      const seen = new Set();
      const limit = Math.min(w + windowSize, wordTimeline.length);
      for (let j = w; j < limit; j++) {
        const wd = wordTimeline[j].word;
        if (tokenSet.has(wd) && !seen.has(wd)) { hits++; seen.add(wd); }
      }
      if (hits > bestScore) {
        bestScore  = hits;
        bestWStart = w;
        // Early exit if ≥85 % of unique tokens are matched
        if (hits >= Math.ceil(tokenSet.size * 0.85)) break;
      }
    }

    if (bestScore <= 0) { result.push(null); continue; }

    // ── Precise bounds: first/last token match inside the best window ──
    let firstIdx = -1, lastIdx = -1;
    const winLimit = Math.min(bestWStart + windowSize, wordTimeline.length);
    for (let j = bestWStart; j < winLimit; j++) {
      if (tokenSet.has(wordTimeline[j].word)) {
        if (firstIdx === -1) firstIdx = j;
        lastIdx = j;
      }
    }
    if (firstIdx === -1) { result.push(null); continue; }

    // Small padding: -60 ms lead-in, +100 ms tail for clean clip cuts
    result.push({
      start: Math.max(0, wordTimeline[firstIdx].start - 0.06),
      end:   wordTimeline[lastIdx].end + 0.10
    });

    log('SRT match: "' + line.substring(0, 40) + '…" → '
        + wordTimeline[firstIdx].start.toFixed(2) + 's – '
        + wordTimeline[lastIdx].end.toFixed(2) + 's  (score ' + bestScore + '/' + tokenSet.size + ')', 'info');

    // Advance cursor to just past the matched region
    searchStart = lastIdx + 1;
  }

  return result;
}

/** STATE holder for SRT data */
STATE._srtEntries = null;
function tokenize(text) {
  const STOP = new Set(['a','an','the','and','or','but','in','on','at','to','for',
    'of','with','by','from','is','are','was','were','be','been','being',
    'this','that','these','those','it','its','i','you','he','she','we','they',
    'do','does','did','will','would','can','could','should','may','might',
    'have','has','had','not','no','so','as','if','up','out','about','into']);
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
             .split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
}

/**
 * SENTENCE-BASED splitting: always split on sentence boundaries first,
 * then merge orphan sentences (too short, no character name) into the next one.
 * This means each sentence gets its own clip assignment — character names
 * mentioned mid-paragraph correctly trigger their clip on that exact sentence.
 */
function splitParagraphs(text) {
  // Step 1: flatten newlines into spaces so paragraph breaks don't interfere
  const flat = text.replace(/\r?\n/g, ' ').replace(/\s{2,}/g, ' ').trim();

  // Step 2: split on sentence boundaries (. ! ?) followed by whitespace
  let chunks = flat.replace(/([.!?]+)\s+/g, '$1\n').split('\n').map(s => s.trim()).filter(Boolean);

  // Step 3: merge orphan sentences — fewer than 6 words AND no registered
  // character name/alias detected → append to the next sentence so we don't
  // waste a clip slot on "And the reason is simple."
  const allNames = STATE.characters.map(c => c.name.toLowerCase());
  const MIN_WORDS = 6;
  const merged = [];
  let carry = '';
  for (const chunk of chunks) {
    const candidate = (carry ? carry + ' ' : '') + chunk;
    const wordCount = candidate.trim().split(/\s+/).length;
    const hasName   = allNames.some(n => candidate.toLowerCase().includes(n));
    // Keep carrying if too short AND no character hit — unless it's the last chunk
    if (wordCount < MIN_WORDS && !hasName) {
      carry = candidate;
    } else {
      merged.push(candidate);
      carry = '';
    }
  }
  if (carry) merged.push(carry); // flush any remaining carry
  return merged;
}

/**
 * CHARACTER ALIAS / NICKNAME MAP  v2
 * Builds a reverse lookup: alias → canonical character name.
 *
 * Sources (in priority order):
 *   1. STATE.characters[*].role field — "nickname: Drizzy, Drake" or "aka: 6 God"
 *   2. Automatic first-name and last-name short forms
 *   3. Initials (e.g. "K.L." → "Kendrick Lamar")
 *   4. Hardcoded domain-specific well-known aliases (hip-hop, music industry, legal)
 *      that are always active regardless of which characters are registered.
 *
 * The returned map is  aliasUPPER → canonicalCharacterName (string, not uppercased).
 */
function buildAliasMap() {
  const map = {}; // alias.toUpperCase() → canonicalName

  // ── Well-known domain aliases (hip-hop / music-industry / legal) ──────────
  // These fire even when the character hasn't been explicitly registered,
  // as long as a clip is tagged with one of their canonical names.
  const DOMAIN_ALIASES = {
    // Drake
    'DRAKE':          'Drake',
    'DRIZZY':         'Drake',
    '6 GOD':          'Drake',
    'AUBREY':         'Drake',
    'AUBREY GRAHAM':  'Drake',
    'OVO':            'Drake',
    'THE PLAINTIFF':  'Drake',

    // Kendrick Lamar
    'KENDRICK':       'Kendrick Lamar',
    'KENDRICK LAMAR': 'Kendrick Lamar',
    'K DOT':          'Kendrick Lamar',
    'KUNG FU KENNY':  'Kendrick Lamar',
    'PGLAN':          'Kendrick Lamar',
    'TDE':            'Kendrick Lamar',
    'THE WITNESS':    'Kendrick Lamar',

    // Universal Music Group
    'UMG':                    'UMG',
    'UNIVERSAL':              'UMG',
    'UNIVERSAL MUSIC':        'UMG',
    'UNIVERSAL MUSIC GROUP':  'UMG',
    'THE LABEL':              'UMG',
    'THE CORPORATION':        'UMG',
    'THE COMPANY':            'UMG',
    'THE DEFENDANT':          'UMG',
    'THE ENTITY':             'UMG',

    // Yale Law
    'YALE':       'Yale Law',
    'MFIA':       'Yale Law',
    'MFIA CLINIC':'Yale Law',
    'YALE LAW':   'Yale Law',
  };

  // First, seed the map with domain aliases — but only if there's a clip
  // tagged with that canonical name (resolved later in matchScriptToClips).
  Object.entries(DOMAIN_ALIASES).forEach(([alias, canon]) => {
    map[alias] = canon;
  });

  // ── Per-character entries from STATE.characters ───────────────────────────
  STATE.characters.forEach(c => {
    const nameUp = c.name.toUpperCase();

    // The character's own name always resolves to itself
    map[nameUp] = c.name;

    // Parse "nickname: X, Y" / "aka: X, Y" / "alias: X, Y" from role field
    const roleText = c.role || '';
    const nickMatch = roleText.match(/(?:nickname|aka|alias)[:\s]+(.+)/i);
    if (nickMatch) {
      nickMatch[1].split(',').map(n => n.trim()).filter(Boolean).forEach(alias => {
        map[alias.toUpperCase()] = c.name;
      });
    }

    // Auto first-name and last-name short forms
    const parts = c.name.trim().split(/\s+/);
    if (parts.length >= 2) {
      map[parts[0].toUpperCase()]                       = c.name; // first name
      map[parts[parts.length - 1].toUpperCase()]        = c.name; // last name
      // Initials: "Kendrick Lamar" → "KL"
      const initials = parts.map(p => p[0]).join('').toUpperCase();
      if (initials.length >= 2) map[initials] = c.name;
    }

    // If domain alias points to a name that matches this character, upgrade it
    Object.entries(DOMAIN_ALIASES).forEach(([alias, canon]) => {
      if (canon.toUpperCase() === nameUp || c.name.toUpperCase().startsWith(canon.toUpperCase())) {
        map[alias] = c.name; // prefer the exact registered name
      }
    });
  });

  return map;
}

/**
 * CONTEXT-AWARE pronoun / descriptor resolution  v2
 * Returns the last-mentioned character name for lines that don't have an
 * explicit name but clearly refer to someone via pronoun or descriptor.
 *
 * Extended for hip-hop / music-industry / legal content.
 */
const CONTEXT_DESCRIPTORS = [
  // Legal roles
  'the artist', 'the plaintiff', 'the defendant', 'the appellee', 'the appellant',
  'his attorneys', 'his lawyers', 'his legal team', 'his counsel',
  'their attorneys', 'their lawyers', 'their legal team', 'their counsel',
  // Corporate roles
  'the label', 'the corporation', 'the company', 'the entity',
  'the label\'s', 'the corporate', 'the executives', 'the board',
  // Hip-hop / artist descriptors
  'the rapper', 'the superstar', 'the artist', 'the mc', 'the emcee',
  'the recording artist', 'the performer', 'the icon', 'the legend',
  'the winner', 'the victor', 'the challenger',
  'his team', 'their team', 'his camp', 'their camp',
  'his music', 'their music', 'his track', 'their track',
  'his song', 'their song', 'his album', 'their album',
  'his career', 'their career', 'his brand', 'their brand',
  'his legacy', 'their legacy', 'his image', 'their image',
  // Specific to this content
  'his appeal', 'the appeal', 'their filing', 'the filing',
  'his reputation', 'his livelihood', 'his streaming', 'his tours',
  'the streaming', 'the damages', 'the billboard', 'the plaque',
];

function resolveContextCharacter(line, lastChar) {
  if (!lastChar) return null;
  const lower = line.toLowerCase();
  for (const desc of CONTEXT_DESCRIPTORS) {
    if (lower.includes(desc)) return lastChar;
  }
  // Generic masculine pronouns — conservative to avoid false matches
  if (/\b(he|his|him|they|their|them)\b/.test(lower) && !/\b(she|her)\b/.test(lower)) {
    return lastChar;
  }
  return null;
}

function matchScriptToClips(scriptText, clipNames, transcript) {
  log('Matching script to clips — line-by-line v2 (repeats allowed, multi-char lines, alias+context)…', 'info');

  const sourceText = scriptText || transcript || '';
  const lines = splitParagraphs(sourceText);
  log('Script split into ' + lines.length + ' line(s) for matching', 'info');
  if (!lines.length || !clipNames.length) return [];

  // ── Build charToClips: canonical charKey → [clipFilenames] ──────────────
  // Clips can appear in multiple character buckets (multi-tagged clips).
  // A clip can be reused multiple times in the output — no dedup at this stage.
  const charToClips = {};
  clipNames.forEach(clipFile => {
    (STATE.clipTagMap[clipFile] || []).forEach(tag => {
      const key = tag.trim().toUpperCase();
      if (!key) return;
      if (!charToClips[key]) charToClips[key] = [];
      charToClips[key].push(clipFile);
    });
  });

  // ── Build alias map ──────────────────────────────────────────────────────
  const aliasMap = buildAliasMap();

  // Final lookup: searchTermUPPER → canonicalCharKey (in charToClips)
  const termToChar = {};
  Object.keys(charToClips).forEach(k => { termToChar[k] = k; });
  Object.entries(aliasMap).forEach(([aliasUp, canonName]) => {
    const canonUp = canonName.toUpperCase();
    if (charToClips[canonUp]) {
      termToChar[aliasUp] = canonUp;
    } else {
      // Partial match: tag starts with / contains canonical name or vice versa
      const match = Object.keys(charToClips).find(k =>
        k.startsWith(canonUp) || canonUp.startsWith(k) ||
        k.includes(canonUp)   || canonUp.includes(k)
      );
      if (match) termToChar[aliasUp] = match;
    }
  });

  // Sort terms longest-first so "KENDRICK LAMAR" always beats "KENDRICK"
  const searchTerms = Object.keys(termToChar).sort((a, b) => b.length - a.length);

  // ── Per-character round-robin clip queues ────────────────────────────────
  // Clips are rotated round-robin within each character's pool so every mention
  // of a character gets a clip, cycling back if necessary.
  const charQueues  = {}; // charKey → circular array index
  const charClipArr = {}; // charKey → [clipFilenames]
  Object.entries(charToClips).forEach(([k, arr]) => {
    charClipArr[k] = [...arr];
    charQueues[k]  = 0;
  });

  function nextClipForChar(charKey) {
    const arr = charClipArr[charKey];
    if (!arr || !arr.length) return null;
    const clip = arr[charQueues[charKey] % arr.length];
    charQueues[charKey]++;
    return clip;
  }

  let lastMatchedChar = null; // context tracker

  const results = [];

  lines.forEach(line => {
    let matchedCharKey = null;
    let matchedClip    = null;
    let matchReason    = '';

    // ── 1. Scan for explicit name / alias — longest match wins ──────────────
    for (const term of searchTerms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
      // Word-boundary aware: don't match inside a longer word
      const re = new RegExp('(?<![A-Za-z])' + escaped + '(?![A-Za-z])', 'i');
      if (re.test(line)) {
        matchedCharKey = termToChar[term];
        matchReason    = 'name/alias: ' + term;
        // Update context even on a name hit
        const canonName = aliasMap[term] || aliasMap[matchedCharKey] || matchedCharKey;
        lastMatchedChar = canonName;
        break;
      }
    }

    // ── 2. Context / pronoun resolution if no explicit name ─────────────────
    if (!matchedCharKey) {
      const ctxChar = resolveContextCharacter(line, lastMatchedChar);
      if (ctxChar) {
        const ctxUp = ctxChar.toUpperCase();
        if (charToClips[ctxUp]) {
          matchedCharKey = ctxUp;
          matchReason    = 'context-ref → ' + ctxChar;
        } else {
          const match = Object.keys(charToClips).find(k =>
            k.startsWith(ctxUp) || ctxUp.startsWith(k) || k.includes(ctxUp)
          );
          if (match) { matchedCharKey = match; matchReason = 'context-ref → ' + ctxChar; }
        }
      }
    }

    // ── 3. Resolve charKey → clip (round-robin, allowing repeats) ───────────
    if (matchedCharKey) {
      matchedClip = nextClipForChar(matchedCharKey);
    }

    // ── 4. Smart fallback: continue talking about whoever was last mentioned ──
    // Most lines in a back-and-forth script don't restate the name or use a
    // pronoun every sentence — they're still about the same person. Default
    // to continuing that person's clip queue instead of picking someone random.
    if (!matchedClip && lastMatchedChar) {
      const lcUp = lastMatchedChar.toUpperCase();
      const contKey = charToClips[lcUp]
        ? lcUp
        : Object.keys(charToClips).find(k => k.startsWith(lcUp) || lcUp.startsWith(k) || k.includes(lcUp));
      if (contKey) {
        matchedClip    = nextClipForChar(contKey);
        matchedCharKey = contKey;
        matchReason    = 'context-continue → ' + lastMatchedChar;
      }
    }

    // ── 5. True last resort: no character context exists yet at all ──────────
    if (!matchedClip) {
      const lastUsed = results.length ? results[results.length - 1].clip : null;
      const candidates = clipNames.filter(c => c !== lastUsed);
      const pool = candidates.length ? candidates : clipNames;
      matchedClip = pool[Math.floor(Math.random() * pool.length)];
      matchReason = 'fallback (random, no char match)';
    }

    results.push({ paragraph: line, clip: matchedClip, reason: matchReason });
  });

  log('Line-by-line matching complete — ' + results.length + ' lines → clips ✓', 'success');

  // ── 6. Variety-break pass (4:1 rule) ────────────────────────────────────
  // If the same character appears 5+ consecutive times, inject one clip from
  // a different character at every 4th position to break the monotony.
  const VARIETY_RUN_THRESHOLD = 5; // trigger after this many consecutive same-char clips
  const VARIETY_RATIO         = 4; // insert 1 variety clip every N clips in a long run

  // Build a pool of "other" clips for each charKey → round-robin across other chars
  const varietyQueues = {}; // charKey → { clips: [], idx: 0 }
  Object.keys(charClipArr).forEach(key => {
    const others = Object.entries(charClipArr)
      .filter(([k]) => k !== key)
      .flatMap(([, arr]) => arr);
    varietyQueues[key] = { clips: others, idx: 0 };
  });

  function nextVarietyClip(charKey) {
    const q = varietyQueues[charKey];
    if (!q || !q.clips.length) return null;
    const clip = q.clips[q.idx % q.clips.length];
    q.idx++;
    return clip;
  }

  const final = [];
  let runChar    = null;
  let runCount   = 0;  // clips since the run started
  let sinceBreak = 0;  // clips since the last variety break — this is what drives the 4:1 ratio

  for (const entry of results) {
    // Detect the character driving this slot.
    // reason formats: "name/alias: DRAKE", "context-ref → Drake",
    // "context-continue → Drake", "fallback ..."
    // Always normalize to the SAME canonical key shape (uppercase, resolved
    // through termToChar) so the same person never looks like two different
    // "characters" purely due to casing/spacing differences between the
    // name/alias path and the context-ref/context-continue paths.
    let thisChar;
    if (entry.reason.startsWith('fallback')) {
      thisChar = '__fallback__';
    } else if (entry.reason.startsWith('name/alias:')) {
      const term = entry.reason.replace('name/alias:', '').trim().toUpperCase();
      thisChar = (termToChar[term] || term).toUpperCase();
    } else if (entry.reason.includes('→')) {
      const raw = entry.reason.split('→')[1].trim().toUpperCase();
      thisChar = (termToChar[raw] || raw).toUpperCase();
    } else {
      thisChar = entry.clip;
    }

    if (thisChar === runChar) {
      runCount++;
    } else {
      runChar  = thisChar;
      runCount = 1;
    }
    sinceBreak++;

    final.push(entry);

    // Trigger once the run is long enough AND it's been exactly VARIETY_RATIO
    // clips since the LAST break (not since the run started).
    if (runCount >= VARIETY_RUN_THRESHOLD && sinceBreak >= VARIETY_RATIO) {
      const varietyClip = nextVarietyClip(runChar);
      if (varietyClip) {
        final.push({ paragraph: '[variety break]', clip: varietyClip, reason: 'variety-break (4:1 rule)' });
        log('Variety break injected after ' + VARIETY_RATIO + ' consecutive "' + runChar + '" clips (run total so far: ' + runCount + ') → ' + varietyClip, 'info');
        sinceBreak = 0; // reset — ratio resets relative to the last break, not the run start
      }
    }
  }

  log('Variety-break pass complete — final sequence: ' + final.length + ' clips ✓', 'success');

  // ── 7. No-consecutive-repeat pass ───────────────────────────────────────
  // If the same clip file appears back-to-back, keep rotating the character's
  // queue until a genuinely different clip is found (up to queue length attempts).
  const deduped = [];
  let lastClip = null;
  for (const entry of final) {
    if (entry.clip === lastClip && !entry.reason.startsWith('variety')) {
      const charKey = entry.reason.startsWith('name/alias:')
        ? (termToChar[entry.reason.replace('name/alias:', '').trim().toUpperCase()] || null)
        : entry.reason.includes('→')
          ? (termToChar[entry.reason.split('→')[1].trim().toUpperCase()] || entry.reason.split('→')[1].trim().toUpperCase())
          : null;

      let alt = null;
      if (charKey && charClipArr[charKey]) {
        const pool = charClipArr[charKey];
        // Try every clip in the pool to find one that differs from lastClip
        for (let attempt = 0; attempt < pool.length; attempt++) {
          const candidate = nextClipForChar(charKey);
          if (candidate && candidate !== lastClip) { alt = candidate; break; }
        }
      }

      if (alt) {
        deduped.push({ ...entry, clip: alt, reason: entry.reason + ' [rotated]' });
        lastClip = alt;
      } else {
        // All clips for this character are the same file — keep it
        deduped.push(entry);
        lastClip = entry.clip;
      }
    } else {
      deduped.push(entry);
      lastClip = entry.clip;
    }
  }
  log('No-repeat pass complete — ' + deduped.length + ' clips in final sequence ✓', 'success');
  return deduped;
}

// ═════════════════════════════════════════════════════════════
// 13. ★★★  NEW FAST RENDERER — FFmpeg.wasm  ★★★
// ═════════════════════════════════════════════════════════════
//
// Performance characteristics vs old MediaRecorder play-through:
//   • Fast path (stream-copy concat, same codec H.264 MP4s):
//       ~100× faster than v5. Limited only by disk I/O.
//   • Normal path (re-encode + concat):
//       ~5-15× faster than v5. WASM uses SIMD + threads.
//
// We load the @ffmpeg/ffmpeg package from a CDN lazily so the
// initial page load stays light (~30 MB only on first render).
// ─────────────────────────────────────────────────────────────

const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js';
const FFMPEG_UTIL_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/umd/index.js';
// IMPORTANT: must be the ESM core builds, not /dist/umd.
// classWorkerURL (below) makes FFmpeg.wasm spawn its worker with {type:"module"}.
// Inside that worker, `importScripts(coreURL)` always throws in a module worker,
// so it falls back to `await import(coreURL)` and expects `export default
// createFFmpegCore`. Only the /dist/esm builds export that; /dist/umd builds
// don't, which is what produced the previous "...: undefined" error (the
// worker rejected with the string "Error: failed to import ffmpeg-core.js").
const FFMPEG_CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm';
// The @ffmpeg/ffmpeg UMD bundle spawns its own "class worker" (the 814.ffmpeg.js
// chunk) with `new Worker(url)`. Classic Workers must be same-origin, so when
// ffmpeg.js itself is loaded from a CDN, that worker URL points at jsdelivr and
// the browser throws "Failed to construct 'Worker': ... cannot be accessed from
// origin ...". Fix: pull that chunk down ourselves and hand FFmpeg a same-origin
// blob: URL for it via the classWorkerURL load() option.
const FFMPEG_CLASS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js';

// FFmpeg.wasm's worker posts back plain strings (not Error objects) on
// failure, so `err.message` is `undefined` for those. Normalize so logs are
// always readable instead of "...: undefined".
function errMsg(e) {
  if (!e) return String(e);
  if (typeof e === 'string') return e;
  return e.message || e.toString?.() || String(e);
}

function loadScriptOnce(src) {
  return new Promise((res, rej) => {
    if ([...document.scripts].some(s => s.src === src)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function ensureFFmpeg() {
  if (STATE.ffmpegReady) return STATE.ffmpeg;
  log('Loading FFmpeg.wasm engine (one-time, ~30 MB)…', 'info');
  setProgress(60, 'Loading FFmpeg engine…');

  await loadScriptOnce(FFMPEG_CDN);
  await loadScriptOnce(FFMPEG_UTIL_CDN);

  const { FFmpeg } = window.FFmpegWASM;
  const { toBlobURL, fetchFile } = window.FFmpegUtil;
  window._ffFetchFile = fetchFile;

  // Pre-fetch the class worker chunk once and reuse it for whichever
  // load() path below ends up running (multi-thread or single-thread).
  const classWorkerURL = await toBlobURL(FFMPEG_CLASS_WORKER_CDN, 'text/javascript');

  const ff = new FFmpeg();
  ff.on('log', ({ message }) => {
    // While a probe is running, STATE._probeCapture is an array — collect
    // every line so probeClip() can parse resolution/fps/codec out of it.
    if (Array.isArray(STATE._probeCapture)) STATE._probeCapture.push(message);
    // FFmpeg is chatty — only surface obvious errors
    if (/error|invalid|failed/i.test(message)) console.warn('[ffmpeg]', message);
  });
  ff.on('progress', ({ progress }) => {
    if (progress > 0 && progress <= 1) {
      const overall = 70 + progress * 25;
      setProgress(overall, 'Encoding video — ' + Math.round(progress * 100) + '%');
    }
  });

  // Multi-threaded core (needs cross-origin isolation; falls back to single-thread automatically)
  try {
    await ff.load({
      coreURL:   await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`,    'text/javascript'),
      wasmURL:   await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,  'application/wasm'),
      workerURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.worker.js`, 'text/javascript'),
      classWorkerURL
    });
    log('FFmpeg.wasm loaded (multi-thread) ✓', 'success');
  } catch (e) {
    log('Multi-thread core failed — falling back to single-thread: ' + errMsg(e), 'info');
    const SINGLE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
    await ff.load({
      coreURL: await toBlobURL(`${SINGLE}/ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${SINGLE}/ffmpeg-core.wasm`, 'application/wasm'),
      classWorkerURL
    });
    log('FFmpeg.wasm loaded (single-thread) ✓', 'success');
  }

  STATE.ffmpeg = ff;
  STATE.ffmpegReady = true;
  return ff;
}

/** Quick sniff: is the file already an MP4/H.264 that we can stream-copy? */
function isLikelyMp4(file) {
  const n = (file.name || '').toLowerCase();
  return n.endsWith('.mp4') || n.endsWith('.m4v') || file.type === 'video/mp4';
}

function audioExt(file) {
  const n = (file.name || '').toLowerCase();
  if (n.endsWith('.mp3')) return 'mp3';
  if (n.endsWith('.wav')) return 'wav';
  if (n.endsWith('.m4a')) return 'm4a';
  if (n.endsWith('.aac')) return 'aac';
  if (n.endsWith('.ogg')) return 'ogg';
  return 'mp3';
}

// ── Real compatibility probing ──────────────────────────────────
// isLikelyMp4() only looks at the filename — useless for deciding whether
// stream-copy concat is SAFE. These two functions ask ffmpeg what's
// actually inside each file (codec, resolution, fps, audio sample rate) so
// we only take the fast path when clips are byte-for-byte compatible.
function parseStreamInfo(logText) {
  let video = null, audio = null;
  for (const line of logText.split('\n')) {
    if (!video && /Video:/.test(line)) {
      const codecM = line.match(/Video:\s*([a-zA-Z0-9_]+)/);
      const resM   = line.match(/(\d{2,5})x(\d{2,5})/);
      const fpsM   = line.match(/([\d.]+)\s*fps/);
      if (codecM && resM) {
        video = {
          codec: codecM[1],
          width: parseInt(resM[1], 10),
          height: parseInt(resM[2], 10),
          fps: fpsM ? parseFloat(fpsM[1]) : null
        };
      }
    }
    if (!audio && /Audio:/.test(line)) {
      const codecM = line.match(/Audio:\s*([a-zA-Z0-9_]+)/);
      const hzM    = line.match(/(\d{3,6})\s*Hz/);
      if (codecM) audio = { codec: codecM[1], sampleRate: hzM ? parseInt(hzM[1], 10) : null };
    }
  }
  return { video, audio };
}

/** Probe one already-written VFS file's stream params. Never throws. */
async function probeClip(ff, vname) {
  STATE._probeCapture = [];
  try { await ff.exec(['-i', vname]); } catch (_) { /* expected — no output given, info is in the log */ }
  const text = STATE._probeCapture.join('\n');
  STATE._probeCapture = null;
  const info = parseStreamInfo(text);
  return info.video ? info : null;
}

/** True only if every clip is genuinely identical: codec, resolution, fps, audio. */
function clipsAreStreamCompatible(probes) {
  const list = probes.filter(Boolean);
  if (!list.length || list.length !== probes.length) return false; // any unparsed clip = play it safe
  const ref = list[0];
  return list.every(p =>
    p.video && ref.video &&
    p.video.codec === ref.video.codec &&
    p.video.width === ref.video.width &&
    p.video.height === ref.video.height &&
    (p.video.fps == null || ref.video.fps == null || Math.abs(p.video.fps - ref.video.fps) < 0.05) &&
    (p.audio?.codec || null) === (ref.audio?.codec || null) &&
    (p.audio?.sampleRate || null) === (ref.audio?.sampleRate || null)
  );
}

/**
 * Main FFmpeg renderer.
 *   videoFiles : File[]          (in playback order)
 *   audioFile  : File|null       (optional voiceover)
 *   settings   : { width, height, fps, bitrate } — optional
 *   lineTimes  : [{start,end}|null][] — SRT-derived durations per clip (optional)
 * Returns: Blob (.mp4)
 */
async function renderVideo(videoFiles, audioFile, settings = null, lineTimes = null) {
  if (!videoFiles.length) throw new Error('No clips to render');

  const ff = await ensureFFmpeg();
  const fetchFile = window._ffFetchFile;

  const W   = settings?.width   || 1280;
  const H   = settings?.height  || 720;
  const FPS = settings?.fps     || 30;
  const BR  = settings?.bitrate || 3_000_000;

  // ── Write every playlist slot as a uniquely-named VFS file ───────────────
  // Even if the same source file appears 10 times, each gets its own name
  // (in_000.mp4, in_001.mp4 …) so the concat demuxer never sees duplicate
  // entries — that was the root cause of the stream-copy timebase freeze.
  // We cache the ArrayBuffer of each source file so we only fetch() it once
  // from the browser even if it's used multiple times in the playlist.
  setProgress(63, 'Loading clips into FFmpeg…');
  const writtenNames = [];
  const uniqueFiles  = [];
  const probeCache   = new Map(); // "name:size" -> probe result (probe each unique source once)

  for (let i = 0; i < videoFiles.length; i++) {
    const f     = videoFiles[i];
    const ext   = (f.name.split('.').pop() || 'mp4').toLowerCase();
    const vname = `in_${String(i).padStart(3, '0')}.${ext}`;
    // fetchFile must be called fresh every time — passing the same ArrayBuffer
    // twice detaches it after the first writeFile (FFmpeg.wasm transfers ownership).
    // Passing the File object directly lets fetchFile re-read it each call safely.
    await ff.writeFile(vname, await fetchFile(f));
    writtenNames.push(vname);
    uniqueFiles.push(vname);
    const key = f.name + ':' + f.size;
    if (!probeCache.has(key)) probeCache.set(key, { vname }); // fill in probe result below
    setProgress(63 + ((i + 1) / videoFiles.length) * 5, 'Loaded ' + (i + 1) + '/' + videoFiles.length);
  }
  log('VFS: ' + videoFiles.length + ' slots written ✓', 'info');

  // ── Probe REAL stream params (not just file extension) ───────────────
  // Only relevant when settings/trim haven't already forced a re-encode —
  // skip the probe entirely in that case to save time.
  const hasTrimCheck = lineTimes && lineTimes.some(Boolean);
  let fastPath = false;
  if (!settings && !hasTrimCheck) {
    setProgress(67, 'Checking clip compatibility…');
    const entries = [...probeCache.entries()];
    for (const [key, entry] of entries) {
      entry.probe = await probeClip(ff, entry.vname);
    }
    const allProbes = entries.map(([, entry]) => entry.probe);
    fastPath = clipsAreStreamCompatible(allProbes);
    log(fastPath
      ? 'Clip compatibility check: all ' + entries.length + ' unique clip(s) match ✓ — fast path enabled'
      : 'Clip compatibility check: clips differ in codec/resolution/fps/audio — using safe re-encode', 'info');
  }

  const hasTrim = hasTrimCheck;
  log(fastPath
    ? 'Render path: FAST (stream-copy concat, no re-encode)'
    : hasTrim
      ? 'Render path: TIMED (SRT-duration trim + re-encode)'
      : 'Render path: NORMAL (re-encode + concat)', 'info');

  // ── Write voiceover if provided ───────────────────────────
  let audioName = null;
  if (audioFile) {
    audioName = 'voice.' + audioExt(audioFile);
    await ff.writeFile(audioName, await fetchFile(audioFile));
    log('Voiceover loaded into FFmpeg ✓', 'success');
  }

  // ── Build concat list file for the concat demuxer ─────────
  const listContent = writtenNames.map(n => `file '${n}'`).join('\n');
  await ff.writeFile('list.txt', new TextEncoder().encode(listContent));

  // ── Compose ffmpeg command ────────────────────────────────
  const outName = 'out.mp4';
  let cmd;

  if (fastPath) {
    // Concat demuxer + stream copy. Add voiceover by re-muxing audio track only.
    if (audioName) {
      cmd = [
        '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
        '-i', audioName,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart',
        outName
      ];
    } else {
      cmd = [
        '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
        '-c', 'copy', '-movflags', '+faststart',
        outName
      ];
    }
  } else {
    // Re-encode path: use concat demuxer (list.txt already written above) piped
    // through a single scale/pad/fps filter. This keeps the command short regardless
    // of how many clips are in the playlist, and handles repeated filenames correctly.
    const firstTiming = lineTimes && lineTimes[0];
    const audioDelay  = firstTiming ? firstTiming.start : 0;

    cmd = ['-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt'];
    if (audioName) {
      if (audioDelay > 0.01) cmd.push('-ss', audioDelay.toFixed(3));
      cmd.push('-i', audioName);
    }

    const filter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[vout]`;
    cmd.push('-filter_complex', filter, '-map', '[vout]');
    if (audioName) cmd.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
    cmd.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode',
      '-b:v', String(BR), '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outName
    );
  }

  log('Running ffmpeg: ' + cmd.join(' ').substring(0, 160) + '…', 'info');
  setProgress(70, 'Encoding video…');
  const t0 = performance.now();
  try {
    await ff.exec(cmd);
  } catch (e) {
    // Fast-path stream copy can fail when MP4s have mismatched profiles/SPS.
    // Log the real error then auto-retry on the re-encode path.
    log('FFmpeg error: ' + (e?.message || String(e)), 'error');
    if (fastPath) {
      log('Stream-copy failed — retrying with re-encode…', 'info');
      const settingsFallback = settings || { width: W, height: H, fps: FPS, bitrate: BR };
      return await renderVideoReEncodeOnly(ff, writtenNames, audioName, settingsFallback, fetchFile, uniqueFiles);
    }
    throw e;
  }
  const t1 = performance.now();
  log('FFmpeg finished in ' + ((t1 - t0) / 1000).toFixed(1) + 's', 'success');

  setProgress(96, 'Finalising…');
  const data = await ff.readFile(outName);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });

  // Cleanup VFS (best-effort) — delete unique files only, not duplicated refs
  for (const n of uniqueFiles) { try { await ff.deleteFile(n); } catch (_) {} }
  if (audioName)             { try { await ff.deleteFile(audioName); } catch (_) {} }
  try { await ff.deleteFile('list.txt'); } catch (_) {}
  try { await ff.deleteFile(outName);    } catch (_) {}

  log('Render complete — ' + (blob.size / 1024 / 1024).toFixed(1) + ' MB ✓', 'success');
  return blob;
}

/** Internal helper used when fast-path falls back. Files already in VFS. */
async function renderVideoReEncodeOnly(ff, writtenNames, audioName, settings, fetchFile, uniqueFiles) {
  const W   = settings.width;
  const H   = settings.height;
  const FPS = settings.fps;
  const BR  = settings.bitrate;

  // Use concat demuxer (list.txt) + filter_complex on single input — handles
  // repeated clip names safely and keeps the command short regardless of playlist length.
  const listContent = writtenNames.map(n => `file '${n}'`).join('\n');
  await ff.writeFile('list.txt', new TextEncoder().encode(listContent));

  const cmd = ['-y',
    '-f', 'concat', '-safe', '0', '-i', 'list.txt'
  ];
  if (audioName) cmd.push('-i', audioName);

  const filter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[vout]`;
  cmd.push('-filter_complex', filter, '-map', '[vout]');
  if (audioName) cmd.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  cmd.push(
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'fastdecode',
    '-b:v', String(BR), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    'out.mp4'
  );

  log('Running ffmpeg (re-encode, concat-demuxer path)…', 'info');
  await ff.exec(cmd);
  const data = await ff.readFile('out.mp4');
  const blob = new Blob([data.buffer], { type: 'video/mp4' });

  const toDelete = uniqueFiles || [...new Set(writtenNames)];
  for (const n of toDelete) { try { await ff.deleteFile(n); } catch (_) {} }
  if (audioName) { try { await ff.deleteFile(audioName); } catch (_) {} }
  try { await ff.deleteFile('list.txt'); } catch (_) {}
  try { await ff.deleteFile('out.mp4');  } catch (_) {}
  return blob;
}

/** Public wrapper used by the export-page Re-Render button */
async function renderVideoWithSettings(videoFiles, audioFile, settings) {
  return renderVideo(videoFiles, audioFile, settings);
}

// ─────────────────────────────────────────────────────────────
// 14. CHARACTERS PAGE  (unchanged from v5)
// ─────────────────────────────────────────────────────────────
async function loadCharacters() {
  try {
    const rows = await dbSelect('characters');
    STATE.characters = rows.map(r => ({
      id: r.id, name: r.name, role: r.role,
      descriptors: Array.isArray(r.descriptors) ? r.descriptors : [],
      photoUrl: r.photo_url || null
    }));
    log('Loaded ' + STATE.characters.length + ' character(s) from Supabase', 'success');
  } catch (e) {
    log('Characters load failed — using localStorage fallback', 'error');
    STATE.characters = JSON.parse(localStorage.getItem('clipforge_chars') || '[]');
  }
}

function renderCharacters() {
  const grid = $('charactersGrid');
  if ($('statChars')) $('statChars').textContent = STATE.characters.length;
  if (!STATE.characters.length) {
    grid.innerHTML = '<div class="empty-state"><span class="empty-icon">◉</span><p>No characters yet. Add one to enable face detection.</p></div>';
    return;
  }
  grid.innerHTML = STATE.characters.map(c =>
    '<div class="char-card" id="char-' + c.id + '">' +
      '<div class="char-avatar">' + (c.photoUrl ? '<img src="' + c.photoUrl + '" alt="' + c.name + '"/>' : '◉') + '</div>' +
      '<div class="char-name">' + c.name + '</div>' +
      '<div class="char-role">' + (c.role || 'No role set') + '</div>' +
      '<div class="char-faces">' + (c.descriptors?.length || 0) + ' face sample(s)</div>' +
      '<button class="char-delete" onclick="deleteCharacter(\'' + c.id + '\')">✕</button>' +
    '</div>'
  ).join('');
}

async function saveCharacter() {
  const name   = $('charName').value.trim();
  const role   = $('charRole').value.trim();
  const photos = $('charPhotos').files;
  if (!name)          { toast('Character name required', 'error'); return; }
  if (!photos.length) { toast('Upload at least one photo', 'error'); return; }
  $('saveCharText').textContent = 'Processing…'; $('saveCharBtn').disabled = true;
  try {
    await loadFaceApiModels();
    const descriptors = [];
    for (const photo of photos) {
      const url = URL.createObjectURL(photo);
      const img = new Image();
      await new Promise(r => { img.onload = r; img.src = url; });
      const d = await getFaceDescriptor(img);
      URL.revokeObjectURL(url);
      if (d) descriptors.push(Array.from(d));
    }
    if (!descriptors.length) { toast('No faces detected. Use clear frontal photos.', 'error'); return; }

    let photoUrl = null;
    try {
      const ext = photos[0].name.split('.').pop();
      photoUrl = await storageUpload('characters', name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now() + '.' + ext, photos[0]);
    } catch (e) { log('Photo upload skipped: ' + e.message, 'error'); }

    let saved;
    try {
      saved = await dbInsert('characters', { name, role, descriptors, photo_url: photoUrl });
      log('Character "' + name + '" saved to Supabase ✓', 'success');
    } catch (e) {
      log('DB save failed, using localStorage: ' + e.message, 'error');
      saved = { name, role, descriptors, photo_url: photoUrl, id: Date.now().toString() };
      const ls = JSON.parse(localStorage.getItem('clipforge_chars') || '[]');
      ls.push(saved); localStorage.setItem('clipforge_chars', JSON.stringify(ls));
    }

    STATE.characters.push({ id: saved.id, name, role, descriptors, photoUrl });
    renderCharacters();
    toast(name + ' added with ' + descriptors.length + ' face sample(s)', 'success');
    $('charName').value = ''; $('charRole').value = ''; $('charPhotos').value = '';
    $('charPhotoPreviews').innerHTML = ''; $('addCharForm').classList.remove('open');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  finally { $('saveCharText').textContent = 'Save Character'; $('saveCharBtn').disabled = false; }
}

async function deleteCharacter(id) {
  if (!confirm('Delete this character?')) return;
  try { await dbDelete('characters', id); } catch (e) { log('DB delete failed: ' + e.message, 'error'); }
  STATE.characters = STATE.characters.filter(c => c.id !== id);
  const ls = JSON.parse(localStorage.getItem('clipforge_chars') || '[]').filter(c => c.id !== id);
  localStorage.setItem('clipforge_chars', JSON.stringify(ls));
  $('char-' + id)?.remove(); renderCharacters();
  toast('Character removed', 'info');
}

// ─────────────────────────────────────────────────────────────
// 15. VIDEO CLIPS — FILE HANDLING + CHARACTER TAGGING UI
//     (unchanged from v5)
// ─────────────────────────────────────────────────────────────
function autoDetectCharFromFilename(filename) {
  const NOISE = new Set(['clip','cut','scene','take','edit','part','v','final',
                         'rough','draft','hd','4k','720p','1080p','web','short',
                         'recut','trim','export','render','m21','vid','video']);
  let base = filename.replace(/\.[^.]+$/, '');
  base = base.replace(/^[A-Z]{1,3}\d*_/i, '');
  base = base.replace(/[\s_\-]*\(\d+\)\s*$/, '');
  base = base.replace(/[\s_\-]+\d+\s*$/, '');
  base = base.replace(/[_\-]+/g, ' ').trim();
  const tokens = base.split(/\s+/)
    .filter(t => t.length > 0 && !NOISE.has(t.toLowerCase()) && !/^\d+$/.test(t));
  if (!tokens.length) return null;
  const candidate = tokens.join(' ').toUpperCase();
  const known = STATE.characters.find(c =>
    c.name.toUpperCase() === candidate ||
    candidate.startsWith(c.name.toUpperCase()) ||
    c.name.toUpperCase().startsWith(candidate)
  );
  return known ? known.name : (candidate.length > 1 ? candidate : null);
}

function setupUploadZone(zoneId, inputId, listId) {
  const zone = $(zoneId), input = $(inputId), list = $(listId);
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (listId) renderFileList(input.files, $(listId), inputId);
    for (const f of input.files) {
      getFileBytes(f).catch(err => log('Warning: could not pre-cache "' + f.name + '" — ' + err.message, 'error'));
    }
  });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('dragover');
    const dt = new DataTransfer();
    for (const f of e.dataTransfer.files) dt.items.add(f);
    input.files = dt.files;
    if (listId) renderFileList(input.files, $(listId), inputId);
    for (const f of input.files) {
      getFileBytes(f).catch(err => log('Warning: could not pre-cache "' + f.name + '" — ' + err.message, 'error'));
    }
  });
}

function renderFileList(files, listEl, inputId) {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const div = document.createElement('div');
    div.className = 'file-item';
    div.innerHTML =
      '<span class="fi-name">' + f.name + '</span>' +
      '<span class="fi-size">' + (f.size / 1024 / 1024).toFixed(1) + ' MB</span>' +
      '<button class="fi-remove" data-idx="' + i + '" data-input="' + inputId + '">✕</button>';
    listEl.appendChild(div);
  }
  listEl.querySelectorAll('.fi-remove').forEach(btn =>
    btn.addEventListener('click', () => removeFile(btn.dataset.input, +btn.dataset.idx))
  );
}

function removeFile(inputId, idx) {
  if (inputId === 'videoFiles') {
    if (STATE._videoFileStore && idx >= 0 && idx < STATE._videoFileStore.length) {
      STATE._videoFileStore.splice(idx, 1);
      renderClipRows(STATE._videoFileStore);
    }
    return;
  }
  const input = $(inputId);
  const dt = new DataTransfer();
  for (let i = 0; i < input.files.length; i++) if (i !== idx) dt.items.add(input.files[i]);
  input.files = dt.files;
  const listMap = { scriptFile: 'scriptFileList', audioFile: 'audioFileList' };
  if (listMap[inputId]) renderFileList(input.files, $(listMap[inputId]), inputId);
}

function renderClipRows(files) {
  const store = STATE._videoFileStore;
  files = Array.isArray(store) ? store : (files || []);
  const container = $('clipRows');
  if (!container) return;

  const badge = $('clipCountBadge');
  if (badge) badge.textContent = files.length + ' clip' + (files.length !== 1 ? 's' : '') + ' loaded';

  const prev = STATE.clipTagMap;
  STATE.clipTagMap = {};

  if (!files || files.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = '';

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let tags = prev[f.name] || [];
    if (!tags.length) {
      const detected = autoDetectCharFromFilename(f.name);
      if (detected) {
        tags = [detected];
        registerCharacterInline(detected);
        log('Auto-detected "' + detected + '" from ' + f.name, 'info');
      }
    }
    STATE.clipTagMap[f.name] = [...tags];

    const row = document.createElement('div');
    row.className = 'clip-row';
    row.dataset.filename = f.name;
    row.innerHTML =
      '<div class="cr-left">' +
        '<span class="cr-idx">' + (i + 1) + '</span>' +
        '<div class="cr-info">' +
          '<span class="cr-name">' + f.name + '</span>' +
          '<span class="cr-auto-badge">' + (tags.length ? '👤 ' + tags.join(', ') : '') + '</span>' +
          '<span class="cr-size">' + (f.size / 1024 / 1024).toFixed(1) + ' MB</span>' +
        '</div>' +
      '</div>' +
      '<div class="cr-right">' +
        '<div class="cr-tags" id="tags-' + i + '">' + renderTagChips(tags, i) + '</div>' +
        '<div class="cr-tag-add">' +
          '<input type="text" class="cr-char-input" id="inp-' + i + '" ' +
            'data-clipidx="' + i + '" data-filename="' + f.name + '" ' +
            'placeholder="Type character name…" autocomplete="off" />' +
          '<button class="cr-add-btn" data-clipidx="' + i + '" data-filename="' + f.name + '">Add</button>' +
        '</div>' +
        '<button class="fi-remove cr-remove" data-clipidx="' + i + '" title="Remove clip">✕</button>' +
      '</div>';
    container.appendChild(row);

    const inp    = row.querySelector('.cr-char-input');
    const addBtn = row.querySelector('.cr-add-btn');

    const doAdd = function () {
      const charName = inp.value.trim();
      if (!charName) return;
      const fname = addBtn.dataset.filename;
      const idx   = +addBtn.dataset.clipidx;
      if (!STATE.clipTagMap[fname]) STATE.clipTagMap[fname] = [];
      if (!STATE.clipTagMap[fname].includes(charName)) {
        STATE.clipTagMap[fname].push(charName);
        registerCharacterInline(charName);
        $('tags-' + idx).innerHTML = renderTagChips(STATE.clipTagMap[fname], idx);
        wireTagRemoves(idx, fname);
      }
      inp.value = '';
      inp.focus();
    };

    addBtn.addEventListener('click', doAdd);
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    wireTagRemoves(i, f.name);
    row.querySelector('.cr-remove').addEventListener('click', function () {
      removeFile('videoFiles', +this.dataset.clipidx);
    });
  }
}

async function registerCharacterInline(name) {
  if (!name) return;
  if (STATE.characters.some(c => c.name.toLowerCase() === name.toLowerCase())) return;
  const charObj = { name, role: '', descriptors: [], photoUrl: null };
  try {
    const saved = await dbInsert('characters', { name, role: '', descriptors: [], photo_url: null });
    charObj.id = saved.id;
    log('Character "' + name + '" registered ✓', 'success');
  } catch (e) {
    charObj.id = Date.now().toString() + '-' + Math.random().toString(36).slice(2);
    const ls = JSON.parse(localStorage.getItem('clipforge_chars') || '[]');
    ls.push(charObj);
    localStorage.setItem('clipforge_chars', JSON.stringify(ls));
    log('Character "' + name + '" saved locally', 'info');
  }
  STATE.characters.push(charObj);
  if (STATE.currentPage === 'characters') renderCharacters();
}

function renderTagChips(tags, clipIdx) {
  if (!tags.length) return '<span class="cr-no-tags">No characters tagged</span>';
  return tags.map((t, ti) =>
    '<span class="tag-chip">' + t +
    '<button class="tag-remove" data-ti="' + ti + '" data-ci="' + clipIdx + '" title="Remove">×</button>' +
    '</span>'
  ).join('');
}

function wireTagRemoves(clipIdx, filename) {
  const container = $('tags-' + clipIdx);
  if (!container) return;
  container.querySelectorAll('.tag-remove').forEach(btn => {
    btn.addEventListener('click', function () {
      const ti = +this.dataset.ti;
      STATE.clipTagMap[filename].splice(ti, 1);
      $('tags-' + clipIdx).innerHTML = renderTagChips(STATE.clipTagMap[filename], clipIdx);
      wireTagRemoves(clipIdx, filename);
    });
  });
}

function getFiles() {
  return {
    videos:     STATE._videoFileStore || [],
    script:     $('scriptFile').files[0] || null,
    scriptText: $('scriptText').value.trim(),
    audio:      $('audioFile').files[0] || null,
    title:      $('projectTitle').value.trim() || 'Untitled Project'
  };
}

// ─────────────────────────────────────────────────────────────
// 16. MAIN PIPELINE
// ─────────────────────────────────────────────────────────────
async function runPipeline() {
  const files = getFiles();
  if (!files.videos.length) { toast('Upload at least one video clip', 'error'); return; }

  STATE.project.title      = files.title;
  STATE.project.videoFiles = [...files.videos];
  STATE.project.audioFile  = files.audio;

  goToStep(2);
  $('processingBadge').style.display = 'flex';
  setProgress(0, 'Starting pipeline…');
  log('Project: ' + files.title, 'info');
  log(files.videos.length + ' clip(s) · Audio: ' + (files.audio ? files.audio.name : 'None'), '');

  let faceResults = {};

  try {
    // ── A. Decide whether face-api is needed at all ──
    const charsWithDescriptors = STATE.characters.filter(c => c.descriptors?.length > 0);
    const needFaceApi = charsWithDescriptors.length > 0;

    if (needFaceApi) {
      setProgress(5, 'Loading face-detection models…');
      await loadFaceApiModels();
    } else {
      log('No character face samples — skipping face-api (faster)', 'info');
    }

    // ── B. Face detection (parallelised across clips) ──
    setProgress(10, 'Scanning clips…');
    const matcher = needFaceApi ? buildFaceMatcher() : null;

    if (matcher) {
      const scans = files.videos.map((clip, i) =>
        analyseVideoForFaces(clip, matcher).then(r => {
          const tagged = STATE.clipTagMap[clip.name] || [];
          tagged.forEach(n => { r[n] = (r[n] || 0) + 999; });
          faceResults[clip.name] = r;
          setProgress(10 + ((i + 1) / files.videos.length) * 20, 'Scanned ' + clip.name);
        }).catch(e => log('Face scan failed for ' + clip.name + ': ' + e.message, 'error'))
      );
      await Promise.all(scans);
      STATE.project.analysis.faces = faceResults;
      $('faceResults').innerHTML = Object.entries(faceResults).map(([clip, chars]) => {
        const s = Object.keys(chars).length
          ? Object.entries(chars).map(([n, c]) => n + (c >= 999 ? ' (tagged)' : ' (' + c + '×)')).join(', ')
          : 'No known characters detected';
        return '<div><strong>' + clip + '</strong>: ' + s + '</div>';
      }).join('');
      log('Character detection complete ✓', 'success');
    } else {
      files.videos.forEach(f => {
        const tagged = STATE.clipTagMap[f.name] || [];
        if (tagged.length) {
          faceResults[f.name] = {};
          tagged.forEach(n => { faceResults[f.name][n] = 999; });
        }
      });
      STATE.project.analysis.faces = faceResults;
      const hasAny = Object.values(faceResults).some(r => Object.keys(r).length > 0);
      $('faceResults').innerHTML = hasAny
        ? Object.entries(faceResults).map(([clip, chars]) =>
            '<div><strong>' + clip + '</strong>: ' + Object.keys(chars).join(', ') + ' (manually tagged)</div>'
          ).join('')
        : 'No registered characters &amp; no tags set. Add characters or tag clips in Step 1.';
      log('Using manually tagged characters', '');
    }

    // ── C. Script ──
    setProgress(32, 'Reading script…');
    let scriptText = files.scriptText;
    if (!scriptText && files.script) scriptText = await files.script.text();
    STATE.project.scriptText = scriptText;

    // ── D. Transcript ──
    let transcript = '';
    if (files.audio) {
      setProgress(38, 'Reading transcript…');
      try {
        transcript = await transcribeAudio(files.audio);
        STATE.project.analysis.transcript = transcript;
        $('transcriptResults').textContent = transcript
          ? transcript.substring(0, 300) + (transcript.length > 300 ? '…' : '')
          : 'No transcript pasted — paste your voiceover text in the Transcript box in Step 1 for better script matching.';
        log('Transcript — ' + transcript.split(' ').filter(Boolean).length + ' words ✓', 'success');
      } catch (e) {
        log('Transcript read failed: ' + e.message, 'error');
        $('transcriptResults').textContent = 'Failed: ' + e.message;
      }
    } else {
      $('transcriptResults').textContent = 'No audio uploaded — skipped.';
    }

    // ── E. Script matching ──
    if (!scriptText && transcript) scriptText = transcript;
    STATE.project.scriptText = scriptText;
    if (scriptText && files.videos.length) {
      setProgress(52, 'Matching script to clips (line-by-line)…');
      try {
        const matches = matchScriptToClips(scriptText, files.videos.map(f => f.name), transcript);
        STATE.project.analysis.scriptMatches = matches;

        // ── E2. Compute per-line SRT timings ──
        const scriptLines = matches.map(m => m.paragraph);
        const lineTimes   = STATE._srtEntries
          ? computeLineTimes(scriptLines, STATE._srtEntries)
          : null;
        STATE.project.analysis.lineTimes = lineTimes;
        if (lineTimes) {
          const timed = lineTimes.filter(Boolean).length;
          log('SRT timing — ' + timed + '/' + lineTimes.length + ' lines have exact timestamps ✓', 'success');
        }

        $('matchResults').innerHTML = matches.map(m =>
          '<div><strong>' + m.clip + '</strong>: ' + (m.paragraph || '').substring(0, 60) + '… <em style="color:var(--text3)">(' + m.reason + ')</em></div>'
        ).join('');
        log('Line-by-line script matching — ' + matches.length + ' matches ✓', 'success');
      } catch (e) {
        log('Script match failed: ' + e.message, 'error');
        $('matchResults').textContent = 'Script matching failed.';
      }
    } else {
      $('matchResults').textContent = 'No script provided — skipped.';
    }

    // ── F. Render with FFmpeg.wasm ──
    setProgress(58, 'Preparing renderer…');

    let renderPlaylist = [...files.videos];
    const scriptMatches = STATE.project.analysis.scriptMatches || [];
    if (scriptMatches.length > 0) {
      // ── Build render playlist: one entry per matched script line.
      //    The SAME clip file can appear many times (once per mention of its character).
      //    We look up the File object by name so FFmpeg gets the actual file handle.
      const fileByName = Object.fromEntries(files.videos.map(f => [f.name, f]));
      const matchedPlaylist = scriptMatches
        .map(m => fileByName[m.clip])
        .filter(Boolean);

      if (matchedPlaylist.length > 0) {
        // Append any clips that were never matched (so nothing is silently dropped)
        const matchedNames = new Set(scriptMatches.map(m => m.clip));
        const remainder = files.videos.filter(f => !matchedNames.has(f.name));
        renderPlaylist = [...matchedPlaylist, ...remainder];
        log(
          'Render playlist: ' + matchedPlaylist.length + ' matched (line-order, repeats OK)' +
          (remainder.length ? ' + ' + remainder.length + ' unused' : '') +
          ' = ' + renderPlaylist.length + ' total ✓', 'success'
        );
      }
    }

    // ── Align lineTimes to the render playlist order ─────────────────────
    // scriptMatches and lineTimes are parallel arrays.  The render playlist
    // is built from scriptMatches, so lineTimes can be mapped 1-to-1.
    let alignedLineTimes = null;
    const rawLineTimes = STATE.project.analysis.lineTimes || null;
    if (rawLineTimes && scriptMatches.length > 0) {
      // Take only the entries that correspond to matched lines (no remainder)
      alignedLineTimes = rawLineTimes.slice(0, scriptMatches.length);
      const timed = alignedLineTimes.filter(Boolean).length;
      log('Aligned lineTimes: ' + timed + '/' + alignedLineTimes.length + ' entries with SRT timing ✓', 'success');
    }

    log('Starting render: ' + renderPlaylist.length + ' clips via FFmpeg.wasm', 'info');
    let blob = null;
    const lineTimes = alignedLineTimes || STATE.project.analysis.lineTimes || null;
    try {
      blob = await renderVideo(renderPlaylist, files.audio, null, lineTimes);
    } catch (e) {
      log('Render error: ' + errMsg(e), 'error');
      toast('Render failed — project will still be saved.', 'error');
    }
    STATE.project.renderedBlob = blob;

    // ── Show the result immediately — don't make the user wait on Supabase ──
    setProgress(100, blob ? 'Done!' : 'Render failed');
    log('Render complete ✓', 'success');
    toast(blob ? 'Render complete!' : 'Render failed — showing what we have.', blob ? 'success' : 'error');
    $('processingBadge').style.display = 'none';
    goToStep(3);
    renderPreview();

    // ── G. Save to Supabase — runs in the background after the preview is shown ──
    saveProjectToSupabase(files, blob, faceResults, transcript)
      .catch(e => log('Background save failed: ' + errMsg(e), 'error'));

  } catch (e) {
    log('Pipeline error: ' + e.message, 'error');
    toast('Pipeline failed: ' + e.message, 'error');
    $('processingBadge').style.display = 'none';
    console.error(e);
  }
}

/** Persists the finished project to Supabase. Runs after the preview is
 *  already on screen, so a slow upload/DB write never delays seeing the video. */
async function saveProjectToSupabase(files, blob, faceResults, transcript) {
  log('Saving to Supabase…', 'info');
  const allCharNames = [...new Set(
    Object.values(faceResults).flatMap(chars => Object.keys(chars))
  )];

  try {
    let videoUrl = null;
    if (blob) {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      const vf  = new File([blob], files.title.replace(/\s+/g, '-') + '.' + ext, { type: blob.type });
      videoUrl  = await storageUpload('videos', Date.now() + '-' + vf.name, vf);
      log('Video uploaded to Supabase storage ✓', 'success');
    }

    const projectRow = await dbInsert('projects', {
      title:          files.title,
      status:         blob ? 'done' : 'partial',
      clip_count:     files.videos.length,
      transcript:     transcript.substring(0, 2000),
      script_matches: JSON.stringify(STATE.project.analysis.scriptMatches),
      face_results:   JSON.stringify(faceResults),
      video_url:      videoUrl,
      characters:     allCharNames
    });
    STATE.project.supabaseId = projectRow?.id;
    log('Project saved ✓ (id: ' + (projectRow?.id || '').substring(0, 8) + '…)', 'success');

    try {
      const clipRows = files.videos.map((f, i) => ({
        project_id:   projectRow.id,
        clip_name:    f.name,
        clip_index:   i,
        characters:   STATE.clipTagMap[f.name] || [],
        file_size_mb: parseFloat((f.size / 1024 / 1024).toFixed(2))
      }));
      await dbInsertMany('project_clips', clipRows);
      log('Clip mappings saved ✓ (' + clipRows.length + ' clips)', 'success');
    } catch (e) {
      log('project_clips insert failed: ' + e.message, 'error');
    }

    toast('Project saved to Supabase!', 'success');
  } catch (e) {
    log('DB save failed: ' + e.message, 'error');
    toast('Could not save to Supabase: ' + e.message, 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// 17. PREVIEW  (Step 3) — unchanged
// ─────────────────────────────────────────────────────────────
function renderPreview() {
  const { analysis, renderedBlob } = STATE.project;
  if (renderedBlob) {
    $('previewVideo').src = URL.createObjectURL(renderedBlob);
    $('previewVideo').style.display = 'block';
    $('previewPlaceholder').style.display = 'none';
  }
  if (analysis.transcript) {
    $('transcriptScroll').textContent = analysis.transcript;
    $('captionPreview').textContent   = '"' + analysis.transcript.substring(0, 120) + '…"';
  }

  const faceEntries = Object.entries(analysis.faces || {}).reduce((acc, [, chars]) => {
    Object.entries(chars).forEach(([n, c]) => { acc[n] = (acc[n] || 0) + c; });
    return acc;
  }, {});

  $('detectedCharsList').innerHTML = Object.keys(faceEntries).length
    ? Object.entries(faceEntries).map(([n, c]) =>
        '<div class="char-detected-item"><div class="cdi-dot"></div>' +
        '<span class="cdi-name">' + n + '</span>' +
        '<span class="cdi-count">' + (c >= 999 ? 'tagged' : c + ' frames') + '</span></div>'
      ).join('')
    : '<div style="padding:0.5rem 0.75rem;font-size:0.75rem;color:var(--text3)">No characters</div>';

  $('scriptMatchesList').innerHTML = (analysis.scriptMatches || []).length
    ? analysis.scriptMatches.map(m =>
        '<div class="match-item"><div class="cdi-dot" style="background:var(--blue)"></div>' +
        '<span class="cdi-name" style="font-size:0.72rem">' + m.clip + '</span>' +
        '<span class="cdi-count">' + (m.paragraph || '').substring(0, 25) + '…</span></div>'
      ).join('')
    : '<div style="padding:0.5rem 0.75rem;font-size:0.75rem;color:var(--text3)">No matches</div>';
}

// ─────────────────────────────────────────────────────────────
// 18. EXPORT  (Step 4) — unchanged shape, just MP4 by default
// ─────────────────────────────────────────────────────────────
function getExportSettings() {
  const res     = ($('exportResolution')?.value || '1280x720').split('x');
  const fps     = parseInt($('exportFps')?.value  || '30', 10);
  const bitrate = parseInt($('exportBitrate')?.value || '3000000', 10);
  return { width: parseInt(res[0], 10), height: parseInt(res[1], 10), fps, bitrate };
}

function renderExportPage() {
  goToStep(4);
  const { project } = STATE;
  const size = project.renderedBlob ? (project.renderedBlob.size / 1024 / 1024).toFixed(1) : '—';

  $('exportInfo').innerHTML =
    '<div class="export-info-row"><span class="eir-label">Project Title</span><span class="eir-val">' + project.title + '</span></div>' +
    '<div class="export-info-row"><span class="eir-label">Clips</span><span class="eir-val">' + project.videoFiles.length + '</span></div>' +
    '<div class="export-info-row"><span class="eir-label">Merged Size</span><span class="eir-val">' + size + ' MB</span></div>' +
    '<div class="export-info-row"><span class="eir-label">Transcript Words</span><span class="eir-val">' + (project.analysis.transcript?.split(' ').filter(Boolean).length || 0) + '</span></div>' +
    '<div class="export-info-row"><span class="eir-label">Total Cost</span><span class="eir-val" style="color:var(--green)">$0.00</span></div>';

  $('pipelineSummary').innerHTML =
    '<div class="pipeline-step"><span class="ps-icon">◉</span><span class="ps-name">Face detection</span><span class="ps-status pss-done">✓</span></div>' +
    '<div class="pipeline-step"><span class="ps-icon">◉</span><span class="ps-name">Character tagging</span><span class="ps-status pss-done">✓</span></div>' +
    '<div class="pipeline-step"><span class="ps-icon">◎</span><span class="ps-name">Transcript</span><span class="ps-status ' + (project.analysis.transcript ? 'pss-done">✓' : 'pss-skip">—') + '</span></div>' +
    '<div class="pipeline-step"><span class="ps-icon">≡</span><span class="ps-name">Script matching</span><span class="ps-status ' + (project.analysis.scriptMatches?.length ? 'pss-done">✓' : 'pss-skip">—') + '</span></div>' +
    '<div class="pipeline-step"><span class="ps-icon">▶</span><span class="ps-name">FFmpeg.wasm render</span><span class="ps-status ' + (project.renderedBlob ? 'pss-done">✓' : 'pss-skip">—') + '</span></div>' +
    '<div class="pipeline-step"><span class="ps-icon">☁</span><span class="ps-name">Supabase save</span><span class="ps-status ' + (project.supabaseId ? 'pss-done">✓' : 'pss-skip">—') + '</span></div>';

  renderClipExportList();
}

function renderClipExportList() {
  const list = $('clipExportList');
  if (!list) return;
  const files = STATE.project.videoFiles;
  if (!files || !files.length) {
    list.innerHTML = '<div style="padding:0.75rem;font-size:0.75rem;color:var(--text3)">No clips in project.</div>';
    return;
  }
  list.innerHTML = files.map((f, i) => {
    const chars  = STATE.clipTagMap[f.name] || [];
    const sizeMB = (f.size / 1024 / 1024).toFixed(1);
    return '<div class="cel-row">' +
      '<span class="cel-idx">' + (i + 1) + '</span>' +
      '<span class="cel-name">' + f.name + '</span>' +
      '<span class="cel-chars">' + (chars.length ? chars.join(', ') : '—') + '</span>' +
      '<span class="cel-size">' + sizeMB + ' MB</span>' +
      '<button class="cel-btn" id="celBtn-' + i + '" onclick="downloadSingleClip(' + i + ')">⬇ Download</button>' +
    '</div>';
  }).join('');
}

function downloadSingleClip(idx) {
  const files = STATE.project.videoFiles;
  if (!files || !files[idx]) { toast('Clip not found', 'error'); return; }
  const file = files[idx];
  const btn  = $('celBtn-' + idx);
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  const url = URL.createObjectURL(file);
  const a   = document.createElement('a');
  a.href = url; a.download = file.name; a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    if (btn) { btn.textContent = '⬇ Download'; btn.disabled = false; }
  }, 1000);
  toast('Downloading ' + file.name, 'success');
}

function downloadVideo() {
  if (!STATE.project.renderedBlob) { toast('No rendered video — click Re-Render first', 'error'); return; }
  const url = URL.createObjectURL(STATE.project.renderedBlob);
  const a   = document.createElement('a');
  const ext = STATE.project.renderedBlob.type.includes('mp4') ? 'mp4' : 'webm';
  a.href = url;
  a.download = STATE.project.title.replace(/\s+/g, '-') + '.' + ext;
  a.click();
  URL.revokeObjectURL(url);
  toast('Download started!', 'success');
}

async function reRenderWithSettings() {
  const settings = getExportSettings();
  const files    = STATE.project.videoFiles;
  const audio    = STATE.project.audioFile;
  if (!files || !files.length) { toast('No clips to render', 'error'); return; }

  const btn = $('reRenderBtn');
  if (btn) { btn.textContent = '↺ Rendering…'; btn.disabled = true; }
  toast('Re-rendering…', 'info');

  try {
    const blob = await renderVideoWithSettings(files, audio, settings);
    STATE.project.renderedBlob = blob;
    renderExportPage();
    toast('Re-render complete — ' + (blob.size / 1024 / 1024).toFixed(1) + ' MB ✓', 'success');
  } catch (e) {
    toast('Re-render failed: ' + e.message, 'error');
  }
  if (btn) { btn.textContent = '↺ Re-Render with Settings'; btn.disabled = false; }
}

// ─────────────────────────────────────────────────────────────
// 18b. ZIP EXPORT  (unchanged)
// ─────────────────────────────────────────────────────────────
async function exportAllClipsZip() {
  const files = STATE.project.videoFiles;
  if (!files || !files.length) { toast('No clips to export', 'error'); return; }
  const btn = $('downloadClipsBtn');
  if (btn) { btn.textContent = '⏳ Building ZIP…'; btn.disabled = true; }
  toast('Building ZIP of ' + files.length + ' clips…', 'info');

  try {
    if (!window.JSZip) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const zip    = new window.JSZip();
    const folder = zip.folder(STATE.project.title.replace(/\s+/g, '_') || 'ClipForge_Export');
    for (const file of files) { const ab = await getFileBytesCopy(file); folder.file(file.name, ab); }
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = (STATE.project.title.replace(/\s+/g, '_') || 'ClipForge_Clips') + '_clips.zip';
    a.click();
    URL.revokeObjectURL(url);
    toast('ZIP downloaded — ' + (blob.size / 1024 / 1024).toFixed(1) + ' MB ✓', 'success');
  } catch (e) { toast('ZIP export failed: ' + e.message, 'error'); }
  if (btn) { btn.textContent = '📦 Export All Clips (ZIP)'; btn.disabled = false; }
}

// ─────────────────────────────────────────────────────────────
// 18c. FILMORA EXPORT — .wfp / .wfpbundle format
// ─────────────────────────────────────────────────────────────

/**
 * Build the Wondershare Filmora Project JSON (project.wfp / info.json inside .wfpbundle).
 * Filmora stores projects as ZIP archives renamed to .wfp (single-event) or
 * .wfpbundle (multi-event).  The core manifest is a JSON file named
 * "project.json" inside the archive.
 *
 * Duration model: if SRT lineTimes are available we use them for exact track
 * positions; otherwise we use PLACEHOLDER_SEC (10 s) per clip.
 */
function buildFilmoraWFP(files, audioFile, title) {
  const FPS = 30;
  const PLACEHOLDER_SEC = 10;
  const lineTimes = STATE.project.analysis?.lineTimes || null;

  // Build track items
  let offset = 0;
  const trackItems = files.map((f, i) => {
    const timing  = lineTimes && lineTimes[i];
    const dur     = timing ? parseFloat((timing.end - timing.start).toFixed(3)) : PLACEHOLDER_SEC;
    const chars   = STATE.clipTagMap[f.name] || [];
    const item = {
      id:         'clip_' + i,
      name:       f.name.replace(/\.[^.]+$/, ''),
      source:     f.name,
      type:       'video',
      trackIndex: 0,
      in:         0,
      out:        dur,
      offset:     parseFloat(offset.toFixed(3)),
      duration:   dur,
      characters: chars,
      tags:       chars
    };
    offset = parseFloat((offset + dur).toFixed(3));
    return item;
  });

  const totalDuration = offset;

  const audioTrack = audioFile ? [{
    id:         'audio_0',
    name:       audioFile.name.replace(/\.[^.]+$/, ''),
    source:     audioFile.name,
    type:       'audio',
    trackIndex: -1,
    in:         0,
    out:        totalDuration,
    offset:     0,
    duration:   totalDuration
  }] : [];

  const project = {
    version:   '6.0',
    generator: 'ClipForge v6',
    created:   new Date().toISOString(),
    title:     title,
    settings: {
      width:     1280,
      height:    720,
      fps:       FPS,
      audioRate: 48000
    },
    media: [
      ...files.map((f, i) => ({
        id:   'media_' + i,
        name: f.name,
        file: f.name,
        type: 'video'
      })),
      ...(audioFile ? [{ id: 'media_audio', name: audioFile.name, file: audioFile.name, type: 'audio' }] : [])
    ],
    timeline: {
      duration: totalDuration,
      tracks: [
        {
          id:    'video_track_0',
          type:  'video',
          index: 0,
          items: trackItems
        },
        ...(audioFile ? [{
          id:    'audio_track_0',
          type:  'audio',
          index: -1,
          items: audioTrack
        }] : [])
      ]
    },
    characterMap: Object.entries(STATE.clipTagMap).map(([clip, chars]) => ({ clip, characters: chars }))
  };

  return JSON.stringify(project, null, 2);
}

function buildFilmoraReadme(files, title, format) {
  const ext  = format === 'bundle' ? '.wfpbundle' : '.wfp';
  const step = format === 'bundle'
    ? '3. File → Import → Import Project Bundle (.wfpbundle)'
    : '3. File → Import → Open Project (.wfp)';
  return (
    `CLIPFORGE — FILMORA IMPORT PACKAGE\n` +
    `====================================\n` +
    `Project:   ${title}\n` +
    `Format:    ${ext}\n` +
    `Generated: ${new Date().toLocaleString()}\n` +
    `Clips:     ${files.length}\n\n` +
    `HOW TO IMPORT INTO FILMORA\n` +
    `---------------------------\n` +
    `1. Unzip this archive (if needed)\n` +
    `2. Open Wondershare Filmora 12+\n` +
    `${step}\n` +
    `4. All clips and audio will appear on the timeline\n\n` +
    `CLIPS\n-----\n` +
    files.map((f, i) => `  ${i + 1}. ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`).join('\n') +
    `\n\nClipForge v6 · wfp/wfpbundle export\n`
  );
}

async function exportFilmoraPackage() {
  const files = STATE.project.videoFiles;
  const audio = STATE.project.audioFile;
  const title = STATE.project.title || 'ClipForge Export';
  if (!files || !files.length) { toast('No clips to export', 'error'); return; }

  const btn = $('filmoraBtn');
  if (btn) { btn.textContent = '⏳ Building .wfpbundle…'; btn.disabled = true; }

  try {
    if (!window.JSZip) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    const safeTitle = title.replace(/\s+/g, '_');
    const zip = new window.JSZip();

    // ── Primary format: .wfpbundle (ZIP renamed) ──
    // Internal structure: project.json + all media files at root
    zip.file('project.json', buildFilmoraWFP(files, audio, title));
    zip.file('README.txt',   buildFilmoraReadme(files, title, 'bundle'));

    // Media files
    for (const file of files) {
      const ab = await getFileBytesCopy(file);
      zip.file(file.name, ab);
    }
    if (audio) {
      const ab = await getFileBytesCopy(audio);
      zip.file(audio.name, ab);
    }

    // Generate two download options: .wfpbundle and .wfp (same content, different extension)
    const blobData = await zip.generateAsync({ type: 'blob', compression: 'STORE' });

    // Download as .wfpbundle
    const url1 = URL.createObjectURL(blobData);
    const a1   = document.createElement('a');
    a1.href = url1; a1.download = safeTitle + '.wfpbundle'; a1.click();
    URL.revokeObjectURL(url1);

    // Also offer .wfp (Filmora Single Project — same archive)
    const url2 = URL.createObjectURL(blobData);
    const a2   = document.createElement('a');
    a2.href = url2; a2.download = safeTitle + '.wfp'; a2.click();
    URL.revokeObjectURL(url2);

    toast('Filmora package ready — .wfpbundle + .wfp downloaded ✓', 'success');
    log('Exported ' + files.length + ' clips as .wfpbundle and .wfp ✓', 'success');
  } catch (e) {
    toast('Filmora export failed: ' + e.message, 'error');
    log('Filmora export error: ' + e.message, 'error');
  }
  if (btn) { btn.textContent = '🎬 Export for Filmora (.wfpbundle)'; btn.disabled = false; }
}

// ─────────────────────────────────────────────────────────────
// 19. DASHBOARD  (unchanged)
// ─────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [projects, characters] = await Promise.all([dbSelect('projects'), dbSelect('characters')]);
    const done = projects.filter(p => p.status === 'done').length;
    $('statTotal').textContent = projects.length;
    $('statDone').textContent  = done;
    $('statChars').textContent = characters.length;

    const list = $('recentProjects');
    if (!projects.length) {
      list.innerHTML = '<div class="empty-state"><span class="empty-icon">◎</span><p>No projects yet. <button class="inline-link" onclick="goTo(\'upload\')">Create your first one →</button></p></div>';
      return;
    }
    list.innerHTML = projects.slice(0, 5).map(p => projectCard(p, false)).join('');
  } catch (e) {
    $('statTotal').textContent = 'ERR';
    console.error('Dashboard error:', e);
  }
}

// ─────────────────────────────────────────────────────────────
// 20. PROJECTS PAGE  (unchanged)
// ─────────────────────────────────────────────────────────────
async function loadProjects() {
  const list = $('projectsFullList');
  list.innerHTML = '<div class="empty-state"><span class="empty-icon">◌</span><p>Loading…</p></div>';
  try {
    const projects = await dbSelect('projects');
    if (!projects.length) {
      list.innerHTML = '<div class="empty-state"><span class="empty-icon">▤</span><p>No projects yet.</p></div>';
      return;
    }
    list.innerHTML = projects.map(p => projectCard(p, true)).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state"><span class="empty-icon">▤</span><p>' + e.message + '</p></div>';
  }
}

function projectCard(p, showDetail) {
  const chars = Array.isArray(p.characters) ? p.characters : [];
  const charBadges = chars.length
    ? chars.map(c => '<span class="proj-char-badge">' + c + '</span>').join('')
    : '<span class="proj-char-badge empty">No characters tagged</span>';
  return '<div class="project-card">' +
    '<div class="pc-top">' +
      '<div class="pc-thumb">' + (p.status === 'done' ? '🎬' : '⏳') + '</div>' +
      '<div class="pc-info">' +
        '<div class="pc-title">' + (p.title || 'Untitled') + '</div>' +
        '<div class="pc-meta">' + (p.clip_count || 0) + ' clips · ' + new Date(p.created_at).toLocaleDateString() + '</div>' +
        '<div class="pc-char-row">' + charBadges + '</div>' +
      '</div>' +
      '<div class="pc-actions">' +
        (p.video_url ? '<a href="' + p.video_url + '" target="_blank" class="btn-ghost btn-xs">⬇ Download</a>' : '') +
        (showDetail  ? '<button class="btn-ghost btn-xs" onclick="openProjectDetail(\'' + p.id + '\')">Details →</button>' : '') +
        '<span class="pc-status ' + (p.status === 'done' ? 'status-done' : 'status-processing') + '">' + p.status + '</span>' +
        '<button class="fi-remove" onclick="deleteProject(\'' + p.id + '\')" title="Delete">✕</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

async function openProjectDetail(projectId) {
  const modal = $('projectDetailModal');
  const body  = $('projectDetailBody');
  const dlBtn = $('detailDownloadLink');
  $('detailModalTitle').textContent = 'Project Details';
  body.innerHTML = '<div class="empty-state"><span class="empty-icon">◌</span><p>Loading…</p></div>';
  modal.classList.add('open');
  try {
    const [projectRows, clips] = await Promise.all([
      dbSelect('projects', { id: projectId }),
      dbSelectWhere('project_clips', 'project_id', projectId)
    ]);
    const p = projectRows[0];
    if (!p) { body.innerHTML = '<p style="color:var(--red)">Project not found.</p>'; return; }
    $('detailModalTitle').textContent = p.title || 'Untitled Project';
    if (p.video_url) { dlBtn.href = p.video_url; dlBtn.style.display = 'inline-flex'; }
    else dlBtn.style.display = 'none';

    let faceResults   = {};
    let scriptMatches = [];
    try { faceResults   = JSON.parse(p.face_results   || '{}'); } catch (_) {}
    try { scriptMatches = JSON.parse(p.script_matches || '[]'); } catch (_) {}

    const clipTableRows = clips.length
      ? clips.map(cl => {
          const chars    = Array.isArray(cl.characters) ? cl.characters : [];
          const faceChars = Object.entries(faceResults[cl.clip_name] || {})
            .filter(([, c]) => c < 999).map(([n, c]) => n + ' (' + c + ' frames)').join(', ');
          return '<tr>' +
            '<td class="td-idx">' + (cl.clip_index + 1) + '</td>' +
            '<td class="td-name">' + cl.clip_name + '</td>' +
            '<td>' + chars.map(c => '<span class="tag-chip small">' + c + '</span>').join('') + (chars.length ? '' : '<span style="color:var(--text3);font-size:0.72rem">—</span>') + '</td>' +
            '<td class="td-detect">' + (faceChars || '<span style="color:var(--text3);font-size:0.72rem">—</span>') + '</td>' +
            '<td class="td-size">' + (cl.file_size_mb ? cl.file_size_mb + ' MB' : '—') + '</td>' +
          '</tr>';
        }).join('')
      : '';

    const fallbackRows = !clips.length
      ? Object.entries(faceResults).map(([clipName, chars], i) => {
          const manual = Object.entries(chars).filter(([, c]) => c >= 999).map(([n]) => n);
          const auto   = Object.entries(chars).filter(([, c]) => c < 999).map(([n, c]) => n + ' (' + c + ' frames)');
          return '<tr>' +
            '<td class="td-idx">' + (i + 1) + '</td>' +
            '<td class="td-name">' + clipName + '</td>' +
            '<td>' + (manual.map(n => '<span class="tag-chip small">' + n + '</span>').join('') || '<span style="color:var(--text3);font-size:0.72rem">—</span>') + '</td>' +
            '<td class="td-detect">' + (auto.join(', ') || '<span style="color:var(--text3);font-size:0.72rem">—</span>') + '</td>' +
            '<td class="td-size">—</td>' +
          '</tr>';
        }).join('')
      : '';

    const allChars    = Array.isArray(p.characters) ? p.characters : [];
    const charSummary = allChars.length
      ? allChars.map(c => '<span class="tag-chip">' + c + '</span>').join('')
      : '<span style="color:var(--text3);font-size:0.78rem">None tagged</span>';

    const matchRows = scriptMatches.map(m =>
      '<tr><td style="font-size:0.72rem;color:var(--text2)">' + (m.paragraph || '').substring(0, 60) + '…</td>' +
      '<td style="font-family:var(--mono);font-size:0.7rem">' + m.clip + '</td>' +
      '<td style="font-size:0.7rem;color:var(--text3)">' + m.reason + '</td></tr>'
    ).join('');

    body.innerHTML =
      '<div class="detail-summary-bar">' +
        '<div class="dsb-item"><span class="dsb-label">Status</span><span class="pc-status ' + (p.status === 'done' ? 'status-done' : 'status-processing') + '">' + p.status + '</span></div>' +
        '<div class="dsb-item"><span class="dsb-label">Clips</span><span class="dsb-val">' + (p.clip_count || 0) + '</span></div>' +
        '<div class="dsb-item"><span class="dsb-label">Created</span><span class="dsb-val">' + new Date(p.created_at).toLocaleString() + '</span></div>' +
      '</div>' +
      '<div class="detail-section"><div class="detail-section-title">Characters in Project</div><div class="detail-char-row">' + charSummary + '</div></div>' +
      '<div class="detail-section"><div class="detail-section-title">Clips &amp; Characters</div>' +
        '<div class="detail-table-wrap"><table class="detail-table">' +
          '<thead><tr><th>#</th><th>Clip File</th><th>Tagged Characters</th><th>AI Detected</th><th>Size</th></tr></thead>' +
          '<tbody>' + (clipTableRows || fallbackRows) + '</tbody>' +
        '</table></div></div>' +
      (p.transcript ? '<div class="detail-section"><div class="detail-section-title">Transcript</div><div class="detail-transcript">' + p.transcript + '</div></div>' : '') +
      (scriptMatches.length ?
        '<div class="detail-section"><div class="detail-section-title">Script → Clip Matches</div>' +
          '<div class="detail-table-wrap"><table class="detail-table">' +
            '<thead><tr><th>Script Paragraph</th><th>Clip</th><th>Reason</th></tr></thead>' +
            '<tbody>' + matchRows + '</tbody>' +
          '</table></div></div>' : '');

  } catch (e) {
    body.innerHTML = '<p style="color:var(--red);padding:1rem">Error: ' + e.message + '</p>';
  }
}

function closeProjectDetail() {
  $('projectDetailModal').classList.remove('open');
}

async function deleteProject(id) {
  if (!confirm('Delete this project?')) return;
  try { await dbDelete('projects', id); toast('Project deleted', 'info'); loadProjects(); }
  catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────
// 21. API STATUS
// ─────────────────────────────────────────────────────────────
function checkApiStatus() {
  const dot = $('apiStatus').querySelector('.status-dot');
  const txt = $('apiStatus').querySelector('.status-text');
  dot.className = 'status-dot ok';
  txt.textContent = 'Supabase connected';
}

// ─────────────────────────────────────────────────────────────
// 22. BOOT
// ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  if (!window.supabase?.createClient) {
    toast('Supabase SDK not loaded. Check network.', 'error');
    console.error('Supabase CDN missing'); return;
  }
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  window.goTo               = goTo;
  window.goToStep           = goToStep;
  window.deleteCharacter    = deleteCharacter;
  window.deleteProject      = deleteProject;
  window.openProjectDetail  = openProjectDetail;
  window.closeProjectDetail = closeProjectDetail;

  checkApiStatus();
  await bootstrapSchema();
  await loadCharacters();
  await loadDashboard();

  $$('.nav-item').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.page)));
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

  $('addCharBtn').addEventListener('click', () => $('addCharForm').classList.toggle('open'));
  $('cancelCharBtn').addEventListener('click', () => $('addCharForm').classList.remove('open'));
  $('saveCharBtn').addEventListener('click', saveCharacter);
  $('charPhotoZone').addEventListener('click', () => $('charPhotos').click());
  $('charPhotos').addEventListener('change', () => {
    $('charPhotoPreviews').innerHTML = '';
    for (const f of $('charPhotos').files) {
      const img = document.createElement('img');
      img.className = 'photo-preview'; img.src = URL.createObjectURL(f);
      $('charPhotoPreviews').appendChild(img);
    }
  });

  STATE._videoFileStore = STATE._videoFileStore || [];

  function addToVideoStore(newFiles) {
    const existing = new Set(STATE._videoFileStore.map(f => f.name + ':' + f.size));
    let added = 0;
    for (const f of newFiles) {
      const key = f.name + ':' + f.size;
      if (!existing.has(key)) {
        STATE._videoFileStore.push(f);
        existing.add(key);
        added++;
        // Read the bytes into the cache right away, while the handle is fresh.
        // If this fails immediately, it's a real unreadable file (corrupt/locked),
        // not a "went stale later" problem — surface that now rather than at export time.
        getFileBytes(f).catch(err => log('Warning: could not pre-cache "' + f.name + '" — ' + err.message, 'error'));
      }
    }
    const total = STATE._videoFileStore.length;
    log('Added ' + added + ' new clip(s) — total in store: ' + total, 'success');
    const clearBtn = $('clearClipsBtn');
    if (clearBtn) clearBtn.style.display = total > 0 ? 'inline-block' : 'none';
    renderClipRows(STATE._videoFileStore);
  }

  window.clearAllClips = function() {
    if (!confirm('Remove all ' + STATE._videoFileStore.length + ' clips?')) return;
    STATE._videoFileStore = [];
    STATE.clipTagMap = {};
    $('videoFiles').value = '';
    const clearBtn = $('clearClipsBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    renderClipRows([]);
    log('All clips cleared', 'info');
  };

  const videoZone  = $('videoZone');
  const videoInput = $('videoFiles');
  videoZone.addEventListener('click', () => videoInput.click());
  videoInput.addEventListener('change', () => {
    addToVideoStore(Array.from(videoInput.files));
    videoInput.value = '';
  });
  videoZone.addEventListener('dragover',  e => { e.preventDefault(); videoZone.classList.add('dragover'); });
  videoZone.addEventListener('dragleave', ()  => videoZone.classList.remove('dragover'));
  videoZone.addEventListener('drop', e => {
    e.preventDefault(); videoZone.classList.remove('dragover');
    addToVideoStore(Array.from(e.dataTransfer.files));
  });

  setupUploadZone('scriptZone', 'scriptFile', 'scriptFileList');
  setupUploadZone('audioZone',  'audioFile',  'audioFileList');

  $('startAnalysisBtn').addEventListener('click', runPipeline);
  $('downloadClipsBtn')?.addEventListener('click', exportAllClipsZip);
  $('filmoraBtn')?.addEventListener('click', exportFilmoraPackage);
  $('reRenderBtn')?.addEventListener('click', reRenderWithSettings);
  window.downloadSingleClip = downloadSingleClip;
  $('renderBtn').addEventListener('click', renderExportPage);
  $('downloadBtn').addEventListener('click', downloadVideo);
  $('saveProjectBtn').addEventListener('click', () => goTo('projects'));

  $('projectDetailModal').addEventListener('click', e => { if (e.target === $('projectDetailModal')) closeProjectDetail(); });

  console.log('ClipForge v7 ready · FFmpeg.wasm renderer · Real .mp4 output · Line-by-line char matching v2 · Fuzzy SRT alignment · Round-robin clip rotation · Expanded alias+context detection · Supabase: youtube');
});