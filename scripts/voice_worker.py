"""Offline speech recognition. Audio stays in memory; only JSON crosses stdio."""
import argparse
import base64
import io
import json
import os
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

import av
import numpy as np
from faster_whisper import WhisperModel


def emit(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def decode_bounded(data, max_seconds):
    """Stop decoding at the duration limit, even for highly compressed files."""
    chunks = []
    count = 0
    limit = 16000 * max_seconds
    with av.open(io.BytesIO(data), mode="r") as container:
        if not container.streams.audio:
            raise ValueError("오디오 트랙이 없는 파일입니다.")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)

        def append(frame):
            nonlocal count
            samples = frame.to_ndarray().reshape(-1)
            count += samples.size
            if count > limit:
                raise ValueError(f"음성은 {max_seconds}초 이하로 입력해 주세요.")
            chunks.append(samples)

        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                append(converted)
        for converted in resampler.resample(None):
            append(converted)
    if not chunks:
        raise ValueError("비어 있는 오디오입니다.")
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--max-seconds", type=int, default=60)
    args = parser.parse_args()
    model = WhisperModel(
        args.model, device="cpu", compute_type="int8",
        cpu_threads=args.threads, num_workers=1, local_files_only=True,
    )
    emit({"event": "ready"})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            raw = base64.b64decode(request["audio"], validate=True)
            if not raw or len(raw) > 8 * 1024 * 1024:
                raise ValueError("오디오 파일은 8MB 이하여야 합니다.")
            audio = decode_bounded(raw, args.max_seconds)
            language = request.get("language", "ko")
            if language not in ("ko", "en", "auto"):
                raise ValueError("지원하지 않는 음성 언어입니다.")
            duration = round(len(audio) / 16000.0, 2)
            if float(np.sqrt(np.mean(audio * audio))) < 0.00005:
                emit({"id": request["id"], "text": "", "duration": duration, "language": language})
                continue
            segments, info = model.transcribe(
                audio, language=None if language == "auto" else language,
                beam_size=3, temperature=0.0, condition_on_previous_text=False,
                initial_prompt=str(request.get("assistantName", "프라이데이"))[:20],
                vad_filter=True, vad_parameters={"min_silence_duration_ms": 400},
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            emit({"id": request["id"], "text": text[:12000], "duration": duration, "language": info.language})
        except Exception as error:
            emit({"id": request.get("id"), "error": str(error)[:500]})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"event": "error", "error": str(error)[:500]})
        sys.exit(1)
