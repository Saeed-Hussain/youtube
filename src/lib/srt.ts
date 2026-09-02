import { parseTimestamp, type Ms } from './time.ts';

export interface Cue {
  /** 0-based position in the timeline, after sorting by start time. */
  index: number;
  startMs: Ms;
  endMs: Ms;
  text: string;
}

export interface Word {
  /** Lowercased, punctuation-stripped — what the matcher compares against. */
  norm: string;
  /** As written in the SRT, punctuation and capitalisation intact. */
  raw: string;
  startMs: Ms;
  endMs: Ms;
  cueIndex: number;
  /** Position in the flat word timeline. */
  wordIndex: number;
}

export interface ParsedSubtitles {
  cues: Cue[];
  words: Word[];
  durationMs: Ms;
  warnings: string[];
}

const TIMING_LINE = /-->/;

/**
 * Tolerant SRT/WebVTT parser.
 *
 * Real subtitle files — especially ones produced by Whisper, YouTube's auto
 * captions, or hand edits — routinely violate the spec: missing sequence
 * numbers, CRLF, a UTF-8 BOM, blank lines inside a cue, `<i>` / `{\an8}`
 * markup, overlapping or out-of-order cues, zero-length cues. Each of those
 * made the previous parser silently drop the cue, and a dropped cue is a clip
 * landing in the wrong place. This parser recovers from all of them and
 * reports what it repaired in `warnings` rather than throwing.
 */
export function parseSubtitles(input: string): ParsedSubtitles {
  const warnings: string[] = [];
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const raw: Omit<Cue, 'index'>[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!TIMING_LINE.test(lines[i])) continue;

    const parts = lines[i].split('-->');
    const startMs = parseTimestamp(stripCueSettings(parts[0]));
    const endMs = parseTimestamp(stripCueSettings(parts[1] ?? ''));
    if (startMs === null || endMs === null) {
      warnings.push(`Line ${i + 1}: unreadable timing "${lines[i].trim()}" - cue skipped.`);
      continue;
    }

    // The body runs until a blank line that is followed by another timing line
    // or a bare sequence number. A blank line mid-cue (common in hand-edited
    // files) therefore no longer truncates the text.
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (TIMING_LINE.test(line)) break;
      if (line.trim() === '') {
        const next = nextNonEmpty(lines, j);
        if (next === -1) break;
        if (TIMING_LINE.test(lines[next]) || /^\d+$/.test(lines[next].trim())) break;
        body.push('');
        j++;
        continue;
      }
      // A bare number directly before a timing line is a sequence number.
      if (/^\d+$/.test(line.trim()) && j + 1 < lines.length && TIMING_LINE.test(lines[j + 1])) break;
      body.push(line);
      j++;
    }
    i = j - 1;

    const clean = cleanCueText(body.join(' '));
    if (!clean) continue;
    raw.push({ startMs, endMs, text: clean });
  }

  if (!raw.length) {
    return {
      cues: [],
      words: [],
      durationMs: 0,
      warnings: [...warnings, 'No readable cues found. Is this really an .srt or .vtt file?'],
    };
  }

  raw.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  // Repair pass: make the timeline strictly monotonic. Downstream segmentation
  // assumes non-overlapping ranges; an overlap here shows up as two clips
  // fighting over the same instant.
  const cues: Cue[] = [];
  for (const c of raw) {
    let startMs = c.startMs;
    let endMs = c.endMs;

    if (endMs <= startMs) {
      // Zero/negative length: give it a nominal duration from its word count so
      // it still gets a slice of the timeline instead of vanishing.
      endMs = startMs + Math.max(400, countWords(c.text) * 300);
      warnings.push(`A cue at ${Math.round(startMs / 1000)}s had no duration - estimated ${endMs - startMs}ms.`);
    }

    const prev = cues[cues.length - 1];
    if (prev && startMs < prev.endMs) {
      if (startMs > prev.startMs) {
        prev.endMs = startMs; // trim the earlier cue back
      } else {
        startMs = prev.endMs;
        if (endMs <= startMs) endMs = startMs + 400;
      }
      warnings.push(`Overlapping cues near ${Math.round(startMs / 1000)}s - trimmed to remove the overlap.`);
    }

    cues.push({ index: cues.length, startMs, endMs, text: c.text });
  }

  return {
    cues,
    words: buildWordTimeline(cues),
    durationMs: cues[cues.length - 1].endMs,
    warnings: dedupe(warnings),
  };
}

