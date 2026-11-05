import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const fail = (message, status = 503) => Object.assign(new Error(message), { status });
const exists = filename => fs.access(filename).then(() => true, () => false);

export class NeuralSpeechService {
  constructor({ projectRoot, voiceHome, spawnProcess = spawn, idleMs = 120000, startupMs = 150000, generationMs = 120000 } = {}) {
    this.projectRoot = projectRoot;
    this.voiceHome = voiceHome;
    this.python = path.join(voiceHome, '.tts-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.model = path.join(voiceHome, 'models', 'qwen3-tts-small');
    this.spawnProcess = spawnProcess;
    this.idleMs = idleMs; this.startupMs = startupMs; this.generationMs = generationMs;
    this.worker = null; this.starting = null; this.ready = false; this.busy = false;
    this.pending = new Map(); this.idleTimer = null; this.lastMetrics = null; this.loadSeconds = null;
  }

  async installed() {
    return await exists(this.python) && await exists(path.join(this.voiceHome, 'natural-runtime.json')) && await exists(path.join(this.model, 'model.safetensors')) && await exists(path.join(this.model, 'speech_tokenizer', 'model.safetensors'));
  }

  scheduleIdle() {
    clearTimeout(this.idleTimer);
    if (this.ready && !this.busy) { this.idleTimer = setTimeout(() => this.stop(), this.idleMs); this.idleTimer.unref(); }
  }

  async warm() {
    clearTimeout(this.idleTimer);
    if (this.ready && this.worker) { this.scheduleIdle(); return; }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!await this.installed()) throw fail('자연 음성 설치가 필요합니다. setup-natural-voice.cmd를 실행하거나 기본 음성을 선택해 주세요.');
      await new Promise((resolve, reject) => {
        const child = this.spawnProcess(this.python, ['-u', path.join(this.projectRoot, 'scripts', 'tts_worker.py'), '--model', this.model], {
          windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
        });
        this.worker = child;
        let completed = false, stderr = '';
        const timer = setTimeout(() => { if (!completed) { completed = true; reject(fail('자연 음성 준비 시간이 초과됐습니다. 기본 음성을 선택해 주세요.', 504)); } child.kill(); }, this.startupMs);
        const lines = readline.createInterface({ input: child.stdout });
        child.stdin.on('error', () => {});
        child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2500); });
        const failed = error => {
          clearTimeout(timer);
          if (this.worker === child) { this.worker = null; this.ready = false; }
          if (!completed) { completed = true; reject(fail(`자연 음성을 시작하지 못했습니다: ${error.message || stderr}`)); }
          for (const [id, job] of this.pending) if (job.child === child) { job.reject(fail('자연 음성 생성을 중지했습니다.')); this.pending.delete(id); }
          lines.close();
        };
        lines.on('line', line => {
          let event; try { event = JSON.parse(line); } catch { return; }
          if (event.event === 'ready' && !completed) {
            clearTimeout(timer); completed = true; this.ready = true; this.loadSeconds = event.loadSeconds; resolve(); this.scheduleIdle();
          } else if (event.event === 'error' && !completed) {
            clearTimeout(timer); completed = true; reject(fail(`자연 음성을 준비하지 못했습니다: ${event.error}`)); child.kill();
          } else if (event.id && this.pending.has(event.id)) {
            const job = this.pending.get(event.id); this.pending.delete(event.id);
            if (event.error) job.reject(fail(event.error, 400)); else job.resolve(event);
          }
        });
        child.once('error', failed);
        child.once('close', code => failed(new Error(stderr.trim() || `speech worker exit ${code}`)));
      });
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  async synthesize(text, { signal } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 240) throw fail('자연 음성은 1~240자로 나눠 주세요.', 400);
    if (this.busy) throw fail('다른 답변의 음성을 만들고 있습니다. 잠시 후 다시 시도해 주세요.', 409);
    signal?.throwIfAborted(); this.busy = true; clearTimeout(this.idleTimer);
    const abort = () => this.stop();
    try {
      signal?.addEventListener('abort', abort, { once: true });
      await this.warm(); signal?.throwIfAborted(); clearTimeout(this.idleTimer);
      const id = crypto.randomUUID();
      const event = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(fail('자연 음성 생성 시간이 초과됐습니다. 문장을 짧게 나누거나 기본 음성을 선택해 주세요.', 504)); this.stop(); }, this.generationMs);
        this.pending.set(id, { child: this.worker, resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        this.worker.stdin.write(`${JSON.stringify({ id, text: text.trim() })}\n`, 'utf8', error => { if (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); } });
      });
      const audio = Buffer.from(event.audio || '', 'base64');
      if (audio.length > 10 * 1024 * 1024 || audio.subarray(0, 4).toString() !== 'RIFF' || audio.subarray(8, 12).toString() !== 'WAVE') throw fail('자연 음성 파일이 올바르지 않습니다.');
      this.lastMetrics = { ...event.metrics, loadSeconds: this.loadSeconds };
      return audio;
    } finally { signal?.removeEventListener('abort', abort); this.busy = false; this.scheduleIdle(); }
  }

  stop() { clearTimeout(this.idleTimer); const child = this.worker; this.worker = null; this.ready = false; child?.kill(); }
}
