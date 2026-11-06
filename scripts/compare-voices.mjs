import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalVoiceService } from '../lib/voice.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.LOCAL_MATE_VOICE_HOME || path.join(root, 'data', 'voice');
const samples = path.join(root, 'data', 'voice-samples');
const naturalSample = path.join(samples, 'natural-ryan.wav');
const text = '안녕하세요. 오늘은 어떤 작업을 함께 해 볼까요?';
const voice = new LocalVoiceService({ projectRoot: root, voiceHome: home });
const results = {};
try {
  await fs.mkdir(samples, { recursive: true });
  for (const engine of ['windows', 'neural', 'neural']) {
    const warm = engine === 'neural' && Boolean(results.neuralCold);
    const start = performance.now();
    const audio = await voice.speak(text, { engine });
    const elapsed = +((performance.now() - start) / 1000).toFixed(3);
    assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
    await fs.writeFile(engine === 'windows' ? path.join(samples, 'windows.wav') : naturalSample, audio);
    results[engine === 'windows' ? 'windows' : warm ? 'neuralWarm' : 'neuralCold'] = { seconds: elapsed, bytes: audio.length, ...(engine === 'neural' ? voice.neural.lastMetrics : {}) };
    console.log(JSON.stringify({ engine, warm, seconds: elapsed, bytes: audio.length }));
  }
  const audio = await fs.readFile(naturalSample);
  const transcript = await voice.transcribe(audio, { language: 'ko' });
  assert.match(transcript.text, /안녕하세요/);
  assert.match(transcript.text, /작업/);
  results.transcript = transcript.text;
  await fs.writeFile(path.join(samples, 'comparison.json'), JSON.stringify({ text, ...results }, null, 2));
  console.log(JSON.stringify({ verified: true, ...results }, null, 2));
} finally { voice.dispose(); }
