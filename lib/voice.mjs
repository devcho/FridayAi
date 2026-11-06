import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { NeuralSpeechService } from './neural-speech.mjs';

export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 60;
export const AUDIO_TYPES = new Set(['audio/webm', 'video/webm', 'audio/ogg', 'application/ogg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/vnd.wave', 'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/x-flac', 'audio/aac', 'application/octet-stream']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const exists = filename => fs.access(filename).then(() => true, () => false);

export class LocalVoiceService {
  constructor({ projectRoot, voiceHome = process.env.LOCAL_MATE_VOICE_HOME || path.join(projectRoot, 'data', 'voice'), spawnProcess = spawn, idleMs = 120000, neuralService } = {}) {
    this.projectRoot = projectRoot;
    this.voiceHome = voiceHome;
    this.python = path.join(voiceHome, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.model = path.join(voiceHome, 'models', 'small');
    this.spawnProcess = spawnProcess;
    this.idleMs = idleMs;
    this.pending = new Map();
    this.ttsChildren = new Set();
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.starting = null;
    this.idleTimer = null;
    this.voicesPromise = null;
    this.neural = neuralService || new NeuralSpeechService({ projectRoot, voiceHome, spawnProcess, idleMs });
  }

  async status() {
    const installed = await exists(this.python) && await exists(path.join(this.model, 'model.bin'));
    const voices = await this.getVoices().catch(() => []);
    const neuralInstalled = await this.neural.installed();
    const windowsAvailable = voices.some(voice => voice.language.startsWith('ko'));
    return { installed, local: true, recognition: 'Whisper small', speech: neuralInstalled ? '자연스러운 한국어 음성' : 'Windows 오프라인 음성',
      speechEngine: neuralInstalled ? 'neural' : 'windows', speechReady: this.neural.ready, speechChunkCharacters: 160,
      speechEngines: [{ id: 'neural', name: '자연스러운 음성 · 남성', available: neuralInstalled }, { id: 'windows', name: '기본 음성 · 빠름', available: windowsAvailable }],
      voices, canSpeak: neuralInstalled || windowsAvailable, ready: this.ready,
      busy: this.busy, maxAudioSeconds: MAX_AUDIO_SECONDS, maxAudioBytes: MAX_AUDIO_BYTES,
    };
  }

  async getVoices() {
    if (!this.voicesPromise) this.voicesPromise = this.windowsVoice({ operation: 'voices' }).then(buffer => {
      const result = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '').trim());
      return Array.isArray(result) ? result : [result];
    }).catch(error => { this.voicesPromise = null; throw error; });
    return this.voicesPromise;
  }

  async windowsVoice(request, { signal } = {}) {
    if (process.platform !== 'win32') throw failure('답변 읽기는 현재 Windows 오프라인 음성을 지원합니다.', 503);
    signal?.throwIfAborted();
    const script = await fs.readFile(path.join(this.projectRoot, 'scripts', 'windows_voice.ps1'), 'utf8');
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.ttsChildren.add(child);
      const chunks = []; let length = 0, stderr = '', timedOut = false, overflow = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => { length += chunk.length; if (length > 20 * 1024 * 1024) { overflow = true; child.kill(); } else chunks.push(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
      const clean = () => { clearTimeout(timer); this.ttsChildren.delete(child); signal?.removeEventListener('abort', abort); };
      child.once('error', error => { clean(); reject(failure(`Windows 음성을 시작할 수 없습니다: ${error.message}`, 503)); });
      child.once('close', code => {
        clean();
        if (signal?.aborted) return reject(signal.reason || failure('음성 재생을 취소했습니다.'));
        if (timedOut) return reject(failure('음성 생성 시간이 초과됐습니다. 읽을 내용을 줄여 주세요.', 504));
        if (overflow) return reject(failure('생성된 음성이 너무 깁니다.'));
        if (code !== 0) return reject(failure(stderr.trim() || 'Windows 음성 생성에 실패했습니다.', 503));
        resolve(Buffer.concat(chunks));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request), 'utf8');
      if (signal?.aborted) abort();
    });
  }

  async speak(text, options = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 1800) throw failure('읽을 내용은 1~1800자로 입력해 주세요.');
    const engine = options.engine || (await this.neural.installed() ? 'neural' : 'windows');
    if (!['neural', 'windows'].includes(engine)) throw failure('지원하지 않는 음성 종류입니다.');
    if (engine === 'neural') return this.neural.synthesize(text, options);
    const audio = await this.windowsVoice({ operation: 'speak', text: text.trim() }, options);
    if (audio.subarray(0, 4).toString() !== 'RIFF' || audio.subarray(8, 12).toString() !== 'WAVE') throw failure('음성 파일을 생성하지 못했습니다.', 503);
    return audio;
  }

  async warmSpeech(engine) {
    const selected = engine || (await this.neural.installed() ? 'neural' : 'windows');
    if (selected === 'neural') await this.neural.warm();
    else if (selected !== 'windows') throw failure('지원하지 않는 음성 종류입니다.');
  }

  async warm() {
    clearTimeout(this.idleTimer);
    if (this.ready && this.worker) { this.scheduleIdle(); return; }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!await exists(this.python) || !await exists(path.join(this.model, 'model.bin'))) throw failure('음성 인식 설치가 필요합니다. 프로젝트의 setup-voice.cmd를 실행해 주세요.', 503);
      await new Promise((resolve, reject) => {
        let stderr = '', completed = false;
        const child = this.spawnProcess(this.python, ['-u', path.join(this.projectRoot, 'scripts', 'voice_worker.py'), '--model', this.model, '--threads', String(Math.min(8, os.availableParallelism())), '--max-seconds', String(MAX_AUDIO_SECONDS)], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
        });
        this.worker = child;
        const timer = setTimeout(() => { child.kill(); if (!completed) { completed = true; reject(failure('음성 인식 모델 준비 시간이 초과됐습니다.', 504)); } }, 90000);
        child.stdin.on('error', () => {});
        child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
        const lines = readline.createInterface({ input: child.stdout });
        lines.on('line', line => {
          let event; try { event = JSON.parse(line); } catch { return; }
          if (event.event === 'ready' && !completed) { completed = true; clearTimeout(timer); this.ready = true; resolve(); this.scheduleIdle(); }
          else if (event.event === 'error' && !completed) { completed = true; clearTimeout(timer); reject(failure(`음성 인식을 준비하지 못했습니다: ${event.error}`, 503)); child.kill(); }
          else if (event.id && this.pending.has(event.id)) {
            const job = this.pending.get(event.id); this.pending.delete(event.id);
            if (event.error) job.reject(failure(event.error)); else job.resolve(event);
          }
        });
        const failed = error => {
          clearTimeout(timer);
          if (this.worker === child) { this.worker = null; this.ready = false; }
          if (!completed) { completed = true; reject(failure(`음성 인식을 시작하지 못했습니다: ${error.message || stderr}`, 503)); }
          for (const [id, job] of this.pending) { if (job.child === child) { job.reject(failure('음성 인식 작업이 중지됐습니다.', 503)); this.pending.delete(id); } }
          lines.close();
        };
        child.once('error', failed);
        child.once('close', code => failed(new Error(stderr.trim() || `worker exit ${code}`)));
      });
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (!this.busy) { this.idleTimer = setTimeout(() => this.stopWorker(), this.idleMs); this.idleTimer.unref(); }
  }

  async transcribe(audio, { language = 'ko', signal, assistantName = '프라이데이' } = {}) {
    if (!Buffer.isBuffer(audio) || !audio.length || audio.length > MAX_AUDIO_BYTES) throw failure('음성 파일은 1바이트~8MB 범위여야 합니다.', 413);
    if (!['ko', 'en', 'auto'].includes(language)) throw failure('지원하지 않는 음성 언어입니다.');
    if (this.busy) throw failure('다른 음성을 인식하고 있습니다. 잠시 후 다시 시도해 주세요.', 409);
    signal?.throwIfAborted(); this.busy = true; clearTimeout(this.idleTimer);
    let abort;
    try {
      abort = () => this.stopWorker();
      signal?.addEventListener('abort', abort, { once: true });
      await this.warm(); signal?.throwIfAborted();
      clearTimeout(this.idleTimer);
      const id = crypto.randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(failure('음성 인식 시간이 초과됐습니다.', 504)); this.stopWorker(); }, 120000);
        this.pending.set(id, { child: this.worker, resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        this.worker.stdin.write(`${JSON.stringify({ id, language, assistantName: String(assistantName).slice(0, 20), audio: audio.toString('base64') })}\n`, 'utf8', error => { if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); } });
      });
      return { text: result.text, language: result.language, duration: result.duration, local: true };
    } finally { signal?.removeEventListener('abort', abort); this.busy = false; this.scheduleIdle(); }
  }

  stopWorker() {
    clearTimeout(this.idleTimer);
    this.ready = false;
    const child = this.worker; this.worker = null;
    child?.kill();
  }

  dispose() { this.stopWorker(); this.neural.stop(); for (const child of this.ttsChildren) child.kill(); }
}
