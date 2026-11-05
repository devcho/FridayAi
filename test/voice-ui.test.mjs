import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceChat } from '../public/voice.js';

function environment(t, { permission, natural = false, assistant, utterance = '안녕하세요', webAudio = false, autoListen = false, speechError = false, warmTimers } = {}) {
  class Element {
    constructor() { this.hidden = false; this.checked = true; this.value = 'ko'; this.textContent = ''; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.files = []; this.children = []; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    close() {}
    replaceChildren() {}
    async click() { return this.listeners.click?.(); }
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('#voice-status-row').hidden = true;
  element('#prompt').placeholder = '무엇을 함께 만들까요?';
  element('#prompt').value = '';
  element('#voice-engine').value = 'windows';
  element('#voice-auto-listen').checked = autoListen;
  const track = { stops: 0, stop() { this.stops++; } };
  const stream = { getTracks: () => [track] };
  const recorders = [];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['a'.repeat(500)], { type: 'audio/webm' }) }); this.onstop?.(); }); }
  }
  const saved = new Map();
  function replace(name, value) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
  if (warmTimers) {
    const interval = globalThis.setInterval, clear = globalThis.clearInterval;
    replace('setInterval', (callback, ms, ...args) => {
      if (ms !== 60000) return interval(callback, ms, ...args);
      const timer = { callback, cleared: false }; warmTimers.push(timer); return timer;
    });
    replace('clearInterval', timer => { if (warmTimers.includes(timer)) timer.cleared = true; else clear(timer); });
  }
  const requests = [], transcripts = [], notices = []; let sends = 0;
  replace('document', { querySelector: element, createElement: () => new Element() });
  const audioLog = [];
  class Context {
    constructor() { this.state = 'suspended'; this.destination = {}; }
    resume() { this.state = 'running'; audioLog.push('resume'); return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData() { audioLog.push('decode'); return Promise.resolve({}); }
    createBufferSource() { const source = { connect() {}, disconnect() {}, stop() {}, start() { audioLog.push('start'); queueMicrotask(() => source.onended?.()); } }; return source; }
    createAnalyser() { return { fftSize: 256, getByteTimeDomainData(array) { array.fill(128); } }; }
    createMediaStreamSource() { return { connect() {} }; }
  }
  replace('window', { MediaRecorder: Recorder, ...(webAudio ? { AudioContext: Context } : {}), addEventListener() {} });
  replace('MediaRecorder', Recorder);
  replace('Audio', class {
    play() { audioLog.push('html'); queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
    pause() {}
    removeAttribute() {}
    load() {}
  });
  replace('navigator', { mediaDevices: { getUserMedia: () => permission || Promise.resolve(stream) } });
  replace('fetch', async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/status')) return Response.json({ installed: true, canSpeak: true, assistant, speechEngine: natural ? 'neural' : 'windows', speechEngines: [{ id: 'neural', available: natural, name: '자연스러운 음성' }, { id: 'windows', available: true, name: '기본 음성' }], maxAudioSeconds: 60, maxAudioBytes: 8 * 1024 * 1024 });
    if (url.includes('/transcribe')) return Response.json({ text: Array.isArray(utterance) ? utterance.shift() : utterance, local: true });
    if (url.endsWith('/speak') && speechError) return Response.json({ error: '음성 생성 실패' }, { status: 503 });
    return Response.json({ ready: true });
  });
  const voice = createVoiceChat({ token: 'test', notify: message => notices.push(message), onTranscript: text => { transcripts.push(text); element('#prompt').value = text; }, onSend: () => { sends++; } });
  t.after(async () => {
    voice.stopAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  });
  return { voice, element, track, stream, recorders, requests, transcripts, notices, audioLog, get sends() { return sends; } };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function begin(env) { await env.voice.ready; await env.element('#voice-toggle').click(); }
async function finish(env) { await env.element('#voice-submit').click(); await flush(); await flush(); }

test('voice initializes quietly and never starts the microphone for typed conversation', async t => {
  const env = environment(t, { natural: true }); await env.voice.ready;
  assert.equal(env.recorders.length, 0);
  assert.equal(env.element('#voice-status-row').hidden, true);
  assert.equal(env.element('#voice-toggle').attributes['aria-pressed'], 'false');
  env.voice.maybeSpeak('일반 텍스트 답변'); await flush();
  assert.equal(env.requests.some(request => request.url.endsWith('/speak')), false);
  assert.equal(env.requests.some(request => request.url.endsWith('/warm-speech')), false);
});

test('automatic wake listener starts after permission and answers to the name only', async t => {
  const env = environment(t, { autoListen: true, utterance: '프라이 데이' });
  await env.voice.ready; await flush();
  assert.equal(env.recorders.length, 1);
  assert.equal(env.element('#voice-toggle').attributes['aria-pressed'], 'true');
  await finish(env); await flush(); await flush(); await wait(150);
  const speech = env.requests.filter(request => request.url.endsWith('/speak')).map(request => JSON.parse(request.options.body));
  assert.equal(speech.length, 1);
  assert.equal(speech[0].text, '네, 말씀하세요.');
  assert.ok(env.recorders.length >= 2);
  assert.equal(env.recorders.at(-1).state, 'recording');
});

test('automatic wake listener ignores unrelated speech and keeps waiting', async t => {
  const env = environment(t, { autoListen: true, assistant: { name: '프라이데이', requireWakeWord: true }, utterance: '다른 말입니다' });
  await env.voice.ready; await flush();
  await finish(env); await wait(150);
  assert.equal(env.sends, 0);
  assert.equal(env.requests.some(request => request.url.endsWith('/speak')), false);
  assert.ok(env.recorders.length >= 2);
  assert.match(env.element('#voice-status').textContent, /듣고|호출/);
});

test('a name-only wake accepts one following request without repeating the name, then requires a new wake', async t => {
  const env = environment(t, { autoListen: true, assistant: { name: '프라이데이', requireWakeWord: true }, utterance: ['프라이데이', '오늘 할 일을 정리해 줘', '다른 사람과 하는 말'] });
  await env.voice.ready; await flush(); await finish(env); await wait(150);
  await finish(env);
  assert.equal(env.sends, 1);
  assert.deepEqual(env.transcripts, ['오늘 할 일을 정리해 줘']);
  env.voice.maybeSpeak('오늘 할 일입니다.'); await flush(); await flush(); await wait(150);
  await finish(env); await wait(150);
  assert.equal(env.sends, 1);
});

test('the microphone button also acknowledges a name-only call and accepts the following request', async t => {
  const env = environment(t, { assistant: { name: '프라이데이', requireWakeWord: true }, utterance: ['프라이데이', '안녕하세요'] });
  await begin(env); await finish(env); await wait(150);
  assert.ok(env.requests.some(request => request.url.endsWith('/speak')));
  await finish(env);
  assert.equal(env.sends, 1);
  assert.deepEqual(env.transcripts, ['안녕하세요']);
});

test('silence after a name-only call expires the permission to send a request without a wake word', async t => {
  const env = environment(t, { webAudio: true, assistant: { name: '프라이데이', requireWakeWord: true }, utterance: ['프라이데이', '다른 사람과 하는 말'] });
  await begin(env); await finish(env); await wait(150);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await wait(150); now += 16000; await wait(300);
  await finish(env);
  assert.equal(env.sends, 0);
  assert.deepEqual(env.transcripts, []);
});

test('name-only acknowledgement uses the available fast voice while answers keep the selected natural voice', async t => {
  const env = environment(t, { autoListen: true, natural: true, utterance: '프라이데이' });
  await env.voice.ready; await flush(); await finish(env); await flush();
  const speech = env.requests.filter(request => request.url.endsWith('/speak')).map(request => JSON.parse(request.options.body));
  assert.equal(speech[0].engine, 'windows');
  assert.equal(env.element('#voice-engine').value, 'neural');
});

test('a speech failure leaves a restartable microphone instead of an active but stalled session', async t => {
  const env = environment(t, { autoListen: true, utterance: '프라이데이', speechError: true });
  await env.voice.ready; await flush(); await finish(env); await flush();
  assert.equal(env.element('#voice-toggle').attributes['aria-pressed'], 'false');
  assert.match(env.element('#voice-status').textContent, /음성 생성 실패/);
});

test('automatic listening asks for a click when Web Audio is suspended instead of discarding every recording as silence', async t => {
  const env = environment(t, { autoListen: true, webAudio: true });
  await env.voice.ready; await flush();
  assert.equal(env.element('#voice-toggle').attributes['aria-pressed'], 'false');
  assert.equal(env.recorders.length, 0);
  assert.ok(env.track.stops > 0);
  assert.match(env.element('#voice-status').textContent, /마이크 버튼/);
  await env.element('#voice-toggle').click();
  assert.equal(env.recorders.length, 1);
  assert.equal(env.recorders[0].state, 'recording');
});

test('reading an existing answer stops microphone capture before playing it', async t => {
  const env = environment(t); await begin(env);
  const row = env.element('#reply'); env.voice.attachReply(row, '이전 답변입니다.');
  await row.children[0].children[0].click(); await flush(); await flush();
  assert.ok(env.track.stops > 0);
  assert.equal(env.recorders[0].state, 'inactive');
  assert.equal(env.requests.some(request => request.url.includes('/transcribe')), false);
});

test('the composer microphone starts input directly and a second click releases it', async t => {
  const env = environment(t, { natural: true }); await begin(env);
  assert.equal(env.recorders[0].state, 'recording');
  assert.equal(env.element('#chat-form').dataset.voiceState, 'recording');
  assert.equal(env.element('#voice-toggle').attributes['aria-label'], '음성 입력 종료');
  assert.equal(env.element('#voice-status-row').hidden, false);
  assert.match(env.element('#prompt').placeholder, /듣고/);
  assert.ok(env.requests.some(request => request.url.endsWith('/warm-speech')));
  await env.element('#voice-toggle').click(); await flush();
  assert.ok(env.track.stops > 0); assert.equal(env.sends, 0);
  assert.equal(env.element('#voice-toggle').attributes['aria-label'], '음성 입력 시작');
  assert.equal(env.element('#prompt').placeholder, '무엇을 함께 만들까요?');
});

test('voice conversation reads natural replies in bounded chunks through the selected engine', async t => {
  const env = environment(t, { natural: true }); await begin(env);
  env.voice.beforeSend(); env.voice.setBusy(true);
  env.voice.maybeSpeak('안녕하세요. 긴 답변을 자연스럽게 읽습니다. '.repeat(20));
  await flush(); await flush();
  const requests = env.requests.filter(request => request.url.endsWith('/speak')).map(request => JSON.parse(request.options.body));
  assert.ok(requests.length > 1);
  assert.ok(requests[0].text.length <= 48);
  assert.ok(requests.every(request => request.engine === 'neural' && request.text.length <= 160));
  assert.match(env.element('#voice-status').textContent, /읽기를 마쳤/);
  assert.equal(env.notices.length, 0);
});

test('manual reply reading unlocks Web Audio without requesting a microphone', async t => {
  const env = environment(t, { natural: true, webAudio: true }); await env.voice.ready;
  const row = env.element('#reply'); env.voice.attachReply(row, '안녕하세요. 프라이데이입니다.');
  await row.children[0].children[0].click(); await flush(); await flush();
  assert.ok(env.audioLog.includes('resume')); assert.ok(env.audioLog.includes('decode')); assert.ok(env.audioLog.includes('start'));
  assert.ok(!env.audioLog.includes('html')); assert.equal(env.recorders.length, 0);
});

test('ending continuous conversation releases the microphone and prevents another recording', async t => {
  const env = environment(t); await begin(env);
  assert.equal(env.element('#voice-end').hidden, false);
  await env.element('#voice-end').click(); await flush();
  assert.ok(env.track.stops > 0); assert.equal(env.element('#voice-end').hidden, true); assert.equal(env.sends, 0);
});

test('cancelled microphone recordings release tracks and never transcribe', async t => {
  const env = environment(t); await begin(env);
  await env.element('#voice-cancel').click(); await flush();
  assert.ok(env.track.stops > 0);
  assert.equal(env.requests.some(request => request.url.includes('/transcribe')), false);
});

test('speech without the saved wake word never reaches chat', async t => {
  const env = environment(t, { assistant: { name: '프라이데이', requireWakeWord: true } });
  await begin(env); await finish(env);
  assert.equal(env.sends, 0); assert.deepEqual(env.transcripts, []);
  assert.match(env.element('#voice-status').textContent, /전송하지/);
});

test('rejected recognized speech preserves the reason instead of listening again', async t => {
  const env = environment(t, { assistant: { name: '프라이데이', requireWakeWord: true } });
  await begin(env); await finish(env);
  await wait(350);
  assert.equal(env.recorders.length, 1);
  assert.equal(env.sends, 0);
  assert.match(env.element('#voice-status').textContent, /전송하지/);
});

test('speech addressed to Friday inserts the actual request into the same composer', async t => {
  const env = environment(t, { assistant: { name: '프라이데이', requireWakeWord: true }, utterance: '프라이데이, 한글 문서 만들어 줘' });
  await begin(env); await finish(env);
  assert.equal(env.sends, 1); assert.deepEqual(env.transcripts, ['한글 문서 만들어 줘']);
  assert.equal(env.element('#prompt').value, '한글 문서 만들어 줘');
});

test('finished recordings release the microphone and auto-send once', async t => {
  const env = environment(t); await begin(env); await finish(env);
  assert.deepEqual(env.transcripts, ['안녕하세요']); assert.equal(env.sends, 1);
  assert.ok(env.track.stops > 0);
  assert.equal(env.requests.filter(request => request.url.includes('/transcribe')).length, 1);
});

test('voice button keeps the conversation listening until the user stops it', async t => {
  const env = environment(t, { natural: true });
  env.element('#voice-continuous').checked = false;
  await begin(env); await finish(env);
  assert.equal(env.sends, 1);
  env.voice.maybeSpeak('음성 명령의 답변입니다.');
  await flush(); await flush(); await wait(150);
  const requests = env.requests.filter(request => request.url.endsWith('/speak')).map(request => JSON.parse(request.options.body));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].engine, 'neural');
  assert.equal(env.element('#voice-continuous').checked, true);
  assert.equal(env.recorders.length, 2);
  assert.equal(env.recorders[1].state, 'recording');
  assert.match(env.element('#voice-status').textContent, /듣고/);
});

