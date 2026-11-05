import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.LOCAL_MATE_DOCUMENT_HOME || path.join(root, 'data', 'documents');
const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
const python = path.join(home, '.venv', executable);
const exists = filename => fs.access(filename).then(() => true, () => false);
async function run(exe, args) {
  const child = spawn(exe, args, { windowsHide: true, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1' } });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`문서 설치 종료 코드 ${code}`))); });
}
try {
  await fs.mkdir(home, { recursive: true });
  if (!await exists(python)) {
    const voicePython = path.join(root, 'data', 'voice', '.venv', executable);
    await run(await exists(voicePython) ? voicePython : 'python', ['-m', 'venv', path.join(home, '.venv')]);
  }
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', path.join(root, 'scripts', 'document-requirements.txt')]);
  await run(python, ['-c', 'import docx,openpyxl,pptx,hwpx; print("문서 엔진 확인 완료")']);
  await fs.writeFile(path.join(home, 'runtime.json'), JSON.stringify({ version: 1, formats: ['docx','xlsx','pptx','hwpx','hwp'] }, null, 2));
  console.log('문서 기능 설치 완료. 앱을 다시 열어 문서 만들기를 사용하세요.');
} catch (error) { console.error(`설치 실패: ${error.message}. Python 3.10 이상이 필요합니다.`); process.exitCode = 1; }
