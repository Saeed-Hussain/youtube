import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSubtitles } from '../src/lib/srt.ts';
import { buildCast, filenameTokens } from '../src/lib/cast.ts';

function srtOf(...lines: string[]): string {
  return lines
    .map((text, i) => {
      const t = (n: number) => new Date(n * 1000).toISOString().slice(11, 23).replace('.', ',');
      return `${i + 1}\n${t(i * 3)} --> ${t(i * 3 + 3)}\n${text}\n`;
    })
    .join('\n');
}

const clip = (id: string, filename: string, tags: string[] = []) => ({ id, filename, tags });

function cast(lines: string[], clips: ReturnType<typeof clip>[], declared: string[] = []) {
  const { words } = parseSubtitles(srtOf(...lines));
  return { words, ...buildCast(clips, words, declared) };
}

test('filenameTokens strips shot qualifiers and numbering', () => {
  assert.deepEqual(filenameTokens('drake_court_01.mp4'), ['drake', 'court']);
  assert.deepEqual(filenameTokens('kendrick-lamar-grammys-4k-v2.mov'), ['kendrick', 'lamar', 'grammys']);
  assert.deepEqual(filenameTokens('DrakeStage_Wide_1080p.mp4'), ['drake', 'stage']);
  assert.deepEqual(filenameTokens('clip_003_final.mp4'), []);
});

test('the cast is exactly the characters named by the clip files', () => {
  const { entities } = cast(
    [
      'Drake walked into the courtroom without a word.',
      'Kendrick Lamar had answered the world weeks earlier.',
      'Universal Music Group pushed back against the filing.',
      'Courts generally hate broad pronouncements like that one.',
    ],
    [clip('a', 'drake_court_01.mp4'), clip('b', 'kendrick_lamar_grammys.mp4')],
  );

  const names = entities.map((e) => e.canonical).sort();
  assert.deepEqual(names, ['Drake', 'Kendrick Lamar']);
  // "Courts" and "Universal Music Group" are in the script but have no clips,
  // so they are not characters. Nothing is invented.
});

test('the filename is trimmed to the longest part the script actually says', () => {
  const { entities } = cast(
    ['Kendrick Lamar took the stage that night.', 'Later Kendrick Lamar left quietly.'],
    [clip('a', 'kendrick_lamar_grammys.mp4')],
  );

  assert.equal(entities.length, 1);
  assert.equal(entities[0].canonical, 'Kendrick Lamar', 'keeps the surname, drops "grammys"');
});

test('a single-word name is not over-extended', () => {
  const { entities } = cast(
    ['Drake walked into the courtroom.', 'Drake said nothing at all.'],
    [clip('a', 'drake_courtroom_wide.mp4')],
  );

  assert.equal(entities[0].canonical, 'Drake', 'does not become "Drake Courtroom"');
});

test('several clips of one character collapse to a single cast member', () => {
  const { entities, binding } = cast(
    ['Drake walked in.', 'Drake sat down.', 'Drake left again.'],
    [clip('a', 'drake_court_01.mp4'), clip('b', 'drake_stage.mp4'), clip('c', 'DrakeCloseup.mp4')],
  );

  assert.equal(entities.length, 1);
  const id = entities[0].id;
  assert.deepEqual([binding.get('a'), binding.get('b'), binding.get('c')], [id, id, id]);
});

test('a misspelled filename still finds the character', () => {
  const { entities, binding } = cast(
    ['Kendrick Lamar spoke first.', 'Then Kendrick Lamar left.'],
    [clip('k', 'kendrik_stage.mp4')],
  );

  assert.equal(entities.length, 1);
  assert.equal(binding.get('k'), entities[0].id);
  // The script's spelling wins for display, so the typo is corrected. The
  // surname is deliberately not invented: the filename never said "Lamar",
  // and adding name parts the user did not write is how a matcher starts
  // merging people who share a first name.
  assert.equal(entities[0].canonical, 'Kendrick');
});

test('a misspelling in the script is matched to the clip name', () => {
  const { entities, mentions } = cast(
    ['Kendrick Lamar spoke first.', 'Then Kendrik answered.', 'Finally Kendrcik walked out.'],
    [clip('k', 'kendrick_lamar.mp4')],
  );

  assert.equal(entities.length, 1);
  assert.equal(mentions.length, 3, 'all three spellings located');
  assert.ok(mentions.some((m) => m.corrected), 'the misspellings are flagged as corrected');
});

test('a clip naming nobody in the script becomes b-roll', () => {
  const { entities, brollClipIds } = cast(
    ['Drake walked into the courtroom.', 'Drake said nothing.'],
    [clip('a', 'drake_court.mp4'), clip('b', 'city_timelapse_night.mp4')],
  );

  assert.equal(entities.length, 1);
  assert.deepEqual(brollClipIds, ['b']);
});

test('an explicit tag overrides the filename', () => {
  const { entities, binding } = cast(
    ['Drake walked in.', 'Drake left.'],
    [clip('a', 'IMG_4471.mp4', ['Drake'])],
  );

  assert.equal(entities.length, 1);
  assert.equal(entities[0].canonical, 'Drake');
  assert.equal(binding.get('a'), entities[0].id);
});

test('a character named in a clip but absent from the script is reported', () => {
  const { entities, warnings } = cast(
    ['Drake walked in.', 'Drake left.'],
    [clip('a', 'drake.mp4'), clip('b', 'IMG_9.mp4', ['Beyonce'])],
  );

  assert.ok(entities.some((e) => e.canonical === 'Drake'));
  assert.ok(
    warnings.some((w) => w.toLowerCase().includes('beyonce')),
    `expected a warning about Beyonce, got: ${warnings.join(' | ')}`,
  );
});

test('mention timings come straight from the word timeline', () => {
  const { words, mentions } = cast(
    ['Drake arrived early today.', 'Kendrick Lamar arrived much later.'],
    [clip('a', 'drake.mp4'), clip('b', 'kendrick_lamar.mp4')],
  );

  for (const m of mentions) {
    assert.equal(m.startMs, words[m.wordIndex].startMs);
    assert.ok(m.endMs > m.startMs);
  }
});
