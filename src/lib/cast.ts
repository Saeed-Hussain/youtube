import { similarity } from './fuzzy.ts';
import { normalizeWord, type Word } from './srt.ts';
import { COMMON_WORDS } from './stopwords.ts';
import type { Entity, Mention } from './entities.ts';
import { slug } from './entities.ts';

/**
 * Words in a clip filename that describe the shot rather than name the person.
 *
 * These are stripped before a filename is read as a character name, so
 * `drake_courtroom_wide_4k_v2.mp4` is understood as "Drake" and not as a
 * character called "Drake Courtroom Wide 4k V2".
 */
const QUALIFIERS = new Set(
  `clip clips shot shots take takes scene scenes cut cuts edit edited raw final
   footage video vid vids movie mov file broll brol roll aroll a b
   angle wide close closeup cu ws ms mid medium far zoom pan tilt static
   intro outro loop bg background overlay filler stock
   hd fhd uhd sd hq lq 4k 8k 2k 1080 1080p 720 720p 1440 1440p 2160 2160p
   fps 24fps 25fps 30fps 60fps
   copy new old temp tmp test draft ver version rev
   left right top bottom front back side
   part pt seg segment sequence
   render export output source src master proxy
   final2 finalfinal untitled`
    .split(/\s+/)
    .filter(Boolean),
);

/** `v2`, `01`, `take3`, `4k` - positional markers, never part of a name. */
function isQualifier(token: string): boolean {
  if (!token) return true;
  if (QUALIFIERS.has(token)) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^v\d+$/.test(token)) return true;
  if (/^\d+(?:k|p|fps)$/.test(token)) return true;
  return false;
}

/** Filename -> lowercase word tokens, camelCase split, qualifiers removed. */
export function filenameTokens(filename: string): string[] {
  const base = filename.replace(/\.[a-z0-9]{1,8}$/i, '');

  return base
    // Split camelCase and PascalCase runs before splitting on separators.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => normalizeWord(t))
    .filter((t) => t.length > 0 && !isQualifier(t));
}

export interface CastMember {
  entity: Entity;
  clipIds: string[];
}

export interface CastResult {
  entities: Entity[];
  mentions: Mention[];
  /** clipId -> entityId, for clips that name a character. */
  binding: Map<string, string>;
  /** Clips whose filename names nobody in the script - general b-roll. */
  brollClipIds: string[];
  notes: string[];
  warnings: string[];
}

interface ClipInput {
  id: string;
  filename: string;
  /** Explicit tags override the filename entirely when present. */
  tags: string[];
}

/**
 * Build the cast from the clip files, then locate every mention of them.
 *
 * This is the inversion the previous version got wrong. It tried to *discover*
 * characters by guessing which capitalised words in the subtitles were names,
 * which meant it could invent people ("Courts", "Appeals") and miss real ones.
 * But the user already told us the cast when they named their clips - a folder
 * containing `drake_court.mp4` and `kendrick_lamar_grammys.mp4` is an explicit,
 * unambiguous declaration that this video is about Drake and Kendrick Lamar.
 *
 * So the clips define who exists, and the subtitles are consulted only to
 * settle one question: how much of the filename is the name?
 * `kendrick_lamar_grammys.mp4` offers three readings - "kendrick",
 * "kendrick lamar", "kendrick lamar grammys" - and the right one is the longest
 * that the script actually says. That single rule handles both
 * `drake_court_01.mp4` (-> Drake) and `kendrick_lamar_grammys.mp4`
 * (-> Kendrick Lamar) without any per-file configuration.
 */
