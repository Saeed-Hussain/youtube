import { doubleMetaphone } from 'double-metaphone';

/**
 * Optimal String Alignment distance (Damerau-Levenshtein restricted to
 * adjacent transpositions).
 *
 * Plain Levenshtein charges 2 for a swapped pair, so "Kendrcik" scores the
 * same distance from "Kendrick" as an unrelated two-letter change. Since
 * transposition is the single most common typing error in a hand-edited SRT,
 * counting it as one edit is what lets the threshold stay tight enough to
 * avoid false matches.
 */
export function osaDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr: number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
    }
    prev2 = prev;
    prev = curr;
    curr = new Array(b.length + 1);
  }

  return prev[b.length];
}

const phoneticCache = new Map<string, [string, string]>();

/** Both Double Metaphone codes for a word, memoised. */
export function phoneticKeys(word: string): [string, string] {
  const cached = phoneticCache.get(word);
  if (cached) return cached;
  const keys = doubleMetaphone(word) as [string, string];
  phoneticCache.set(word, keys);
  return keys;
}

/** True when two words share any Double Metaphone code (i.e. sound alike). */
export function soundsAlike(a: string, b: string): boolean {
  const [ap, as] = phoneticKeys(a);
  const [bp, bs] = phoneticKeys(b);
  if (!ap && !bp) return false;
  return (
    (!!ap && (ap === bp || ap === bs)) ||
    (!!as && (as === bp || as === bs))
  );
}

/**
 * How many edits a name of this length may absorb and still be the same name.
 *
 * Deliberately conservative and length-scaled: allowing 2 edits on a 5-letter
 * word would merge "Drake" with "Drama". Short names get one edit, long names
 * get proportionally more, capped at 3.
 */
export function editBudget(length: number): number {
  if (length <= 4) return 0;
  if (length <= 6) return 1;
  if (length <= 10) return 2;
  return 3;
}

export interface SimilarityResult {
  match: boolean;
  /** 1 = identical, decreasing with edit distance. 0 when not a match. */
  score: number;
  reason: 'exact' | 'edit' | 'phonetic' | 'prefix' | 'none';
}

/**
 * Decide whether two name tokens refer to the same thing.
 *
 * The gate is intentionally an AND of cheap structural checks before the
 * expensive ones. A candidate must agree on its first letter and be within a
 * couple of characters in length before edit distance or phonetics are even
 * consulted, because "Kendrik" vs "Kendrick" passes all three while
 * "Drake" vs "Blake" fails the first.
 */
export function similarity(a: string, b: string): SimilarityResult {
  const x = a.toLowerCase();
  const y = b.toLowerCase();

  if (x === y) return { match: true, score: 1, reason: 'exact' };
  if (!x || !y) return { match: false, score: 0, reason: 'none' };

  // Trailing-s / possessive: "Drake's" -> "drakes" -> "drake".
  const xs = x.replace(/(?:'s|s')$/, '').replace(/s$/, '');
  const ys = y.replace(/(?:'s|s')$/, '').replace(/s$/, '');
  if (xs === ys) return { match: true, score: 0.98, reason: 'exact' };

  if (x[0] !== y[0]) return { match: false, score: 0, reason: 'none' };
  if (Math.abs(x.length - y.length) > 3) return { match: false, score: 0, reason: 'none' };

  const budget = editBudget(Math.max(x.length, y.length));
  if (budget === 0) return { match: false, score: 0, reason: 'none' };

  const dist = osaDistance(x, y);
  if (dist <= budget) {
    return { match: true, score: 1 - dist / (Math.max(x.length, y.length) + 1), reason: 'edit' };
  }

  // Phonetic fallback catches respellings that edit distance misses, e.g. a
  // transcriber writing "Kendrik Lemar" or "Faysal" for "Faisal". Still gated
  // on the shared first letter and comparable length above.
  if (x.length >= 4 && soundsAlike(x, y) && dist <= budget + 2) {
    return { match: true, score: 0.72, reason: 'phonetic' };
  }

  return { match: false, score: 0, reason: 'none' };
}
