# src/core/fw_worker.py
import sys, json, os, traceback
import faulthandler
faulthandler.enable()

def eprint(*a):
    sys.stderr.write(" ".join(str(x) for x in a) + "\n"); sys.stderr.flush()

try:
    from faster_whisper import WhisperModel
except Exception as e:
    eprint("[fw] import faster_whisper failed:", e)
    raise

model = None

def jprint(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def _get_env_int(name, default):
    try:
        v = os.getenv(name)
        return int(v) if v is not None and v != "" else default
    except Exception:
        return default

def _get_env_float(name, default):
    try:
        v = os.getenv(name)
        return float(v) if v is not None and v != "" else default
    except Exception:
        return default

def load_model(params):
    global model
    if model is not None:
        return
    name    = params.get("model", os.getenv("WHISPER_MODEL", "small"))
    device  = params.get("device", os.getenv("FASTER_WHISPER_DEVICE", "cuda"))
    compute = params.get("compute", os.getenv("FW_COMPUTE_TYPE", "float16"))

    eprint(f"[fw] load model name={name} device={device} compute={compute}")
    try:
        model = WhisperModel(name, device=device, compute_type=compute)
        eprint("[fw] model loaded")
    except Exception as e:
        eprint("[fw] model load failed:", e)
        raise

def handle_transcribe(req):
    wav    = req.get("wav")
    # 'auto' の場合は None を渡して faster-whisper の自動判定を使う
    lang_req = (req.get("lang") or os.getenv("WHISPER_LANG", "ja")).strip().lower()
    lang     = None if lang_req in ("auto", "", "detect") else lang_req

    # initial_prompt（ホットワード）
    prompt = req.get("prompt") or os.getenv("ASR_HINTS")

    if not wav or not os.path.exists(wav):
        raise FileNotFoundError(f"wav not found: {wav}")

    # ---- VAD を少し甘くして語尾切れを防ぐ（環境変数で調整可） ----
    vad_min_sil_ms = _get_env_int("FW_VAD_MIN_SILENCE_MS", 450)  # 350〜600 が目安
    vad_thresh     = _get_env_float("FW_VAD_THRESHOLD", 0.3)     # 0.0甘い〜1.0厳しい

    vad_params = {
        "min_silence_duration_ms": vad_min_sil_ms,
        "threshold": vad_thresh,
    }

    # 推論。必要に応じて beam_size/temperature は好みで
    # （語尾切れ対策には VAD パラメータの方が効きます）
    try:
        segments, info = model.transcribe(
            wav,
            language=lang,                 # None なら自動検出
            task="transcribe",
            vad_filter=True,               # 内部VAD ON
            vad_parameters=vad_params,     # ★ ここが効く
            beam_size=1,                   # 既定通り軽量
            temperature=0.0,               # 安定寄り
            condition_on_previous_text=False,
            initial_prompt=prompt
        )
    except Exception as e:
        eprint("[fw] transcribe failed:", e)
        raise

    text = ""
    out = []
    for s in segments:
        t = s.text or ""
        text += t
        out.append({"start": s.start, "end": s.end, "text": t})

    # faster-whisper の言語検出結果（ISO 639-1 例: 'ja','en','uk'）
    lang_detected = getattr(info, "language", None)
    lang_prob     = getattr(info, "language_probability", None)

    return {
        "text": text,
        "segments": out,
        "lang": lang_detected,
        "lang_prob": lang_prob,
    }

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            rid = req.get("id")
            cmd = req.get("cmd")
            if cmd == "init":
                load_model(req)
                jprint({"id": rid, "ok": True})
            elif cmd == "transcribe":
                res = handle_transcribe(req)
                jprint({"id": rid, "ok": True, **res})
            else:
                jprint({"id": rid, "ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as e:
            jprint({
                "id": (req.get("id") if 'req' in locals() else None),
                "ok": False,
                "error": str(e),
                "trace": traceback.format_exc()
            })

if __name__ == "__main__":
    main()
