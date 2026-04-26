"""
Zero-shot classification — gercek implementasyon.

Iki strateji (sirayla denenir):

  1) **Embedding-based** (varsayilan, hizli, yeni dep YOK)
     - rag.embedder (sentence-transformers multilingual MiniLM, zaten yuklu)
     - cosine(message, label) -> softmax -> olasiliklar
     - Gercek anlamsal benzerlik; "hisse" ile "borsa" yakin cikar.
     - Latency: ~30-80ms (1 + N embed; cache'lenir)

  2) **HuggingFace NLI** (opsiyonel, ZSC_USE_NLI=true ise)
     - transformers pipeline("zero-shot-classification")
     - Default model: MoritzLaurer/mDeBERTa-v3-base-mnli-xnli (multilingual TR destekli)
     - Latency: ~200-800ms CPU. Daha dogru ama agir.

  3) **Keyword fallback** (her iki strateji de yoksa)
     - Eski naive substring skoru. Geriye uyumluluk icin.

Cikti formatı /predict ile geriye uyumlu:
   {"labels": [...], "scores": [...], "sequence": "...", "method": "embedding|nli|keyword"}
"""
from __future__ import annotations

import math
import os
import threading
from typing import List, Optional, Tuple


# ---------- ortak yardimcilar ----------
def _softmax(xs: List[float], temperature: float = 1.0) -> List[float]:
    if not xs:
        return []
    if temperature <= 0:
        temperature = 1.0
    scaled = [x / temperature for x in xs]
    m = max(scaled)
    exps = [math.exp(x - m) for x in scaled]
    s = sum(exps) or 1.0
    return [e / s for e in exps]


def _cosine(a: List[float], b: List[float]) -> float:
    # embedder normalize=True -> dot = cosine
    return sum(x * y for x, y in zip(a, b))


# ---------- 1) Embedding-based ----------
_emb_lock = threading.Lock()
_emb_mod = None
_emb_failed = False

# Label embedding cache: label_text -> vector
_LABEL_CACHE: dict = {}
_LABEL_CACHE_MAX = 1024

# Softmax temperature: cosine [-1,1] zayif ayrildigi icin <1 keskinlestirir.
EMB_TEMPERATURE = float(os.environ.get("ZSC_EMB_TEMPERATURE", "0.1"))


def _get_embedder():
    global _emb_mod, _emb_failed
    if _emb_failed:
        return None
    if _emb_mod is not None:
        return _emb_mod
    with _emb_lock:
        if _emb_mod is not None:
            return _emb_mod
        if _emb_failed:
            return None
        try:
            from rag import embedder as _emb  # type: ignore
            if not _emb.is_ready():
                try:
                    _emb._ensure_loaded()  # type: ignore[attr-defined]
                except Exception:
                    pass
            if not _emb.is_ready():
                _emb_failed = True
                return None
            _emb_mod = _emb
            return _emb_mod
        except Exception:
            _emb_failed = True
            return None


def _embed_label(text: str) -> Optional[List[float]]:
    if text in _LABEL_CACHE:
        return _LABEL_CACHE[text]
    emb = _get_embedder()
    if emb is None:
        return None
    vec = emb.embed_query(text)
    if vec is None:
        return None
    if len(_LABEL_CACHE) < _LABEL_CACHE_MAX:
        _LABEL_CACHE[text] = vec
    return vec


def classify_embedding(message: str, labels: List[str], hypothesis_template: Optional[str] = None) -> Optional[Tuple[List[float], List[float]]]:
    """Embedding cosine + softmax. Dondurur: (raw_cosines, softmax_scores) veya None.
    hypothesis_template verilirse her label icin "TEMPLATE.format(label)" cumlesi embed edilir."""
    emb = _get_embedder()
    if emb is None or not labels:
        return None
    qvec = emb.embed_query(message)
    if qvec is None:
        return None
    cosines: List[float] = []
    for lbl in labels:
        text = hypothesis_template.format(lbl) if hypothesis_template else lbl
        lv = _embed_label(text)
        if lv is None:
            return None
        cosines.append(_cosine(qvec, lv))
    scores = _softmax(cosines, temperature=EMB_TEMPERATURE)
    return cosines, scores


