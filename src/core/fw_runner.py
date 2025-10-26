# src/core/fw_runner.py
# usage: /path/to/python fw_runner.py <wav_path> <out_json_path> [--model small] [--device cuda] [--compute float16] [--lang ja]
import sys, json, time, os
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 3:
        print("usage: fw_runner.py <wav> <out.json> [--model m] [--device d] [--compute t] [--lang l]", file=sys.stderr)
        sys.exit(2)

    wav = sys.argv[1]
    out_json = sys.argv[2]
    # defaults from env
    model_name = os.getenv("WHISPER_MODEL", "small")
    device = os.getenv("FASTER_WHISPER_DEVICE", "cuda")
    compute = os.getenv("FW_COMPUTE_TYPE", "float16")
    lang = os.getenv("WHISPER_LANG", "ja")

    # override by args
    args = sys.argv[3:]
    for i, a in enumerate(args):
        if a == "--model" and i+1 < len(args): model_name = args[i+1]
        if a == "--device" and i+1 < len(args): device = args[i+1]
        if a == "--compute" and i+1 < len(args): compute = args[i+1]
        if a == "--lang" and i+1 < len(args): lang = args[i+1]

    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute)
    # 我々は既にセグメント済み（1〜2秒WAV）なので vad_filter/word_timestamps は不要
    segments, info = model.transcribe(
        wav,
        language=lang,
        task="transcribe",
        vad_filter=False,
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False
    )

    out = {"text":"", "segments":[]}
    for seg in segments:
        out["segments"].append({
            "start": seg.start, "end": seg.end,
            "text": seg.text, "avg_logprob": getattr(seg, "avg_logprob", None)
        })
        out["text"] += seg.text

    # 出力
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f'fw ok {model_name} {device} {compute} elapsed={time.time()-t0:.2f}s', file=sys.stderr)

if __name__ == "__main__":
    main()
