// ElevenLabs voice-over for the pitch: one MP3 per slide, plus pitch.mp3 (all joined).
// Usage: ELEVENLABS_API_KEY=... [VOICE_ID=...] node tts.mjs      |  node tts.mjs --voices
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('Set ELEVENLABS_API_KEY first.'); process.exit(1); }
const api = 'https://api.elevenlabs.io/v1';
const headers = { 'xi-api-key': key, 'content-type': 'application/json' };

if (process.argv.includes('--voices')) {
  const { voices } = await (await fetch(`${api}/voices`, { headers })).json();
  for (const v of voices) console.log(v.voice_id, '·', v.name, '·', v.category, '·', v.labels?.accent ?? '', v.labels?.gender ?? '');
  process.exit(0);
}

const voice = process.env.VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel (stock)
const sections = JSON.parse(readFileSync(new URL('./sections.json', import.meta.url)));
const files = [];
let prev = null;
for (const s of sections) {
  const res = await fetch(`${api}/text-to-speech/${voice}?output_format=mp3_44100_128`, {
    method: 'POST', headers,
    body: JSON.stringify({
      text: s.text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true },
      ...(prev ? { previous_text: prev } : {}),
    }),
  });
  if (!res.ok) { console.error(s.id, res.status, await res.text()); process.exit(1); }
  const file = `${s.id}.mp3`;
  writeFileSync(new URL(file, import.meta.url), Buffer.from(await res.arrayBuffer()));
  files.push(file); prev = s.text;
  console.log('wrote', file);
}

// Join with a 0.6s pause between slides.
const dir = new URL('.', import.meta.url).pathname;
const inputs = files.flatMap(f => ['-i', f]);
const parts = files.map((_, i) => `[${i}:a]apad=pad_dur=0.6[a${i}]`).join(';');
const concat = files.map((_, i) => `[a${i}]`).join('') + `concat=n=${files.length}:v=0:a=1[out]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${parts};${concat}`, '-map', '[out]', 'pitch.mp3'], { cwd: dir });
const secs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'pitch.mp3'], { cwd: dir }).toString().trim();
console.log(`wrote pitch.mp3 (${Number(secs).toFixed(1)}s)`);