export function buildCast(clips: ClipInput[], words: Word[], declared: string[] = []): CastResult {
  const notes: string[] = [];
  const warnings: string[] = [];

  const index = buildWordIndex(words);
  const members: { key: string; canonical: string; aliases: Set<string>; clipIds: string[]; fromClip: boolean }[] = [];

  /** Find an existing member this name belongs to, fuzzily. */
  const findMember = (tokens: string[]) =>
    members.find((m) => {
      for (const alias of m.aliases) {
        const aliasTokens = alias.split(' ');
        if (aliasTokens.length !== tokens.length) continue;
        if (aliasTokens.every((t, i) => similarity(t, tokens[i]).match)) return true;
      }
      // A single token matching any part of a multi-word name is the same
      // person: "drake" belongs to "Drake", "lamar" to "Kendrick Lamar".
      if (tokens.length === 1 && tokens[0].length >= 3) {
        for (const alias of m.aliases) {
          if (alias.split(' ').some((t) => t.length >= 3 && similarity(t, tokens[0]).match)) return true;
        }
      }
      return false;
    });

  // --- names the user typed in take priority --------------------------------
  for (const name of declared) {
    const tokens = name.trim().toLowerCase().split(/\s+/).map(normalizeWord).filter(Boolean);
    if (!tokens.length) continue;
    if (findMember(tokens)) continue;
    members.push({
      key: tokens.join(' '),
      canonical: name.trim(),
      aliases: new Set([tokens.join(' ')]),
      clipIds: [],
      fromClip: false,
    });
  }

  // --- the cast, read off the clip files ------------------------------------
  for (const clip of clips) {
    const readings = clip.tags.length
      ? clip.tags.map((t) => t.toLowerCase().split(/\s+/).map(normalizeWord).filter(Boolean)).filter((t) => t.length)
      : [filenameTokens(clip.filename)];

    let bound = false;

    for (const tokens of readings) {
      if (!tokens.length) continue;

      const resolved = resolveName(tokens, index, Boolean(clip.tags.length));
      if (!resolved) continue;

      const existing = findMember(resolved.tokens);
      if (existing) {
        existing.clipIds.push(clip.id);
        for (const a of resolved.aliases) existing.aliases.add(a);
        // A clip-derived spelling confirmed by the script beats a guess.
        if (!existing.fromClip && resolved.canonical) existing.fromClip = true;
      } else {
        members.push({
          key: resolved.tokens.join(' '),
          canonical: resolved.canonical,
          aliases: new Set(resolved.aliases),
          clipIds: [clip.id],
          fromClip: true,
        });
      }
      bound = true;
      break;
    }

    if (!bound && clip.tags.length) {
      warnings.push(
        `"${clip.filename}" is tagged "${clip.tags.join(', ')}" but the script never says that name - it will be used as b-roll.`,
      );
    }
  }

  // --- promote to entities --------------------------------------------------
  const entities: Entity[] = [];
  const binding = new Map<string, string>();

  for (const member of members) {
    const aliases = expandAliases(member.aliases, member.canonical);
    const entity: Entity = {
      id: uniqueId(slug(member.canonical || member.key), entities),
      canonical: member.canonical || titleCase(member.key),
      aliases,
      variants: [],
      mentionCount: 0,
      auto: member.fromClip,
      kind: guessKind(member.canonical || member.key),
    };
    entities.push(entity);
    for (const clipId of member.clipIds) binding.set(clipId, entity.id);
  }

  // --- locate every mention -------------------------------------------------
  const mentions = findMentions(words, entities);

  const surfaces = new Map<string, Map<string, number>>();
  for (const m of mentions) {
    const byText = surfaces.get(m.entityId) ?? new Map<string, number>();
    byText.set(m.surface, (byText.get(m.surface) ?? 0) + 1);
    surfaces.set(m.entityId, byText);
  }

  for (const entity of entities) {
    const observed = surfaces.get(entity.id);
    entity.mentionCount = observed ? [...observed.values()].reduce((a, b) => a + b, 0) : 0;
    entity.variants = observed
      ? [...observed.entries()].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count)
      : [];

    // Display the spelling the script actually uses most, so a filename written
    // `kendrik_stage.mp4` still shows as "Kendrick Lamar" in the UI.
    const best = entity.variants[0];
    if (best && best.count >= 2 && wordCount(best.text) >= wordCount(entity.canonical)) {
      entity.canonical = best.text;
    }

    const others = entity.variants.filter((v) => v.text.toLowerCase() !== entity.canonical.toLowerCase());
    if (others.length) {
      notes.push(
        `"${entity.canonical}" is also written ${others.slice(0, 4).map((v) => `"${v.text}" (${v.count}x)`).join(', ')} - all matched to the same character.`,
      );
    }

    if (entity.mentionCount === 0) {
      warnings.push(
        `"${entity.canonical}" never appears in the subtitles, so their clips will only be used as b-roll.`,
      );
    }
  }

  const claimed = new Set(binding.keys());
  const brollClipIds = clips.filter((c) => !claimed.has(c.id)).map((c) => c.id);

  return { entities, mentions, binding, brollClipIds, notes, warnings };
}

