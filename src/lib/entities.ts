import type { Ms } from './time.ts';

/**
 * The shared vocabulary for characters and where they are named.
 *
 * The cast itself is built in `cast.ts`, from the clip filenames. An earlier
 * version tried to *discover* characters by guessing which capitalised words in
 * the subtitles were proper nouns; it invented people ("Courts", "Appeals",
 * "Whatever") and still missed real ones, because English capitalises the first
 * word of every sentence and no amount of heuristics fully separates a name
 * from a sentence opener. Reading the cast off the filenames removes the guess
 * entirely - the user already declared who matters when they named their
 * footage.
 */

export interface Entity {
  id: string;
  /** The spelling shown in the UI. */
  canonical: string;
  /** Every lowercased surface form that resolves to this character. */
  aliases: string[];
  /** Spellings actually observed in the subtitles, most frequent first. */
  variants: { text: string; count: number }[];
  mentionCount: number;
  /** True when the character came from a clip filename rather than a typed name. */
  auto: boolean;
  kind: 'person' | 'organisation' | 'unknown';
}

export interface Mention {
  entityId: string;
  /** Index into the word timeline where the name starts. */
  wordIndex: number;
  /** How many words the name spanned ("Kendrick Lamar" = 2). */
  wordCount: number;
  startMs: Ms;
  endMs: Ms;
  /** 1 for an exact hit, lower for a fuzzy or phonetic one. */
  confidence: number;
  /** The text as it appeared in the subtitles. */
  surface: string;
  /** Set when the subtitles spelled the name differently from the canonical form. */
  corrected: boolean;
}

/** URL- and filesystem-safe identifier derived from a display name. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'character'
  );
}
