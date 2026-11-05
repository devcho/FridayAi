import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalVoiceService } from '../lib/voice.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = new LocalVoiceService({ projectRoot });
try {
  const status = await service.status();
  assert.equal(status.installed, true, 'The local Whisper model must be installed');
  assert.equal(status.canSpeak, true, 'An offline Korean speech engine must be installed');
  const wave = await service.speak('안녕하세요. 지금은 음성 대화 기능을 확인합니다.');
  assert.equal(wave.subarray(0, 4).toString(), 'RIFF');
  await fs.mkdir(path.join(projectRoot, 'data'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'data', 'voice-check.wav'), wave);
  const result = await service.transcribe(wave, { language: 'ko' });
  assert.match(result.text, /음성/);
  assert.match(result.text, /대화/);
  assert.equal(result.local, true);
  console.log(JSON.stringify({ verified: true, voices: status.voices, audioBytes: wave.length, transcript: result.text, seconds: result.duration }, null, 2));
} finally { service.dispose(); }
