import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { DocumentService } from '../lib/documents.mjs';
import { executeAction } from '../lib/agent.mjs';
import { createApp } from '../server.mjs';
import { addressedText } from '../public/wake-word.js';

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'friday-documents-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('friday-documents-')); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
function fakeDocuments(root) {
  const service = new DocumentService({ projectRoot: root });
  service.worker = async request => request.operation === 'read' ? { text: '문서 본문', truncated: false } : { data: Buffer.from('PK-test-document').toString('base64') };
  return service;
}

test('documents cannot escape the workspace, access secret paths, or overwrite files', async t => {
  const root = await temporary(t); const service = fakeDocuments(root);
  const args = { path: '보고서.docx', title: '보고서', content: '한국어 본문' };
  await assert.rejects(service.prepare(root, { ...args, path: '../outside.docx' }), /밖/);
  await assert.rejects(service.prepare(root, { ...args, path: '.aws/secret.docx' }), /인증/);
  await assert.rejects(service.prepare(root, { ...args, path: 'macro.docm' }), /형식/);
  const prepared = await service.prepare(root, args);
  await fs.writeFile(path.join(root, args.path), 'created during review');
  await assert.rejects(service.commit(root, prepared), /같은 이름/);
  assert.equal(await fs.readFile(path.join(root, args.path), 'utf8'), 'created during review');
});

test('document approval reviews rendered content and denial never saves a file', async t => {
  const root = await temporary(t); const documents = fakeDocuments(root);
  const action = { name: 'create_document', arguments: { path: '계획.docx', title: '계획', content: '# 개요\n구체적인 본문' } };
  const common = { root, action, documents, signal: new AbortController().signal };
  const denied = await executeAction({ ...common, approve: async proposal => { assert.equal(proposal.content, action.arguments.content); assert.ok(proposal.bytes > 0); return false; } });
  assert.equal(denied.denied, true); await assert.rejects(fs.access(path.join(root, '계획.docx')));
  const saved = await executeAction({ ...common, approve: async () => true });
  assert.equal(saved.saved, true); assert.equal(saved.downloadable, true);
});

test('document HTTP download requires authentication and assistant preferences survive reset and restart', async t => {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, 'public')); await fs.writeFile(path.join(root, 'public', 'index.html'), '<meta name="app-token" content="__APP_TOKEN__">');
  const app = await createApp({ projectRoot: root, documentService: fakeDocuments(root) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => { app.cancel(); app.server.closeAllConnections(); app.server.close(resolve); }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { 'x-app-token': app.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/documents/download?path=x.docx`)).status, 403);
  const created = await fetch(`${base}/api/documents/create`, { method: 'POST', headers, body: JSON.stringify({ path: '한국어.docx', title: '한국어', content: '본문' }) });
  assert.equal(created.status, 200); assert.equal((await created.json()).saved, true);
  const download = await fetch(`${base}/api/documents/download?path=${encodeURIComponent('한국어.docx')}`, { headers });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-type'), /wordprocessingml/);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), 'PK-test-document');
  assert.equal((await fetch(`${base}/api/documents/download?path=../outside.docx`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/assistant`, { method: 'POST', headers, body: JSON.stringify({ name: '프라이데이', requireWakeWord: true }) })).status, 200);
  await fetch(`${base}/api/reset`, { method: 'POST', headers, body: '{}' });
  assert.equal((await (await fetch(`${base}/api/assistant`, { headers })).json()).name, '프라이데이');
  const restarted = await createApp({ projectRoot: root });
  assert.deepEqual(restarted.session.assistant, { name: '프라이데이', requireWakeWord: true }); restarted.cancel();
});

test('wake word only accepts an address at the start and strips it from the request', () => {
  assert.deepEqual(addressedText('프라이데이, 문서 만들어 줘'), { addressed: true, text: '문서 만들어 줘' });
  assert.deepEqual(addressedText('프 라 이 데 이 문서 만들어 줘'), { addressed: true, text: '문서 만들어 줘' });
  assert.equal(addressedText('다른 사람에게 하는 말').addressed, false);
  assert.equal(addressedText('이름은 프라이데이야').addressed, false);
  assert.equal(addressedText('Friday, hello').text, 'hello');
  assert.equal(addressedText('프라이데이').text, '');
  assert.equal(addressedText('그냥 말하기', { requireWakeWord: false }).addressed, true);
});