/* ------------------------------------------------------------------ */
/* filename -> name resolution                                         */
/* ------------------------------------------------------------------ */

interface WordIndex {
  words: Word[];
  /** first letter -> word positions, to avoid scanning the whole script. */
  byLetter: Map<string, number[]>;
}

function buildWordIndex(words: Word[]): WordIndex {
  const byLetter = new Map<string, number[]>();
  words.forEach((w, i) => {
    const letter = w.norm[0];
    if (!letter) return;
    const list = byLetter.get(letter);
    if (list) list.push(i);
    else byLetter.set(letter, [i]);
  });
  return { words, byLetter };
}

/**
 * Decide how much of a filename is the character's name.
 *
 * Longest-match-wins against the script: `kendrick_lamar_grammys` tries
 * "kendrick lamar grammys", then "kendrick lamar", then "kendrick", and takes
 * the first that the narration actually says. An explicit tag is trusted even
 * when the script never says it, so the user can always override.
 */
function resolveName(
  tokens: string[],
  index: WordIndex,
  trustEvenIfAbsent: boolean,
): { tokens: string[]; canonical: string; aliases: string[] } | null {
  const limit = Math.min(tokens.length, 4);

  for (let k = limit; k >= 1; k--) {
    const candidate = tokens.slice(0, k);

    // A single common word is never a character, however it was spelled.
    if (k === 1 && COMMON_WORDS.has(candidate[0])) continue;

    const hits = countOccurrences(candidate, index);
    if (hits > 0) {
      return {
        tokens: candidate,
        canonical: titleCase(candidate.join(' ')),
        aliases: [candidate.join(' ')],
      };
    }
  }

  if (!trustEvenIfAbsent) return null;

  // Tagged but unspoken: keep the user's word for it.
  const fallback = tokens.slice(0, Math.min(tokens.length, 3));
  return { tokens: fallback, canonical: titleCase(fallback.join(' ')), aliases: [fallback.join(' ')] };
}

/** How many times this token sequence is spoken, allowing misspellings. */
function countOccurrences(tokens: string[], index: WordIndex): number {
  const starts = index.byLetter.get(tokens[0][0]) ?? [];
  let hits = 0;

  for (const start of starts) {
    if (start + tokens.length > index.words.length) continue;
    let ok = true;
    for (let k = 0; k < tokens.length; k++) {
      const target = tokens[k];
      const actual = index.words[start + k].norm;
      if (target === actual) continue;
      // Short tokens must match exactly; edit distance is meaningless below
      // four characters and would match half the dictionary.
      if (target.length < 4 || !similarity(target, actual).match) {
        ok = false;
        break;
      }
    }
    if (ok) hits++;
  }

  return hits;
}

/* ------------------------------------------------------------------ */
/* aliases and mention sweep                                           */
/* ------------------------------------------------------------------ */

