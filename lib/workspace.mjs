import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const HIDDEN = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next']);
const SECRET_NAME = /^(?:\.env(?:\..+)?|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|credentials|credentials\.json|.*\.(?:pem|key|pfx|p12))$/i;
export const MUTATING_TOOLS = new Set(['write_file', 'create_document', 'run_command', 'open_path']);
export const TOOL_NAMES = ['list_directory', 'read_file', 'read_document', 'create_document', 'search_files', 'write_file', 'run_command', 'system_info', 'open_path'];

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export async function resolveInside(root, relative = '.', { allowMissing = false } = {}) {
  if (typeof relative !== 'string' || relative.includes('\0')) throw new Error('파일 경로가 올바르지 않습니다.');
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) throw new Error('지정한 작업 폴더 밖에는 접근할 수 없습니다.');
  let existing = candidate;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (!isInside(root, real)) throw new Error('작업 폴더 밖을 가리키는 링크에는 접근할 수 없습니다.');
      if (existing !== candidate && !allowMissing) throw new Error('파일이나 폴더를 찾을 수 없습니다.');
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' || !allowMissing) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export function checkSecret(relative) {
  if (relative.split(/[\\/]/).some(part => SECRET_NAME.test(part) || ['.aws', '.ssh', '.gnupg'].includes(part.toLowerCase()))) {
    throw new Error('인증 정보 파일은 AI 파일 도구에서 제외됩니다.');
  }
}

async function textFile(filename, limit = 256 * 1024) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error('일반 파일을 선택해 주세요.');
  if (stat.size > limit) throw new Error(`파일이 너무 큽니다. ${Math.round(limit / 1024)}KB 이하의 텍스트 파일을 사용해 주세요.`);
  const buffer = await fs.readFile(filename);
  if (buffer.includes(0)) throw new Error('바이너리 파일은 텍스트 도구로 열 수 없습니다.');
  return buffer.toString('utf8');
}

export async function listDirectory(root, relative = '.') {
  checkSecret(relative);
  const directory = await resolveInside(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter(entry => !HIDDEN.has(entry.name) && !SECRET_NAME.test(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 150).map(entry => ({
      name: entry.name,
      path: path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'),
      type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file',
    }));
}

export async function readFile(root, relative) {
  if (!relative) throw new Error('읽을 파일의 path가 필요합니다.');
  checkSecret(relative);
  const filename = await resolveInside(root, relative);
  const content = await textFile(filename);
  return { path: path.relative(root, filename), content, sha256: digest(content) };
}

export async function searchFiles(root, query, relative = '.', signal) {
  if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('검색어는 1~200자로 입력해 주세요.');
  checkSecret(relative);
  const start = await resolveInside(root, relative);
  const results = [];
  let checked = 0;
  let visited = 0;
  async function walk(directory, depth) {
    if (depth > 8 || checked >= 500 || results.length >= 50 || visited >= 1500) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted();
      if (++visited > 1500 || results.length >= 50 || checked >= 500) break;
      if (HIDDEN.has(entry.name) || SECRET_NAME.test(entry.name) || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      const rel = path.relative(root, filename);
      if (entry.isDirectory()) {
        await walk(filename, depth + 1);
      } else if (entry.isFile()) {
        checked++;
        try {
          checkSecret(rel);
          await resolveInside(root, rel);
          const content = await textFile(filename, 128 * 1024);
          content.split(/\r?\n/).forEach((line, index) => {
            if (results.length < 50 && line.toLowerCase().includes(query.toLowerCase())) {
              results.push({ path: rel, line: index + 1, text: line.slice(0, 300) });
            }
          });
        } catch { /* Skip non-text, oversized, or inaccessible files. */ }
      }
    }
  }
  if (!(await fs.stat(start)).isDirectory()) throw new Error('검색 시작 경로는 폴더여야 합니다.');
  await walk(start, 0);
  return { query, checked, results, limited: checked >= 500 || results.length >= 50 || visited >= 1500 };
}

export async function prepareWrite(root, args) {
  if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('저장할 파일의 path가 필요합니다.');
  if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 256 * 1024) throw new Error('파일 내용은 256KB 이하의 문자열이어야 합니다.');
  checkSecret(args.path);
  const filename = await resolveInside(root, args.path, { allowMissing: true });
  let before = null;
  try { before = await textFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    name: 'write_file', path: path.relative(root, filename), content: args.content,
    before, beforeHash: before === null ? null : digest(before),
  };
}

export async function commitWrite(root, proposal, backupDirectory) {
  const filename = await resolveInside(root, proposal.path, { allowMissing: true });
  let current = null;
  try { current = await textFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if ((current === null ? null : digest(current)) !== proposal.beforeHash) {
    throw new Error('검토하는 동안 파일이 바뀌었습니다. 최신 파일을 다시 읽은 뒤 수정해 주세요.');
  }
  await fs.mkdir(backupDirectory, { recursive: true });
  const backup = `${Date.now()}-${crypto.randomUUID()}.json`;
  await fs.writeFile(path.join(backupDirectory, backup), JSON.stringify({ path: filename, before: current, createdAt: new Date().toISOString() }), 'utf8');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await resolveInside(root, proposal.path, { allowMissing: true });
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, proposal.content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return { path: proposal.path, bytes: Buffer.byteLength(proposal.content), backup, saved: true };
}

export function systemInfo() {
  return {
    platform: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model,
    logicalCores: os.cpus().length, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
    freeRamGiB: +(os.freemem() / 2 ** 30).toFixed(1), node: process.version,
  };
}

export async function runCommand(root, command, { signal, timeoutMs = 60000 } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 10000) throw new Error('실행할 명령을 확인해 주세요.');
  const isWindows = process.platform === 'win32';
  const prelude = "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::OutputEncoding; $global:LASTEXITCODE=0; ";
  const ending = '; $localMateSuccess=$?; $localMateExit=$LASTEXITCODE; if($localMateExit -ne 0){exit $localMateExit}; if(-not $localMateSuccess){exit 1}';
  const executable = isWindows ? 'powershell.exe' : '/bin/sh';
  const args = isWindows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(prelude + command + ending, 'utf16le').toString('base64')]
    : ['-c', command];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', timedOut = false, truncated = false, stopping = false, forceTimer;
    function append(current, data) {
      if (current.length >= 24000) { truncated = true; return current; }
      return (current + data.toString('utf8')).slice(0, 24000);
    }
    child.stdout.on('data', data => { stdout = append(stdout, data); });
    child.stderr.on('data', data => { stderr = append(stderr, data); });
    function stop() {
      if (stopping) return;
      stopping = true;
      if (isWindows && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', () => child.kill());
        forceTimer = setTimeout(() => child.kill(), 750);
        forceTimer.unref();
      } else child.kill('SIGTERM');
    }
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stop();
    function clean() { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort); }
    child.on('error', error => { clean(); reject(error); });
    child.on('close', code => { clean(); resolve({ exitCode: code, stdout, stderr, timedOut, truncated, cancelled: Boolean(signal?.aborted) }); });
  });
}

export async function openPath(root, relative = '.') {
  const filename = await resolveInside(root, relative);
  if (process.platform !== 'win32') throw new Error('탐색기 열기는 Windows에서 사용할 수 있습니다.');
  const child = spawn('explorer.exe', [filename], { windowsHide: true, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { opened: path.relative(root, filename) || '.' };
}
