import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveInside, checkSecret } from './workspace.mjs';

export const DOCUMENT_FORMATS = { docx: 'Word 문서', xlsx: 'Excel 통합 문서', pptx: 'PowerPoint 프레젠테이션', hwpx: '한글 HWPX 문서', hwp: '한글 HWP 문서' };
export const DOCUMENT_MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwpx: 'application/hwp+zip', hwp: 'application/x-hwp' };
const exists = filename => fs.access(filename).then(() => true, () => false);
const failure = message => Object.assign(new Error(message), { status: 400 });

export class DocumentService {
  constructor({ projectRoot, home = process.env.LOCAL_MATE_DOCUMENT_HOME || path.join(projectRoot, 'data', 'documents') } = {}) {
    this.projectRoot = projectRoot; this.home = home; this.children = new Set();
    this.python = path.join(home, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }
  async status() { return { installed: await exists(this.python) && await exists(path.join(this.home, 'runtime.json')), local: true, formats: DOCUMENT_FORMATS }; }
  async path(root, relative, allowMissing = false) {
    if (typeof relative !== 'string' || !relative.trim()) throw failure('문서 파일 이름이 필요합니다.');
    checkSecret(relative);
    const format = path.extname(relative).slice(1).toLowerCase();
    if (!DOCUMENT_FORMATS[format]) throw failure('DOCX·XLSX·PPTX·HWPX·HWP 형식을 선택해 주세요.');
    const filename = await resolveInside(root, relative, { allowMissing });
    return { filename, format, relative: path.relative(root, filename).split(path.sep).join('/') };
  }
  async worker(request, signal) {
    signal?.throwIfAborted();
    if (!(await this.status()).installed) throw failure('문서 작성 환경을 설치해 주세요. setup-documents.cmd를 실행하면 됩니다.');
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ['-u', path.join(this.projectRoot, 'scripts', 'document_worker.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } });
      this.children.add(child);
      let output = '', errors = '', timedOut = false, overflow = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60000);
      const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
      const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.children.delete(child); };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', text => { if (output.length + text.length > 30 * 1024 * 1024) { overflow = true; child.kill(); } else output += text; });
      child.stderr.on('data', text => { errors = (errors + text).slice(-1000); });
      child.once('error', error => { clean(); reject(error); });
      child.once('close', code => {
        clean();
        if (signal?.aborted) return reject(signal.reason);
        if (timedOut || overflow) return reject(failure('문서 처리 제한을 초과했습니다. 문서 크기를 줄여 주세요.'));
        let result; try { result = JSON.parse(output.trim()); } catch { return reject(failure('문서 처리 결과를 읽지 못했습니다. ' + errors)); }
        if (code !== 0 || result.error) return reject(failure(result.error || errors || '문서를 생성하지 못했습니다.'));
        resolve(result);
      });
      child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(request));
      if (signal?.aborted) abort();
    });
  }
  async prepare(root, args, signal) {
    const target = await this.path(root, args.path, true);
    if (await exists(target.filename)) throw failure('같은 이름의 문서가 있습니다. 원본을 보존하도록 새 파일 이름으로 저장해 주세요.');
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 120 || typeof args.content !== 'string' || !args.content.trim() || args.content.length > 60000) throw failure('문서 제목은 120자, 본문은 60,000자 이내로 입력해 주세요.');
    const result = await this.worker({ operation: 'create', format: target.format, title: args.title.trim(), content: args.content }, signal);
    const data = Buffer.from(result.data, 'base64');
    if (!data.length || data.length > 20 * 1024 * 1024 || !(target.format === 'hwp' ? data.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')) : data.subarray(0, 2).toString() === 'PK')) throw failure('생성된 문서 형식이 올바르지 않습니다.');
    return { proposal: { name: 'create_document', path: target.relative, format: target.format, title: args.title.trim(), content: args.content, bytes: data.length }, data };
  }
  async commit(root, prepared, backupDirectory, signal) {
    signal?.throwIfAborted();
    const target = await this.path(root, prepared.proposal.path, true);
    await fs.mkdir(path.dirname(target.filename), { recursive: true });
    await this.path(root, prepared.proposal.path, true);
    const handle = await fs.open(target.filename, 'wx').catch(error => { if (error.code === 'EEXIST') throw failure('검토 중 같은 이름의 파일이 생겼습니다. 다른 이름으로 저장해 주세요.'); throw error; });
    try { await handle.writeFile(prepared.data); } finally { await handle.close(); }
    if (backupDirectory) {
      await fs.mkdir(backupDirectory, { recursive: true });
      await fs.writeFile(path.join(backupDirectory, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ path: target.filename, before: null, createdAt: new Date().toISOString(), document: true }));
    }
    return { saved: true, path: target.relative, format: target.format, bytes: prepared.data.length, downloadable: true };
  }
  async bytes(root, relative) {
    const target = await this.path(root, relative);
    const stat = await fs.stat(target.filename);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw failure('20MB 이하의 일반 문서를 선택해 주세요.');
    return { ...target, data: await fs.readFile(target.filename) };
  }
  async read(root, relative, signal) {
    const target = await this.bytes(root, relative);
    const result = await this.worker({ operation: 'read', format: target.format, data: target.data.toString('base64') }, signal);
    return { path: target.relative, content: result.text, truncated: result.truncated, sha256: crypto.createHash('sha256').update(target.data).digest('hex') };
  }
  dispose() { for (const child of this.children) child.kill(); }
}