/** Full name, each name part, and the initials. */
function expandAliases(seed: Set<string>, canonical: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const v = s.trim().toLowerCase();
    if (v.length >= 2 && !COMMON_WORDS.has(v)) out.add(v);
  };

  for (const s of seed) add(s);
  if (canonical) add(canonical);

  for (const alias of [...out]) {
    const parts = alias.split(' ').filter(Boolean);
    if (parts.length < 2) continue;
    add(parts[0]);
    add(parts[parts.length - 1]);
    const initials = parts.map((p) => p[0]).join('');
    if (initials.length >= 2) add(initials);
  }

  // Longest first, so "kendrick lamar" is preferred over "kendrick".
  return [...out].sort((a, b) => wordCount(b) - wordCount(a) || b.length - a.length);
}

/**
 * Sweep the word timeline for every alias.
 *
 * Deliberately independent of cue and sentence structure: it walks words, not
 * lines. A subtitle line naming three people produces three mentions at three
 * distinct millisecond timestamps, which is what lets the editor cut between
 * all three inside that one line.
 */
function findMentions(words: Word[], entities: Entity[]): Mention[] {
  interface AliasEntry {
    entityId: string;
    tokens: string[];
    canonicalTokens: Set<string>;
  }

  const aliasIndex: AliasEntry[] = [];
  for (const e of entities) {
    const canonicalTokens = new Set(e.canonical.toLowerCase().split(/\s+/).map(normalizeWord).filter(Boolean));
    for (const alias of e.aliases) {
      aliasIndex.push({ entityId: e.id, tokens: alias.split(' ').filter(Boolean), canonicalTokens });
    }
  }
  if (!aliasIndex.length) return [];

  const byLetter = new Map<string, AliasEntry[]>();
  for (const entry of aliasIndex) {
    const letter = entry.tokens[0]?.[0];
    if (!letter) continue;
    const list = byLetter.get(letter);
    if (list) list.push(entry);
    else byLetter.set(letter, [entry]);
  }

  const mentions: Mention[] = [];

  for (let i = 0; i < words.length; i++) {
    const first = words[i].norm;
    if (!first) continue;

    const bucket = byLetter.get(first[0]);
    if (!bucket) continue;

    let best: { entry: AliasEntry; length: number; confidence: number } | null = null;

    for (const entry of bucket) {
      const len = entry.tokens.length;
      if (i + len > words.length) continue;

      let confidence = 1;
      let ok = true;
      for (let k = 0; k < len; k++) {
        const target = entry.tokens[k];
        const actual = words[i + k].norm;
        if (target === actual) continue;
        if (target.length < 4) {
          ok = false;
          break;
        }
        const sim = similarity(target, actual);
        if (!sim.match) {
          ok = false;
          break;
        }
        confidence = Math.min(confidence, sim.score);
      }
      if (!ok) continue;

      if (!best || len > best.length || (len === best.length && confidence > best.confidence)) {
        best = { entry, length: len, confidence };
      }
    }

    if (!best) continue;

    const surface = words
      .slice(i, i + best.length)
      .map((w) => w.raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}']+$/u, ''))
      .join(' ');

    const surfaceTokens = words.slice(i, i + best.length).map((w) => w.norm);

    mentions.push({
      entityId: best.entry.entityId,
      wordIndex: i,
      wordCount: best.length,
      startMs: words[i].startMs,
      endMs: words[i + best.length - 1].endMs,
      confidence: best.confidence,
      surface,
      corrected: best.confidence < 1 || surfaceTokens.some((t) => !best!.entry.canonicalTokens.has(t)),
    });

    i += best.length - 1;
  }

  return mentions;
}

/* ------------------------------------------------------------------ */

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function guessKind(name: string): Entity['kind'] {
  if (/\b(?:inc|llc|ltd|corp|group|records|music|media|company|university|school|clinic|court|labs?)\b/i.test(name)) {
    return 'organisation';
  }
  if (/^[a-z]{2,6}$/i.test(name) && name === name.toUpperCase()) return 'organisation';
  return wordCount(name) <= 3 ? 'person' : 'unknown';
}

function uniqueId(base: string, entities: Entity[]): string {
  if (!entities.some((e) => e.id === base)) return base;
  let n = 2;
  while (entities.some((e) => e.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