/**
 * Flatten cues into a word timeline with a per-word start/end.
 *
 * The previous implementation split a cue's duration evenly across its words,
 * which puts "a" and "unprecedented" on equal footing and skews every cut made
 * inside a long cue. Here each word's share is weighted by an estimate of how
 * long it takes to say - vowel groups as a syllable proxy, plus a length term -
 * which tracks real speech far more closely and costs nothing to compute.
 */
export function buildWordTimeline(cues: Cue[]): Word[] {
  const words: Word[] = [];

  for (const cue of cues) {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;

    const weights = tokens.map(speechWeight);
    const total = weights.reduce((a, b) => a + b, 0) || tokens.length;
    const span = cue.endMs - cue.startMs;

    let acc = 0;
    for (let i = 0; i < tokens.length; i++) {
      const start = cue.startMs + Math.round((acc / total) * span);
      acc += weights[i];
      const end = cue.startMs + Math.round((acc / total) * span);
      words.push({
        norm: normalizeWord(tokens[i]),
        raw: tokens[i],
        startMs: start,
        // Guarantee at least 1ms so a word is never a zero-width point.
        endMs: Math.max(end, start + 1),
        cueIndex: cue.index,
        wordIndex: words.length,
      });
    }
  }

  return words;
}

/** Rough "how long does this take to say" score. Syllables approx vowel groups. */
function speechWeight(token: string): number {
  const letters = token.toLowerCase().replace(/[^a-z0-9']/g, '');
  if (!letters) return 0.5;
  const syllables = (letters.match(/[aeiouy]+/g) ?? []).length || 1;
  // Digits are read out long: "2024" is spoken as "twenty twenty four".
  const digits = (letters.match(/\d/g) ?? []).length;
  return syllables + digits * 0.8 + letters.length * 0.12;
}

/** Strip WebVTT cue settings (`align:start position:50%`) off a timestamp. */
function stripCueSettings(s: string): string {
  return s.replace(/\b[a-z]+:[^\s]+/gi, '').trim();
}

function cleanCueText(s: string): string {
  return s
    .replace(/<[^>]*>/g, '') // <i>, <font color=...>
    .replace(/\{[^}]*\}/g, '') // {\an8} ASS overrides
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/^\s*-\s+/gm, '') // dialogue dashes
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SentenceRange {
  /** Inclusive index of the first word. */
  from: number;
  /** Exclusive index just past the last word. */
  to: number;
  startMs: Ms;
  endMs: Ms;
  text: string;
}

/**
 * True at every word index that begins a sentence.
 *
 * An initial ("J.") or an abbreviation ends in a dot without ending a
 * sentence, so a terminator only counts when it follows at least two letters.
 */
export function markSentenceStarts(words: Word[]): boolean[] {
  const flags = new Array<boolean>(words.length).fill(false);
  if (!words.length) return flags;
  flags[0] = true;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1].raw;
    flags[i] = /[.!?]["')\]]?$/.test(prev) && !/(?:^|\s)[A-Za-z]\.$/.test(prev);
  }
  return flags;
}

/** Split the word timeline into sentences, keeping exact word-level bounds. */
export function sentenceRanges(words: Word[]): SentenceRange[] {
  if (!words.length) return [];
  const starts = markSentenceStarts(words);
  const ranges: SentenceRange[] = [];

  let from = 0;
  for (let i = 1; i <= words.length; i++) {
    if (i < words.length && !starts[i]) continue;
    ranges.push({
      from,
      to: i,
      startMs: words[from].startMs,
      endMs: words[i - 1].endMs,
      text: words.slice(from, i).map((w) => w.raw).join(' '),
    });
    from = i;
  }
  return ranges;
}

export function normalizeWord(token: string): string {
  return token
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9']/g, '')
    .replace(/^'+|'+$/g, '');
}

function countWords(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function nextNonEmpty(lines: string[], from: number): number {
  for (let k = from + 1; k < lines.length; k++) if (lines[k].trim() !== '') return k;
  return -1;
}

/** Collapse near-identical warnings so one malformed file can't flood the UI. */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.replace(/\d+/g, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 40);
}
