/**
 * Generate the e2e fixtures.
 *
 * Every clip is a flat colour so a rendered frame can be traced back to its
 * source, and the clips deliberately disagree on resolution, frame rate and
 * duration - 640x480@24 next to 1080x1920@30 - because normalising that spread
 * is exactly what the renderer has to get right before concatenation is legal.
 *
 * The voiceover is 46.5s while the subtitles stop at 36s, so the "audio outruns
 * the subtitles" path is exercised on every run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MEDIA = path.join(import.meta.dirname, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });

const CLIPS = [
  ['drake_court_01.mp4', '0xE02020', '1280x720', 25, 6],
  ['drake_stage.mp4', '0xC01818', '1920x1080', 30, 9],
  ['kendrik_superbowl.mp4', '0x20A020', '640x480', 24, 3],
  ['umg_building.mp4', '0x2060E0', '1080x1920', 30, 12],
  ['faisal_desk.mp4', '0xE0C020', '1280x720', 30, 1],
  ['city_broll.mp4', '0x808080', '1280x720', 30, 20],
];

for (const [name, colour, size, rate, seconds] of CLIPS) {
  ff(['-f', 'lavfi', '-i', `color=c=${colour}:s=${size}:r=${rate}:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(MEDIA, name)]);
}

ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=46.5', '-c:a', 'aac', '-b:a', '192k', path.join(MEDIA, 'voice.m4a')]);

// The script names three characters, misspells Kendrick once, and refers back
// with pronouns so the carry-forward path is covered too.
const SENTENCES = [
  'Drake walked into the courtroom that morning without saying a single word to anyone.',
  'Kendrick Lamar had already released his answer to the world weeks earlier.',
  // Three characters inside one cue: the editor must cut twice inside this line.
  'Drake and Kendrick and Faisal all signed the very same agreement that afternoon.',
  'Universal Music Group pushed back hard against every claim in the filing.',
  'Faisal drafted the entire brief overnight without any help at all.',
  // A misspelling the matcher has to fold back into Kendrick.
  'Kendrik stayed completely silent while the reporters shouted their questions.',
  'The room went quiet and nobody moved for a long moment afterwards.',
  'Drake filed again and Universal Music Group answered within the hour.',
];

const stamp = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`;
};

let t = 0;
const cues = SENTENCES.map((text, i) => {
  const duration = text.split(/\s+/).length / 2.9; // ~2.9 words per second
  const cue = `${i + 1}\n${stamp(t)} --> ${stamp(t + duration)}\n${text}\n`;
  t += duration + 0.45; // a real pause between cues, so gaps must be absorbed
  return cue;
});

fs.writeFileSync(path.join(MEDIA, 'test.srt'), cues.join('\n'));

console.log(`Fixtures written to ${MEDIA}`);
console.log(`  ${CLIPS.length} clips, voiceover 46.5s, subtitles end at ${t.toFixed(2)}s`);
