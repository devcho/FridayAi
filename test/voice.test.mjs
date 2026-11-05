import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { LocalVoiceService, MAX_AUDIO_BYTES } from '../lib/voice.mjs';
import { speechText, speechChunks } from '../public/speech-text.js';

test('spoken replies omit code bodies and keep readable link text', () => {
  const text = speechText('## 결과\n**완료**했습니다. [문서](https://example.com)\n```js\ndeleteEverything();\n```\n`add` 함수를 확인하세요.');
  assert.ok(text.includes('완료했습니다. 문서'));
  assert.ok(text.includes('코드 내용은 화면에서 확인'));
  assert.ok(!text.includes('deleteEverything'));
  assert.ok(!text.includes('https://'));
});

test('long replies are split below the local speech limit without losing content', () => {
  const text = ('한국어 음성을 테스트합니다. 😀 '.repeat(160)).trim();
  const chunks = speechChunks(text, 700);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 700));
  assert.equal(chunks.join(' ').replace(/\s/g, ''), speechText(text).replace(/\s/g, ''));
  const natural = speechChunks(text, 160);
  assert.ok(natural.every(chunk => chunk.length <= 160));
  assert.equal(natural.join(' ').replace(/\s/g, ''), speechText(text).replace(/\s/g, ''));
});

test('installed neural voice is the default and an explicit basic voice stays selectable', async () => {
  const calls = [];
  const neural = { installed: async () => true, synthesize: async text => { calls.push(['neural', text]); return Buffer.from('natural'); }, warm: async () => calls.push(['warm']), stop() {} };
  const voice = new LocalVoiceService({ projectRoot: path.resolve('.'), neuralService: neural });
  const wave = Buffer.alloc(44); wave.write('RIFF'); wave.write('WAVE', 8);
  voice.windowsVoice = async request => { calls.push(['windows', request.text]); return wave; };
  assert.equal((await voice.speak('안녕하세요')).toString(), 'natural');
  assert.deepEqual(await voice.speak('안녕하세요', { engine: 'windows' }), wave);
  await voice.warmSpeech('neural');
  await assert.rejects(voice.speak('안녕', { engine: 'remote' }), /지원하지/);
  await assert.rejects(voice.warmSpeech('remote'), /지원하지/);
  assert.deepEqual(calls, [['neural', '안녕하세요'], ['windows', '안녕하세요'], ['warm']]);
});

test('voice service rejects invalid speech and oversized recordings before starting workers', async () => {
  let spawned = 0;
  const voice = new LocalVoiceService({ projectRoot: path.resolve('.'), spawnProcess() { spawned++; throw new Error('must not spawn'); } });
  await assert.rejects(voice.speak(''), /1~1800/);
  await assert.rejects(voice.speak('x'.repeat(1801)), /1~1800/);
  await assert.rejects(voice.transcribe(Buffer.alloc(MAX_AUDIO_BYTES + 1)), /8MB/);
  await assert.rejects(voice.transcribe(Buffer.from('audio'), { language: 'invalid' }), /언어/);
  assert.equal(spawned, 0);
});

test('voice HTTP endpoints require authentication and pass audio through locally', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-mate-voice-http-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('local-mate-voice-http-'));
    return fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'public'));
  await fs.writeFile(path.join(directory, 'public', 'index.html'), '<meta name="app-token" content="__APP_TOKEN__">');
  const calls = [];
  const wave = Buffer.alloc(44); wave.write('RIFF'); wave.write('WAVE', 8);
  const voiceService = {
    async status() { return { installed: true, local: true, canSpeak: true }; },
    async warm() { calls.push('warm'); },
    async warmSpeech(engine) { calls.push({ warmSpeech: engine }); },
    async transcribe(audio, options) { calls.push({ audio: audio.toString(), language: options.language }); return { text: '안녕하세요', local: true }; },
    async speak(text, options) { calls.push({ text, engine: options.engine }); return wave; },
    dispose() {},
  };
  const app = await createApp({ projectRoot: directory, voiceService });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'x-app-token': app.token };
  assert.equal((await fetch(`${base}/api/voice/status`)).status, 403);
  assert.equal((await (await fetch(`${base}/api/voice/status`, { headers })).json()).local, true);
  assert.equal((await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: 'not audio' })).status, 415);
  assert.equal((await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: '' })).status, 400);
  assert.equal((await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: Buffer.alloc(MAX_AUDIO_BYTES + 1) })).status, 413);
  const transcript = await fetch(`${base}/api/voice/transcribe?language=ko`, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/webm;codecs=opus' }, body: 'recorded bytes' });
  assert.equal((await transcript.json()).text, '안녕하세요');
  const warmResponse = await fetch(`${base}/api/voice/warm-speech`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'neural' }) });
  assert.equal(warmResponse.status, 200);
  const response = await fetch(`${base}/api/voice/speak`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '답변입니다.', engine: 'neural' }) });
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  assert.deepEqual(calls, [{ audio: 'recorded bytes', language: 'ko' }, { warmSpeech: 'neural' }, { text: '답변입니다.', engine: 'neural' }]);
});
