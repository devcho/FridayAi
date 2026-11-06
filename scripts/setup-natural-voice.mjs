import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.LOCAL_MATE_VOICE_HOME || path.join(root, 'data', 'voice');
const executable = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
const python = path.join(home, '.tts-venv', executable);
const marker = path.join(home, 'natural-runtime.json');
async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
async function run(exe, args, env = process.env) {
  const child = spawn(exe, args, { windowsHide: true, stdio: 'inherit', env });
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`설치 명령 종료 코드: ${code}`))); });
}
try {
  await fs.mkdir(home, { recursive: true });
  if (!await exists(python)) {
    const base = path.join(home, '.venv', executable);
    if (!await exists(base)) throw new Error('먼저 setup-voice.cmd로 음성 인식을 설치해 주세요.');
    await run(base, ['-m', 'venv', path.join(home, '.tts-venv')]);
  }
  console.log('자연 음성 전용 GPU 실행 환경을 준비합니다. 최초 설치 시 수 GB를 다운로드합니다.');
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'torch==2.9.1', 'torchaudio==2.9.1', '--index-url', 'https://download.pytorch.org/whl/cu128']);
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'qwen-tts==0.1.1']);
  await run(python, ['-c', 'import torch; assert torch.cuda.is_available(), "NVIDIA GPU 실행 환경을 찾지 못했습니다."; print(torch.cuda.get_device_name(0))']);
  console.log('한국어 자연 음성 모델을 다운로드합니다.');
  await run(python, ['-c', 'import sys; from huggingface_hub import snapshot_download; print(snapshot_download("Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",local_dir=sys.argv[1],cache_dir=sys.argv[2],allow_patterns=["*.json","*.txt","*.safetensors"],token=False))', path.join(home, 'models', 'qwen3-tts-small'), path.join(home, 'tts-hf-cache')], {
    ...process.env, HF_HOME: path.join(home, 'tts-hf-cache'), HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_XET: '1', PYTHONUTF8: '1',
  });
  await fs.writeFile(marker, JSON.stringify({ engine: 'qwen3-tts', voice: 'Ryan', device: 'cuda', installedAt: new Date().toISOString() }, null, 2), 'utf8');
  console.log('자연 음성 설치 완료. 앱을 다시 실행하면 자연스러운 목소리를 선택할 수 있습니다.');
} catch (error) { console.error(`자연 음성 설치 실패: ${error.message}`); process.exitCode = 1; }
