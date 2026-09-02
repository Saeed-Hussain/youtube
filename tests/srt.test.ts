import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSubtitles, sentenceRanges } from '../src/lib/srt.ts';
import { parseTimestamp, formatFFmpegTime } from '../src/lib/time.ts';

test('parseTimestamp reads SRT and VTT forms', () => {
  assert.equal(parseTimestamp('00:00:01,500'), 1500);
  assert.equal(parseTimestamp('00:00:01.500'), 1500);
  assert.equal(parseTimestamp('01:02:03,004'), 3_723_004);
  assert.equal(parseTimestamp('00:01:23'), 83_000);
  // A one-digit fraction means tenths, not thousandths.
  assert.equal(parseTimestamp('00:00:00,5'), 500);
  assert.equal(parseTimestamp('nonsense'), null);
});

test('formatFFmpegTime round-trips', () => {
  assert.equal(formatFFmpegTime(3_723_004), '01:02:03.004');
  assert.equal(formatFFmpegTime(0), '00:00:00.000');
});

test('parses a well-formed file', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'Drake walked into the courtroom.',
    '',
    '2',
    '00:00:02,000 --> 00:00:05,000',
    'Kendrick Lamar said nothing at all.',
    '',
  ].join('\n');

  const { cues, words, durationMs, warnings } = parseSubtitles(srt);

  assert.equal(cues.length, 2);
  assert.equal(warnings.length, 0);
  assert.equal(durationMs, 5000);
  assert.equal(cues[0].text, 'Drake walked into the courtroom.');
  assert.ok(words.length >= 10);
  assert.equal(words[0].norm, 'drake');
});

test('recovers from the mess real subtitle files contain', () => {
  const srt = [
    '﻿1',
    '00:00:00,000 --> 00:00:02,000',
    '<i>Drake</i> walked in.',
    '',
    '00:00:02,000 --> 00:00:04,000', // no sequence number
    '{\\an8}Then he sat',
    '',
    'down again.', // blank line inside the cue body
    '',
    '4',
    '00:00:06,000 --> 00:00:05,000', // reversed timing
    'Backwards cue.',
    '',
    '5',
    '00:00:08,000 --> 00:00:09,000',
    '&amp; entities &quot;too&quot;',
    '',
  ].join('\r\n');

  const { cues, warnings } = parseSubtitles(srt);

  assert.equal(cues.length, 4);
  assert.equal(cues[0].text, 'Drake walked in.', 'strips markup and the BOM');
  assert.equal(cues[1].text, 'Then he sat down again.', 'keeps text after an in-cue blank line');
  assert.ok(cues[2].endMs > cues[2].startMs, 'repairs the reversed cue');
  assert.equal(cues[3].text, '& entities "too"', 'decodes HTML entities');
  assert.ok(warnings.length > 0, 'reports what it repaired');
});

test('timeline is strictly monotonic even when cues overlap', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:05,000',
    'First line here.',
    '',
    '2',
    '00:00:03,000 --> 00:00:07,000',
    'Second line overlaps.',
    '',
  ].join('\n');

  const { cues, words } = parseSubtitles(srt);

  assert.equal(cues[0].endMs, cues[1].startMs, 'overlap is removed');
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].startMs >= words[i - 1].startMs, `word ${i} does not go backwards`);
    assert.ok(words[i].endMs > words[i].startMs, `word ${i} has positive duration`);
  }
});

test('word timing weights long words more than short ones', () => {
  const srt = ['1', '00:00:00,000 --> 00:00:10,000', 'a unprecedented', ''].join('\n');
  const { words } = parseSubtitles(srt);

  const short = words[0].endMs - words[0].startMs;
  const long = words[1].endMs - words[1].startMs;

  assert.equal(words.length, 2);
  assert.ok(long > short * 2, `"unprecedented" (${long}ms) should take far longer than "a" (${short}ms)`);
  assert.equal(words[0].startMs, 0);
  assert.equal(words[1].endMs, 10_000, 'the words exactly fill the cue');
});

test('sentence splitting keeps abbreviations intact', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:10,000',
    'Drake spoke. Then J. Cole replied! Was that all?',
    '',
  ].join('\n');

  const { words } = parseSubtitles(srt);
  const sentences = sentenceRanges(words);

  assert.equal(sentences.length, 3);
  assert.ok(sentences[1].text.includes('J. Cole'), 'does not split on the initial in "J. Cole"');
  assert.equal(sentences[0].startMs, 0);
  // Sentences tile the words with no gaps.
  for (let i = 1; i < sentences.length; i++) {
    assert.equal(sentences[i].from, sentences[i - 1].to);
  }
});

test('an empty file fails loudly rather than silently', () => {
  const { cues, warnings } = parseSubtitles('this is not a subtitle file');
  assert.equal(cues.length, 0);
  assert.ok(warnings[0].includes('No readable cues'));
});
