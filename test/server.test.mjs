import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

test('HTTP app requires local authentication and waits for write approval', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-mate-http-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('local-mate-http-'));
    return fs.rm(directory, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(directory, 'public'));
  await fs.writeFile(path.join(directory, 'public', 'index.html'), '<meta name="app-token" content="__APP_TOKEN__">');
  const ollama = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'test:latest', size: 10 }] })); });
  ollama.listen(0, '127.0.0.1'); await once(ollama, 'listening');
  t.after(() => new Promise(resolve => { ollama.closeAllConnections(); ollama.close(resolve); }));
  let turn = 0;
  const app = await createApp({ projectRoot: directory, ollamaUrl: `http://127.0.0.1:${ollama.address().port}`,
    modelCall: async () => ++turn === 1
      ? { message: '파일을 생성하겠습니다.', actions: [{ name: 'write_file', arguments: { path: 'approved.js', content: 'console.log(42);' } }] }
      : { message: '저장했습니다.', actions: [] },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => { app.cancel(); return new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'x-app-token': app.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/status`)).status, 403);
  assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.match(await (await fetch(base)).text(), new RegExp(app.token));
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify({ model: 'test:latest', prompt: '파일 만들어줘' }) });
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = '', approval;
  while (!approval) {
    const chunk = await reader.read(); assert.equal(chunk.done, false);
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) { if (!line.trim()) continue; const event = JSON.parse(line); if (event.type === 'approval') approval = event; }
  }
  await assert.rejects(fs.access(path.join(app.session.workspace, 'approved.js')));
  const decision = await fetch(`${base}/api/decision`, { method: 'POST', headers, body: JSON.stringify({ id: approval.id, approved: true }) });
  assert.equal(decision.status, 200);
  let tail = buffer;
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += decoder.decode(chunk.value, { stream: true }); }
  assert.match(tail, /"saved":true/);
  assert.equal(await fs.readFile(path.join(app.session.workspace, 'approved.js'), 'utf8'), 'console.log(42);');
  assert.equal((await fs.readdir(path.join(directory, 'data', 'backups'))).length, 1);
});
