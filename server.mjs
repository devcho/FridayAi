import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getOllamaStatus, runAgent } from './lib/agent.mjs';
import { listDirectory, readFile, systemInfo } from './lib/workspace.mjs';
import { LocalVoiceService, AUDIO_TYPES, MAX_AUDIO_BYTES } from './lib/voice.mjs';
import { DocumentService, DOCUMENT_MIME } from './lib/documents.mjs';

export async function createApp({ projectRoot = path.dirname(fileURLToPath(import.meta.url)), workspace, ollamaUrl = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', modelCall, voiceService, documentService } = {}) {
  if (!ollamaUrl.startsWith('http')) ollamaUrl = `http://${ollamaUrl}`;
  const parsedOllama = new URL(ollamaUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedOllama.hostname) || parsedOllama.protocol !== 'http:') {
    throw new Error('Ollama 주소는 이 PC의 HTTP 루프백 주소여야 합니다.');
  }
  ollamaUrl = parsedOllama.origin;
  const dataDirectory = path.join(projectRoot, 'data');
  const voice = voiceService || new LocalVoiceService({ projectRoot });
  const documents = documentService || new DocumentService({ projectRoot });
  await fs.mkdir(dataDirectory, { recursive: true });
  const defaultWorkspace = path.join(projectRoot, 'workspace');
  await fs.mkdir(defaultWorkspace, { recursive: true });
  const welcome = path.join(defaultWorkspace, 'hello.js');
  await fs.writeFile(welcome, '// LOCAL MATE 테스트용 파일입니다.\nexport function add(a, b) {\n  return a + b;\n}\n\nconsole.log("2 + 3 =", add(2, 3));\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(path.join(dataDirectory, 'settings.json'), 'utf8')); } catch {}
  let selectedWorkspace;
  try { selectedWorkspace = await fs.realpath(workspace || settings.workspace || defaultWorkspace); }
  catch { selectedWorkspace = await fs.realpath(defaultWorkspace); }
  const assistantFile = path.join(dataDirectory, 'assistant.json');
  let assistant = { name: '프라이데이', requireWakeWord: true };
  try { const saved = JSON.parse(await fs.readFile(assistantFile, 'utf8')); if (typeof saved.name === 'string' && /^[가-힣A-Za-z0-9 ]{1,20}$/.test(saved.name)) assistant.name = saved.name; if (typeof saved.requireWakeWord === 'boolean') assistant.requireWakeWord = saved.requireWakeWord; } catch {}
  await fs.writeFile(assistantFile, JSON.stringify(assistant, null, 2), 'utf8');
  const session = { workspace: selectedWorkspace, model: settings.model || '', mode: 'agent', history: [], timeline: [], assistant };
  const token = crypto.randomBytes(32).toString('hex');
  let active = null;
  let pending = null;
  let sequence = 0;

  function record(event) {
    session.timeline.push({ ...event, sequence: ++sequence, time: new Date().toISOString() });
    if (session.timeline.length > 200) session.timeline.shift();
  }
  async function saveSettings() {
    await fs.writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ workspace: session.workspace, model: session.model }, null, 2), 'utf8');
  }
  function json(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('JSON 요청이 필요합니다.'), { status: 415 });
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw new Error('JSON 요청을 읽을 수 없습니다.'); }
  }
  async function audioBody(req) {
    const mime = (req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!AUDIO_TYPES.has(mime)) throw Object.assign(new Error('지원하는 오디오 파일을 사용해 주세요.'), { status: 415 });
    if (Number(req.headers['content-length']) > MAX_AUDIO_BYTES) { req.resume(); throw Object.assign(new Error('음성 파일은 8MB 이하여야 합니다.'), { status: 413 }); }
    const chunks = []; let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) { req.resume(); throw Object.assign(new Error('음성 파일은 8MB 이하여야 합니다.'), { status: 413 }); }
      chunks.push(chunk);
    }
    if (!size) throw new Error('오디오가 비어 있습니다.');
    return Buffer.concat(chunks);
  }
  async function voiceRequest(res, action) {
    const controller = new AbortController();
    const closed = () => { if (!res.writableEnded) controller.abort(new Error('음성 작업을 취소했습니다.')); };
    res.once('close', closed);
    try { return await action(controller.signal); } finally { res.off('close', closed); }
  }
  function assertIdle() { if (active) throw Object.assign(new Error('진행 중인 작업을 먼저 중지해 주세요.'), { status: 409 }); }
  async function status() {
    const ollama = await getOllamaStatus(ollamaUrl);
    if (!session.model && ollama.models.length) session.model = ollama.models.find(model => model.name === 'qwen3.5:9b')?.name || ollama.models.find(model => model.name === 'glm4:latest')?.name || ollama.models.find(model => model.size < 9e9)?.name || ollama.models[0].name;
    return { ...ollama, workspace: session.workspace, model: session.model, mode: session.mode, assistant: session.assistant, busy: Boolean(active), hardware: systemInfo() };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) return json(res, 403, { error: '허용되지 않은 호스트입니다.' });
      const url = new URL(req.url, `http://${host}`);
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return json(res, 403, { error: '다른 사이트의 요청은 허용되지 않습니다.' });
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-app-token'] !== token) return json(res, 403, { error: '앱 화면에서 다시 접속해 주세요.' });
        if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await status());
        if (req.method === 'GET' && url.pathname === '/api/voice/status') return json(res, 200, { ...await voice.status(), assistant: session.assistant });
        if (req.method === 'GET' && url.pathname === '/api/assistant') return json(res, 200, session.assistant);
        if (req.method === 'POST' && url.pathname === '/api/assistant') {
          const input = await body(req); assertIdle();
          if (typeof input.name !== 'string' || !/^[가-힣A-Za-z0-9 ]{1,20}$/.test(input.name) || !input.name.trim() || typeof input.requireWakeWord !== 'boolean') throw new Error('이름은 한글·영문·숫자 1~20자로 입력해 주세요.');
          const updated = { name: input.name.trim(), requireWakeWord: input.requireWakeWord };
          await fs.writeFile(assistantFile, JSON.stringify(updated, null, 2), 'utf8'); session.assistant = updated;
          return json(res, 200, updated);
        }
        if (req.method === 'GET' && url.pathname === '/api/documents/status') return json(res, 200, await documents.status());
        if (req.method === 'GET' && url.pathname === '/api/documents/read') return json(res, 200, await documents.read(session.workspace, url.searchParams.get('path')));
        if (req.method === 'GET' && url.pathname === '/api/documents/download') {
          const file = await documents.bytes(session.workspace, url.searchParams.get('path'));
          res.writeHead(200, { 'Content-Type': DOCUMENT_MIME[file.format], 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.filename))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(file.data);
        }
        if (req.method === 'POST' && url.pathname === '/api/documents/create') {
          const input = await body(req); assertIdle();
          const controller = new AbortController(); active = controller;
          const closed = () => { if (!res.writableEnded) controller.abort(new Error('문서 저장을 취소했습니다.')); }; res.once('close', closed);
          try { const prepared = await documents.prepare(session.workspace, input, controller.signal); const result = await documents.commit(session.workspace, prepared, path.join(dataDirectory, 'backups'), controller.signal); return json(res, 200, result); }
          finally { res.off('close', closed); if (active === controller) active = null; }
        }
        if (req.method === 'POST' && url.pathname === '/api/voice/warm') {
          await body(req); await voice.warm(); return json(res, 200, { ready: true, local: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/voice/warm-speech') {
          const input = await body(req); await voice.warmSpeech(input.engine); return json(res, 200, { ready: true, local: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/voice/transcribe') {
          const audio = await audioBody(req);
          const result = await voiceRequest(res, signal => voice.transcribe(audio, { signal, language: url.searchParams.get('language') || 'ko' }));
          return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/voice/speak') {
          const input = await body(req);
          if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1800) throw new Error('읽을 내용은 1~1800자로 입력해 주세요.');
          const audio = await voiceRequest(res, signal => voice.speak(input.text, { signal, engine: input.engine }));
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(audio); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { timeline: session.timeline, busy: Boolean(active), pending: pending ? { id: pending.id, proposal: pending.proposal } : null });
        if (req.method === 'GET' && url.pathname === '/api/files') return json(res, 200, { entries: await listDirectory(session.workspace, url.searchParams.get('path') || '.') });
        if (req.method === 'GET' && url.pathname === '/api/file') return json(res, 200, await readFile(session.workspace, url.searchParams.get('path')));
        if (req.method === 'POST' && url.pathname === '/api/workspace') {
          assertIdle();
          const input = await body(req);
          if (typeof input.path !== 'string' || !path.isAbsolute(input.path.trim())) throw new Error('작업 폴더의 전체 경로를 입력해 주세요.');
          const directory = await fs.realpath(input.path.trim());
          if (!(await fs.stat(directory)).isDirectory()) throw new Error('폴더 경로를 입력해 주세요.');
          session.workspace = directory;
          session.history = [];
          session.timeline = [];
          await saveSettings();
          return json(res, 200, { workspace: directory });
        }
        if (req.method === 'POST' && url.pathname === '/api/reset') {
          assertIdle(); session.history = []; session.timeline = [];
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/cancel') {
          await body(req);
          active?.abort(new Error('사용자가 작업을 중지했습니다.'));
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/shutdown') {
          await body(req); active?.abort(new Error('사용자가 서비스를 종료했습니다.'));
          json(res, 200, { ok: true });
          setTimeout(() => { voice.dispose?.(); documents.dispose?.(); server.closeAllConnections(); server.close(); }, 100).unref();
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/decision') {
          const input = await body(req);
          if (!pending || input.id !== pending.id) throw Object.assign(new Error('검토할 작업이 만료되었습니다.'), { status: 409 });
          if (typeof input.approved !== 'boolean') throw new Error('실행 여부가 필요합니다.');
          const current = pending; pending = null;
          current.resolve(input.approved);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          assertIdle();
          const input = await body(req);
          if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 12000) throw new Error('요청은 1~12,000자로 입력해 주세요.');
          const ollama = await getOllamaStatus(ollamaUrl);
          if (!ollama.connected) throw new Error('Ollama가 실행 중인지 확인해 주세요.');
          const model = input.model || session.model;
          if (!ollama.models.some(item => item.name === model)) throw new Error('설치된 로컬 모델을 선택해 주세요.');
          assertIdle();
          session.model = model;
          session.mode = input.mode === 'chat' ? 'chat' : 'agent';
          active = new AbortController();
          const controller = active;
          try { await saveSettings(); } catch (error) { active = null; throw error; }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          let finished = false;
          const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 10000);
          res.on('close', () => { if (!finished) controller.abort(new Error('화면 연결이 종료되었습니다.')); });
          const emit = event => { record(event); if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
          const approve = proposal => new Promise((resolve, reject) => {
            const id = crypto.randomUUID();
            const onAbort = () => { if (pending?.id === id) pending = null; reject(controller.signal.reason); };
            pending = { id, proposal, resolve: approved => { controller.signal.removeEventListener('abort', onAbort); resolve(approved); } };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) return onAbort();
            emit({ type: 'approval', id, proposal });
          });
          record({ type: 'user', content: input.prompt.trim() });
          try {
            await runAgent({ session, prompt: input.prompt.trim(), baseUrl: ollamaUrl, backupDirectory: path.join(dataDirectory, 'backups'), signal: controller.signal, emit, approve, modelCall, documents });
          } catch (error) {
            session.history.push({ role: 'user', content: 'APPLICATION_NOTICE: The previous run was interrupted or failed. Consult successful tool results before assuming any action completed.' });
            emit({ type: controller.signal.aborted ? 'cancelled' : 'error', message: controller.signal.aborted ? '작업을 중지했습니다.' : error.message });
          } finally {
            pending = null; active = null; finished = true; clearInterval(heartbeat);
            emit({ type: 'done' });
            res.end();
          }
          return;
        }
        return json(res, 404, { error: '요청한 기능을 찾을 수 없습니다.' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: '허용되지 않은 요청입니다.' });
      const assetMap = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/workspace-app.js': ['workspace-app.js', 'text/javascript; charset=utf-8'], '/voice.js': ['voice.js', 'text/javascript; charset=utf-8'], '/speech-text.js': ['speech-text.js', 'text/javascript; charset=utf-8'], '/wake-word.js': ['wake-word.js', 'text/javascript; charset=utf-8'], '/voice-activity.js': ['voice-activity.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      const asset = assetMap[url.pathname];
      if (!asset) return json(res, 404, { error: '파일을 찾을 수 없습니다.' });
      let content = await fs.readFile(path.join(projectRoot, 'public', asset[0]), 'utf8');
      if (url.pathname === '/') content = content.replace('__APP_TOKEN__', token);
      res.writeHead(200, {
        'Content-Type': asset[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(content);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 400, { error: error.message });
      else res.end();
    }
  });
  server.requestTimeout = 0;
  server.once('close', () => { voice.dispose?.(); documents.dispose?.(); });
  return { server, token, session, voice, documents, cancel: () => { active?.abort(new Error('서버가 종료되었습니다.')); voice.dispose?.(); documents.dispose?.(); } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT는 1024~65535 사이여야 합니다.');
  const app = await createApp({ workspace: process.env.LOCAL_AI_WORKSPACE });
  let fallback = false;
  app.server.on('error', async error => {
    if (error.code === 'EADDRINUSE' && port === 3210 && !fallback) {
      try {
        const html = await (await fetch('http://127.0.0.1:3210/', { signal: AbortSignal.timeout(3000) })).text();
        const token = html.match(/name="app-token" content="([^"]+)"/)?.[1];
        if (token) {
          const response = await fetch('http://127.0.0.1:3210/api/status', { headers: { 'x-app-token': token }, signal: AbortSignal.timeout(5000) });
          const previous = await response.json();
          if (response.ok && previous.hardware && !previous.assistant) { fallback = true; console.log('기존 버전은 유지하고 업데이트된 프라이데이를 별도 로컬 포트에서 실행합니다.'); app.server.listen(3211, '127.0.0.1'); return; }
        }
      } catch {}
    }
    console.error(error.code === 'EADDRINUSE' ? '프라이데이가 이미 실행 중이거나 포트를 사용 중입니다. 열린 사이트를 확인해 주세요.' : error.message); process.exitCode = 1;
  });
  app.server.on('listening', () => {
    const url = `http://127.0.0.1:${app.server.address().port}`;
    console.log(`\n  LOCAL MATE · 로컬 코딩 도우미\n  ${url}\n  작업 폴더: ${app.session.workspace}\n  종료: Ctrl+C\n`);
    if (process.argv.includes('--open') && process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => {}); child.unref();
    }
  });
  app.server.listen(port, '127.0.0.1');
  const stop = () => { app.cancel(); app.server.close(); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
