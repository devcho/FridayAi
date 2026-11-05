import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInside, readFile, listDirectory, prepareWrite, commitWrite, runCommand, searchFiles } from '../lib/workspace.mjs';
import { executeAction, runAgent } from '../lib/agent.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-mate-test-'));
  const root = path.join(directory, 'workspace');
  await fs.mkdir(root);
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('local-mate-test-'));
    return fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, root, backupDirectory: path.join(directory, 'backups') };
}

test('file tools reject path traversal and secret files', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=private');
  await fs.writeFile(path.join(root, 'main.js'), 'console.log("hello");');
  await assert.rejects(resolveInside(root, '../outside.txt'), /작업 폴더 밖/);
  await assert.rejects(prepareWrite(root, { path: '../outside.txt', content: 'x' }), /작업 폴더 밖/);
  await assert.rejects(readFile(root, '.env'), /인증 정보/);
  assert.deepEqual((await listDirectory(root)).map(entry => entry.name), ['main.js']);
});

test('file tools reject a directory link pointing outside the workspace', async t => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside'); await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Directory links unavailable'); throw error; }
  await assert.rejects(resolveInside(root, 'linked/new.txt', { allowMissing: true }), /링크/);
});

test('approved writes preserve a backup and reject stale proposals', async t => {
  const { root, backupDirectory } = await fixture(t);
  await fs.writeFile(path.join(root, '한글.txt'), '원본');
  const proposal = await prepareWrite(root, { path: '한글.txt', content: '수정본' });
  const result = await commitWrite(root, proposal, backupDirectory);
  assert.equal((await readFile(root, '한글.txt')).content, '수정본');
  const backup = JSON.parse(await fs.readFile(path.join(backupDirectory, result.backup), 'utf8'));
  assert.equal(backup.before, '원본');
  await assert.rejects(commitWrite(root, proposal, backupDirectory), /파일이 바뀌었습니다/);
  const newFile = await prepareWrite(root, { path: 'src/new.js', content: 'export const value = 1;' });
  await commitWrite(root, newFile, backupDirectory);
  assert.equal((await readFile(root, 'src/new.js')).content, 'export const value = 1;');
});

test('denied file and shell actions never execute', async t => {
  const { root, backupDirectory } = await fixture(t);
  const options = { root, backupDirectory, signal: new AbortController().signal, approve: async () => false };
  assert.equal((await executeAction({ ...options, action: { name: 'write_file', arguments: { path: 'denied.txt', content: 'no' } } })).denied, true);
  assert.equal((await executeAction({ ...options, action: { name: 'run_command', arguments: { command: 'node -e "require(\'fs\').writeFileSync(\'denied.txt\', \'no\')"' } } })).denied, true);
  await assert.rejects(fs.access(path.join(root, 'denied.txt')));
});

test('agent cannot overwrite an existing file it has not fully read', async t => {
  const { root, backupDirectory } = await fixture(t);
  await fs.writeFile(path.join(root, 'existing.js'), 'original');
  let approvals = 0;
  await assert.rejects(executeAction({ root, backupDirectory, readFiles: new Map(),
    signal: new AbortController().signal, approve: async () => { approvals++; return true; },
    action: { name: 'write_file', arguments: { path: 'existing.js', content: 'replacement' } },
  }), /全|전체/);
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(path.join(root, 'existing.js'), 'utf8'), 'original');
});

test('literal source search skips secrets and identifies line numbers', async t => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'main.js'), 'first\nconst target = 5;\n');
  await fs.writeFile(path.join(root, '.env'), 'target=secret');
  const result = await searchFiles(root, 'target');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].line, 2);
  assert.equal(result.results[0].path, 'main.js');
});

test('PowerShell command runs from the workspace and captures exit status', async t => {
  const { root } = await fixture(t);
  const result = await runCommand(root, 'node -e "console.log(process.cwd()); console.log(2 + 3); process.exit(3)"');
  assert.equal(result.exitCode, 3);
  assert.ok(result.stdout.includes(root));
  assert.ok(result.stdout.includes('5'));
});

test('PowerShell preserves Korean output', async t => {
  const { root } = await fixture(t);
  const result = await runCommand(root, process.platform === 'win32' ? "Write-Output '한국어 출력 확인'" : "printf '한국어 출력 확인\\n'");
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('한국어 출력 확인'));
});

test('stopping a command terminates it and reports cancellation', async t => {
  const { root } = await fixture(t);
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 400);
  t.after(() => clearTimeout(timer));
  const result = await runCommand(root, process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.ok(performance.now() - started < 4000, 'Cancellation must stop the process promptly');
});

test('agent continues after tool results and respects denied writes', async t => {
  const { root, backupDirectory } = await fixture(t);
  const session = { workspace: root, model: 'test', mode: 'agent', history: [] };
  const events = [];
  let turn = 0;
  const replies = [
    { message: '폴더를 살펴보겠습니다.', actions: [{ name: 'list_directory', arguments: { path: '.' } }] },
    { message: '파일을 만들겠습니다.', actions: [{ name: 'write_file', arguments: { path: 'new.js', content: 'hello' } }] },
    { message: '요청에 따라 파일을 만들지 않았습니다.', actions: [] },
  ];
  await runAgent({ session, prompt: '파일 만들어줘', baseUrl: 'http://unused', backupDirectory,
    signal: new AbortController().signal, emit: event => events.push(event), approve: async () => false,
    modelCall: async () => replies[turn++],
  });
  assert.equal(turn, 3);
  assert.ok(events.some(event => event.type === 'tool_result' && event.result.denied));
  await assert.rejects(fs.access(path.join(root, 'new.js')));
});

test('chat mode never executes a tool even if the model requests one', async t => {
  const { root, backupDirectory } = await fixture(t);
  let approvals = 0;
  await runAgent({ session: { workspace: root, model: 'test', mode: 'chat', history: [] }, prompt: '파일 만들어줘',
    baseUrl: 'http://unused', backupDirectory, signal: new AbortController().signal, emit: () => {},
    approve: async () => { approvals++; return true; },
    modelCall: async () => ({ message: '파일 생성', actions: [{ name: 'write_file', arguments: { path: 'no.txt', content: 'no' } }] }),
  });
  assert.equal(approvals, 0);
  await assert.rejects(fs.access(path.join(root, 'no.txt')));
});
