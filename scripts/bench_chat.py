"""
Latency benchmark for /api/groq/chat (or local groq endpoint).

Calistirma:
  # Production (uzak):
  python scripts/bench_chat.py --url https://api.hissechat.com/api/groq/chat --n 30

  # Local:
  python scripts/bench_chat.py --url http://localhost:8000/groq/chat --n 20

Olcumler:
  - p50 / p95 / p99 / max
  - Cache hit ratio (response.cached field varsa)
  - RAG hit ratio (yanitin icinde "BILGI BANKASI" varsa basit heuristik)

Sorular karisik secilir: cache miss + cache hit + RAG-relevant + RAG-irrelevant.
"""
import argparse
import json
import statistics
import time
from urllib import request, error

# Karisik soru havuzu
QUESTIONS_RAG_RELEVANT = [
    "GARAN bilancosu nasil?",
    "THYAO 2025 net kari ne kadar?",
    "ASELS son KAP duyurusu",
    "TUPRS temettu ne zaman?",
    "Bankacilik sektoru ne durumda?",
]
QUESTIONS_GENERIC = [
    "RSI nedir?",
    "MACD gostergesi nasil yorumlanir?",
    "Stop loss nedir?",
    "Borsa istanbul ne zaman acik?",
    "Hisse senedi alirken nelere dikkat etmeliyim?",
]


def call(url: str, question: str, timeout: float = 30.0) -> dict:
    body = json.dumps({"message": question, "history": []}).encode("utf-8")
    req = request.Request(url, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return {
            "ok": True,
            "ms": int((time.time() - t0) * 1000),
            "cached": payload.get("cached", False),
            "stale": payload.get("stale", False),
            "answer_len": len(payload.get("answer", payload.get("text", "")) or ""),
            "rag_used": "BILGI BANKASI" in (payload.get("answer", "") or payload.get("text", "") or ""),
        }
    except error.HTTPError as e:
        return {"ok": False, "ms": int((time.time() - t0) * 1000), "err": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "ms": int((time.time() - t0) * 1000), "err": str(e)[:80]}


def pct(xs, p):
    if not xs:
        return 0
    xs = sorted(xs)
    k = max(0, min(len(xs) - 1, int(len(xs) * p / 100)))
    return xs[k]


def run(url: str, n: int):
    pool = QUESTIONS_RAG_RELEVANT + QUESTIONS_GENERIC
    results = []
    print(f"[bench] {n} istek -> {url}")
    print(f"[bench] {len(pool)} farkli soru, dongusel")
    for i in range(n):
        q = pool[i % len(pool)]
        r = call(url, q)
        r["q"] = q[:30]
        results.append(r)
        tag = "CACHE" if r.get("cached") else ("STALE" if r.get("stale") else "FRESH")
        rag = "RAG" if r.get("rag_used") else "---"
        print(f"  [{i+1:3d}/{n}] {r['ms']:5d}ms  {tag:5s}  {rag}  {r.get('q')}")

    ok = [r for r in results if r["ok"]]
    if not ok:
        print("[bench] hicbir istek basarili degil")
        return

    durs = [r["ms"] for r in ok]
    cached = [r for r in ok if r.get("cached")]
    fresh = [r for r in ok if not r.get("cached")]
    rag_used = [r for r in ok if r.get("rag_used")]

    print("\n" + "=" * 60)
    print(f"  Toplam:        {len(results)}  (basarili: {len(ok)}, hata: {len(results)-len(ok)})")
    print(f"  Cache hit:     {len(cached)} ({len(cached)*100//len(ok)}%)")
    print(f"  Fresh call:    {len(fresh)} ({len(fresh)*100//len(ok)}%)")
    print(f"  RAG inject:    {len(rag_used)} ({len(rag_used)*100//len(ok)}%)")
    print(f"  Latency (ms):")
    print(f"    avg:         {int(statistics.mean(durs))}")
    print(f"    p50:         {pct(durs, 50)}")
    print(f"    p95:         {pct(durs, 95)}")
    print(f"    p99:         {pct(durs, 99)}")
    print(f"    max:         {max(durs)}")
    if cached:
        cd = [r["ms"] for r in cached]
        print(f"  Cached p50:    {pct(cd, 50)}ms  (target: <50ms)")
    if fresh:
        fd = [r["ms"] for r in fresh]
        print(f"  Fresh p50:     {pct(fd, 50)}ms  (target: <2500ms)")
        print(f"  Fresh p95:     {pct(fd, 95)}ms  (target: <4000ms)")
    print("=" * 60)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="Chat endpoint, ornek: http://localhost:8000/groq/chat")
    ap.add_argument("--n", type=int, default=20, help="Toplam istek sayisi")
    args = ap.parse_args()
    run(args.url, args.n)