test('review-before-send mode keeps recognized speech in the composer', async t => {
  const env = environment(t); env.element('#voice-auto-send').checked = false;
  await begin(env); await finish(env);
  assert.equal(env.element('#prompt').value, '안녕하세요'); assert.equal(env.sends, 0);
});

test('turning off the composer microphone during permission request releases a later stream', async t => {
  let release;
  const env = environment(t, { permission: new Promise(resolve => { release = resolve; }) });
  await env.voice.ready;
  const starting = env.element('#voice-toggle').click();
  await env.element('#voice-toggle').click(); release(env.stream); await starting;
  assert.ok(env.track.stops > 0); assert.equal(env.recorders.length, 0);
  assert.equal(env.element('#voice-toggle').attributes['aria-pressed'], 'false');
});

test('natural model stays warm only during active voice replies and heartbeat is cleared at stop', async t => {
  const warmTimers = [];
  const env = environment(t, { natural: true, warmTimers });
  await begin(env); await flush();
  const warms = () => env.requests.filter(request => request.url.endsWith('/warm-speech')).length;
  const before = warms();
  assert.equal(warmTimers.length, 1);
  warmTimers[0].callback(); await flush();
  assert.equal(warms(), before + 1);
  env.element('#voice-engine').value = 'windows';
  warmTimers[0].callback(); await flush();
  assert.equal(warms(), before + 1);
  env.element('#voice-engine').value = 'neural';
  env.element('#voice-auto-read').checked = false;
  warmTimers[0].callback(); await flush();
  assert.equal(warms(), before + 1);
  env.voice.stopAll();
  assert.equal(warmTimers[0].cleared, true);
  warmTimers[0].callback(); await flush();
  assert.equal(warms(), before + 1);
});

test('wake rejection shows recognized text and a known alias can submit normally', async t => {
  const env = environment(t, { autoListen: true, utterance: ['후라이팬 꺼내줘', '후라이데이, 오늘 날씨 알려줘'] });
  await env.voice.ready; await flush();
  await finish(env);
  assert.match(env.element('#voice-status').textContent, /후라이팬 꺼내줘/);
  assert.equal(env.sends, 0);
  await wait(150); await finish(env);
  assert.equal(env.sends, 1);
  assert.deepEqual(env.transcripts, ['오늘 날씨 알려줘']);
});
