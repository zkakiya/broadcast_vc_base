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
    lang   = req.get("lang") or os.getenv("WHISPER_LANG", "ja")
    prompt = req.get("prompt") or os.getenv("ASR_HINTS")  # ★ 追加：ホットワード initial_prompt
    if not wav or not os.path.exists(wav):
        raise FileNotFoundError(f"wav not found: {wav}")

    segments, info = model.transcribe(
        wav,
        language=lang,
        task="transcribe",
        vad_filter=True,
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        initial_prompt=prompt  # ★ 追加
    )

    text = ""
    out = []
    for s in segments:
        t = s.text or ""
        text += t
        out.append({"start": s.start, "end": s.end, "text": t})
    return {"text": text, "segments": out}

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
            jprint({"id": (req.get("id") if 'req' in locals() else None), "ok": False, "error": str(e), "trace": traceback.format_exc()})

if __name__ == "__main__":
    main()
