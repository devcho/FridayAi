import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.LOCAL_MATE_VOICE_HOME || path.join(projectRoot, 'data', 'voice');
const python = path.join(home, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
async function run(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true, env });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`설치 명령 종료 코드: ${code}`))); });
}
async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
try {
  await fs.mkdir(home, { recursive: true });
  if (!await exists(python)) {
    const candidates = [
      ...(process.env.LOCAL_MATE_PYTHON ? [[process.env.LOCAL_MATE_PYTHON, []]] : []),
      ...(process.platform === 'win32' ? [['py', ['-3']], [path.join(os.homedir(), 'AppData/Local/Programs/Python/Python312/python.exe'), []]] : []),
      ['python', []], ['python3', []],
    ];
    const candidate = candidates.find(([exe, args]) => spawnSync(exe, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { windowsHide: true, timeout: 8000, stdio: 'ignore' }).status === 0);
    if (!candidate) throw new Error('Python 3.9 이상을 설치한 뒤 다시 실행해 주세요.');
    console.log('음성 인식용 Python 환경을 준비합니다.');
    await run(candidate[0], [...candidate[1], '-m', 'venv', path.join(home, '.venv')]);
  }
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-r', path.join(projectRoot, 'scripts', 'voice-requirements.txt')]);
  console.log('Whisper small 로컬 모델을 준비합니다. 최초 설치 시 약 500MB를 다운로드합니다.');
  await run(python, ['-c', 'import sys; from faster_whisper.utils import download_model; print(download_model("small", output_dir=sys.argv[1], cache_dir=sys.argv[2]))', path.join(home, 'models', 'small'), path.join(home, 'hf-cache')], {
    ...process.env, HF_HOME: path.join(home, 'hf-cache'), HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1', PYTHONUTF8: '1',
  });
  console.log('\n음성 인식 설치가 완료됐습니다. LOCAL MATE에서 음성 대화 버튼을 누르세요.');
} catch (error) { console.error(`\n음성 설치 실패: ${error.message}`); process.exitCode = 1; }
