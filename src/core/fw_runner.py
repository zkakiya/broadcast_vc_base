# src/core/fw_runner.py
# usage:
#   /home/z_kakiya/whisper-venv/bin/python src/core/fw_runner.py <wav> <out.json>
#     [--model small] [--device cuda|cpu] [--compute float16|int8_float16|int8] [--lang ja] [--initial_prompt "..."]
import sys, json, time, os
from faster_whisper import WhisperModel

def main():
    if len(sys.argv) < 3:
        print("usage: fw_runner.py <wav> <out.json> [--model m] [--device d] [--compute t] [--lang l] [--initial_prompt s]", file=sys.stderr)
        sys.exit(2)

    wav = sys.argv[1]
    out_json = sys.argv[2]

    # defaults from env
    model_name      = os.getenv("WHISPER_MODEL", "small")
    device          = os.getenv("FASTER_WHISPER_DEVICE", "cuda")
    compute         = os.getenv("FW_COMPUTE_TYPE", "float16")
    lang            = os.getenv("WHISPER_LANG", "ja")
    initial_prompt  = os.getenv("ASR_HINTS")  # ← 追加: 環境変数から既定ヒント

    # arg overrides
    args = sys.argv[3:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--model"   and i+1 < len(args): model_name     = args[i+1]; i += 2; continue
        if a == "--device"  and i+1 < len(args): device         = args[i+1]; i += 2; continue
        if a == "--compute" and i+1 < len(args): compute        = args[i+1]; i += 2; continue
        if a == "--lang"    and i+1 < len(args): lang           = args[i+1]; i += 2; continue
        if a == "--initial_prompt" and i+1 < len(args): initial_prompt = args[i+1]; i += 2; continue
        i += 1

    t0 = time.time()
    model = WhisperModel(model_name, device=device, compute_type=compute)

    segments, info = model.transcribe(
        wav,
        language=lang,
        task="transcribe",
        vad_filter=False,            # 既定は従来通り（必要なら True にしてOK）
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,   # ← 追加: 初期プロンプト
    )

    out = {"text": "", "segments": []}
    for seg in segments:
        out["segments"].append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text,
            "avg_logprob": getattr(seg, "avg_logprob", None)
        })
        out["text"] += seg.text

    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f'fw ok {model_name} {device} {compute} elapsed={time.time()-t0:.2f}s', file=sys.stderr)

if __name__ == "__main__":
    main()
