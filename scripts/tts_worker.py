"""Local Korean neural speech synthesis. No voice cloning or remote inference."""
import argparse
import base64
import contextlib
import io
import json
import os
import sys
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)


def emit(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
        if not torch.cuda.is_available():
            raise RuntimeError("자연스러운 음성에 필요한 GPU 실행 환경을 찾지 못했습니다. 기본 음성을 선택하거나 자연 음성 설치를 다시 확인해 주세요.")
        torch.set_num_threads(4)
        model = Qwen3TTSModel.from_pretrained(
            args.model, device_map="cuda:0", dtype=torch.bfloat16,
            attn_implementation="sdpa", local_files_only=True,
        )
    emit({"event": "ready", "device": "cuda", "voice": "Sohee", "loadSeconds": round(time.perf_counter() - started, 3)})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            text = request.get("text", "").strip()
            if not text or len(text) > 240:
                raise ValueError("자연 음성은 한 문단을 240자 이하로 나눠 주세요.")
            korean = any("가" <= char <= "힣" or "ㄱ" <= char <= "ㅣ" for char in text)
            generated = time.perf_counter()
            with contextlib.redirect_stdout(sys.stderr), torch.inference_mode():
                waves, sample_rate = model.generate_custom_voice(
                    text=text, language="Korean" if korean else "English",
                    speaker="Sohee" if korean else "Ryan",
                    non_streaming_mode=True, do_sample=False, max_new_tokens=768,
                )
                torch.cuda.synchronize()
            wave = np.asarray(waves[0], dtype=np.float32)
            seconds = float(wave.size / sample_rate)
            if not 0.1 <= seconds <= 65 or not np.isfinite(wave).all() or float(np.max(np.abs(wave))) < 0.0001:
                raise ValueError("음성을 올바르게 생성하지 못했습니다. 문장을 짧게 나눠 다시 시도해 주세요.")
            output = io.BytesIO()
            sf.write(output, wave, sample_rate, format="WAV", subtype="PCM_16")
            emit({"id": request["id"], "audio": base64.b64encode(output.getvalue()).decode("ascii"),
                  "metrics": {"generationSeconds": round(time.perf_counter() - generated, 3), "audioSeconds": round(seconds, 3), "sampleRate": sample_rate}})
        except Exception as error:
            emit({"id": request.get("id"), "error": str(error)[:500]})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"event": "error", "error": str(error)[:500]})
        sys.exit(1)