# ---------- 2) HuggingFace NLI (opsiyonel) ----------
USE_NLI = os.environ.get("ZSC_USE_NLI", "false").lower() == "true"
NLI_MODEL = os.environ.get("ZSC_NLI_MODEL", "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli")

_nli_lock = threading.Lock()
_nli_pipe = None
_nli_failed = False


def _get_nli():
    global _nli_pipe, _nli_failed
    if not USE_NLI or _nli_failed:
        return None
    if _nli_pipe is not None:
        return _nli_pipe
    with _nli_lock:
        if _nli_pipe is not None:
            return _nli_pipe
        if _nli_failed:
            return None
        try:
            from transformers import pipeline  # type: ignore
            _nli_pipe = pipeline(
                "zero-shot-classification",
                model=NLI_MODEL,
                device=-1,  # CPU
            )
            return _nli_pipe
        except Exception as e:
            print(f"[zsc] NLI pipeline yuklenemedi ({NLI_MODEL}): {e}")
            _nli_failed = True
            return None


def classify_nli(message: str, labels: List[str], hypothesis_template: Optional[str] = None) -> Optional[List[float]]:
    pipe = _get_nli()
    if pipe is None or not labels:
        return None
    try:
        kwargs = {"candidate_labels": labels, "multi_label": False}
        if hypothesis_template:
            kwargs["hypothesis_template"] = hypothesis_template
        out = pipe(message, **kwargs)
        # Pipeline label/score sirasini kendine gore donduruyor; orijinal label sirasina geri esle.
        idx = {lbl: i for i, lbl in enumerate(out["labels"])}
        return [out["scores"][idx[lbl]] for lbl in labels]
    except Exception as e:
        print(f"[zsc] NLI inference hata: {e}")
        return None


# ---------- 3) Keyword fallback (eski) ----------
def classify_keyword(message: str, labels: List[str]) -> List[float]:
    msg = message.lower()
    raw: List[float] = []
    for lbl in labels:
        ll = lbl.lower()
        s = 0.1
        if ll in msg:
            s = 0.9
        elif any(w in msg for w in ll.split()):
            s = 0.6
        raw.append(s)
    total = sum(raw) or 1.0
    return [s / total for s in raw]


# ---------- Birlesik API ----------
def classify(message: str, labels: List[str], hypothesis_template: Optional[str] = None) -> dict:
    """Sirasiyla NLI -> embedding -> keyword dener.
    Donus: {"labels", "scores", "method", "raw" (opsiyonel)}.
    """
    if not message or not labels:
        return {"labels": labels, "scores": [], "method": "none"}

    # 1) NLI (yalnizca env ile aktifse)
    if USE_NLI:
        nli_scores = classify_nli(message, labels, hypothesis_template)
        if nli_scores is not None:
            return {"labels": labels, "scores": nli_scores, "method": "nli"}

    # 2) Embedding
    emb_out = classify_embedding(message, labels, hypothesis_template)
    if emb_out is not None:
        cosines, scores = emb_out
        return {
            "labels": labels,
            "scores": scores,
            "method": "embedding",
            "raw": cosines,
        }

    # 3) Keyword fallback
    return {
        "labels": labels,
        "scores": classify_keyword(message, labels),
        "method": "keyword",
    }


# ---------- CLI ----------
if __name__ == "__main__":
    import json
    import sys
    msg = sys.argv[1] if len(sys.argv) > 1 else "GARAN bilancosu cok iyi gorunuyor"
    lbls = sys.argv[2:] if len(sys.argv) > 2 else ["hisse senedi analizi", "kripto para", "doviz kuru", "spor haberleri"]
    out = classify(msg, lbls, hypothesis_template="Bu metin {} hakkindadir.")
    print(json.dumps(out, ensure_ascii=False, indent=2))
