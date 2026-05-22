"""
LLM Tool Calling — schema definitions + dispatcher + tool loop.

Mimari:
- TOOL_SCHEMAS: OpenAI-uyumlu function calling schema (DO Gradient AI, OpenAI,
  Anthropic-via-DO hepsi ayni formati kabul eder).
- dispatch(name, args): Tool ismini market_data / rag fonksiyonlarina map'ler.
  Hata durumunda string olarak hata mesaji doner (LLM'i bloklamaz).
- run_tool_loop(router, messages, tools, **kw): LLM'i tool'lar ile cagirir,
  tool_calls geldikce dispatch eder, max_iters'a kadar dongu yapar, son
  metinsel cevabi doner.

Tasarim notlari:
- Paralel tool destekli: LLM ayni turda 3 tool cagirirsa hepsi paralel calistirilir.
- Tool sonucu JSON string olarak geri verilir (LLM bunu yorumlar).
- Provider whitelist: digitalocean, openai (varsayilan). Diger provider'larda
  router fallback yapar -> tool'suz path.
- Streaming YOK: tool loop tamamlandiktan sonra son cevap tek seferde doner.
  (app.py'da stream=true gelirse tool calling devre disi birakilir.)
"""
from __future__ import annotations

import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Dict, List, Optional


# ====================================================================
# TOOL SCHEMAS (OpenAI function calling format)
# ====================================================================

TOOL_SCHEMAS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "get_market_quote",
            "description": (
                "Belirli BIST hisseleri, kripto paralar, doviz, emtia veya endeksler "
                "icin guncel fiyat ve gunluk degisim yuzdesini doner. Sadece kesin "
                "sembol/kod bildiginde kullan. Cok genel sorularda (orn. 'piyasa nasil') "
                "yerine get_market_overview tercih et."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbols": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Sembol listesi. Pazara gore format: "
                            "bist=['THYAO','GARAN'], crypto=['bitcoin','ethereum'], "
                            "fx=['USD','EUR','GBP'], commodity=['GRAM_ALTIN','ONS','BRENT'], "
                            "index=['XU100','XU030','XBANK']."
                        ),
                    },
                    "market": {
                        "type": "string",
                        "enum": ["bist", "crypto", "fx", "commodity", "index"],
                        "description": "Hangi pazardan veri alinacagi.",
                    },
                },
                "required": ["symbols", "market"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_market_overview",
            "description": (
                "Kullanicinin sorusundan otomatik varlik tespiti yapip ilgili tum "
                "canli verileri (BIST + kripto + doviz + emtia + endeks) tek seferde "
                "ceker. Soruda hangi varliklarin gectiginden emin degilsen veya soru "
                "cok genis kapsamliysa bunu kullan."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "Kullanicinin orijinal sorusu (TR).",
                    }
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge_base",
            "description": (
                "KAP duyurulari, bilanco/finansal raporlar ve haberler iceren "
                "vektor bilgi bankasinda semantik arama yapar. Sirket haberleri, "
                "bilanco analizi, temettu, halka arz, denetim raporu gibi sorularda "
                "kullan. Anlik fiyat icin DEGIL."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Arama sorgusu (TR, dogal dil).",
                    },
                    "top_k": {
                        "type": "integer",
                        "description": "Koleksiyon basina dondurulecek en iyi sonuc sayisi (1-8). Default 4.",
                        "minimum": 1,
                        "maximum": 8,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_fx_rates",
            "description": (
                "USD, EUR, GBP, CHF, JPY vb. doviz birimlerinin TL karsiligini doner. "
                "Sadece doviz kuru sorularinda kullan."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "codes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Doviz kodu listesi (orn. ['USD','EUR']).",
                    }
                },
                "required": ["codes"],
            },
        },
    },
]


# ====================================================================
# DISPATCHER
# ====================================================================

_tool_executor = ThreadPoolExecutor(max_workers=6, thread_name_prefix="llm-tool")

# Lazy module references (init at first use to avoid import cycles)
_market_data = None
_rag_retriever = None
_modules_inited = False


def _init_modules() -> None:
    global _market_data, _rag_retriever, _modules_inited
    if _modules_inited:
        return
    try:
        import market_data as md
        _market_data = md
    except Exception as e:
        print(f"[llm.tools] market_data import basarisiz: {e}")
        _market_data = None
    try:
        from rag import retriever as rr
        _rag_retriever = rr
    except Exception as e:
        print(f"[llm.tools] rag.retriever import basarisiz: {e}")
        _rag_retriever = None
    _modules_inited = True


def _tool_get_market_quote(args: Dict[str, Any]) -> Any:
    _init_modules()
    if _market_data is None:
        return {"error": "market_data modulu yuklu degil"}
    symbols = args.get("symbols") or []
    market = (args.get("market") or "").strip().lower()
    if not isinstance(symbols, list) or not symbols:
        return {"error": "symbols listesi bos"}
    symbols = [str(s).strip() for s in symbols if str(s).strip()][:10]  # max 10 sembol

    try:
        if market == "bist":
            return {"market": "bist", "quotes": _market_data.fetch_bist(symbols)}
        if market == "crypto":
            # Kullanici 'BTC' yazmissa coingecko id'ye normalize et
            normalized = []
            cmap = getattr(_market_data, "CRYPTO_MAP", {})
            for s in symbols:
                low = s.lower()
                normalized.append(cmap.get(low, low))
            return {"market": "crypto", "quotes": _market_data.fetch_crypto(normalized)}
        if market == "fx":
            return {"market": "fx", "quotes": _market_data.fetch_fx([s.upper() for s in symbols])}
        if market == "commodity":
            return {
                "market": "commodity",
                "quotes": _market_data.fetch_commodity_local([s.upper() for s in symbols]),
            }
        if market == "index":
            return {"market": "index", "quotes": _market_data.fetch_index([s.upper() for s in symbols])}
        return {"error": f"bilinmeyen market: {market}"}
    except Exception as e:
        return {"error": f"fetch hatasi: {type(e).__name__}: {e}"}


def _tool_get_market_overview(args: Dict[str, Any]) -> Any:
    _init_modules()
    if _market_data is None:
        return {"error": "market_data modulu yuklu degil"}
    q = (args.get("question") or "").strip()
    if not q:
        return {"error": "question parametresi bos"}
    try:
        ctx = _market_data.build_market_context(q)
        if not ctx:
            return {"result": "Soruda canli veri ile eslesen varlik tespit edilemedi."}
        return {"result": ctx}
    except Exception as e:
        return {"error": f"overview hatasi: {type(e).__name__}: {e}"}


def _tool_search_knowledge_base(args: Dict[str, Any]) -> Any:
    _init_modules()
    if _rag_retriever is None:
        return {"error": "rag.retriever modulu yuklu degil"}
    q = (args.get("query") or "").strip()
    if not q:
        return {"error": "query parametresi bos"}
    top_k = args.get("top_k")
    try:
        if top_k is not None:
            top_k = int(top_k)
            top_k = max(1, min(8, top_k))
        result = _rag_retriever.retrieve(q, top_k=top_k)
        if not result:
            return {"result": "Bilgi bankasinda ilgili kayit bulunamadi."}
        return {"result": result}
    except Exception as e:
        return {"error": f"rag hatasi: {type(e).__name__}: {e}"}


def _tool_get_fx_rates(args: Dict[str, Any]) -> Any:
    _init_modules()
    if _market_data is None:
        return {"error": "market_data modulu yuklu degil"}
    codes = args.get("codes") or []
    if not isinstance(codes, list) or not codes:
        return {"error": "codes listesi bos"}
    codes = [str(c).strip().upper() for c in codes if str(c).strip()][:10]
    try:
        return {"quotes": _market_data.fetch_fx(codes)}
    except Exception as e:
        return {"error": f"fx hatasi: {type(e).__name__}: {e}"}


_DISPATCH: Dict[str, Callable[[Dict[str, Any]], Any]] = {
    "get_market_quote": _tool_get_market_quote,
    "get_market_overview": _tool_get_market_overview,
    "search_knowledge_base": _tool_search_knowledge_base,
    "get_fx_rates": _tool_get_fx_rates,
}


def dispatch(name: str, args: Dict[str, Any]) -> str:
    """Tool ismi + parsed argumanlar -> JSON string sonuc (LLM'e geri verilecek)."""
    fn = _DISPATCH.get(name)
    if fn is None:
        return json.dumps({"error": f"bilinmeyen tool: {name}"}, ensure_ascii=False)
    try:
        result = fn(args or {})
    except Exception as e:
        result = {"error": f"dispatch hatasi: {type(e).__name__}: {e}"}
    # JSON-serializable garanti et
    try:
        return json.dumps(result, ensure_ascii=False, default=str)
    except Exception:
        return json.dumps({"error": "tool sonucu serialize edilemedi"}, ensure_ascii=False)


def _dispatch_parallel(tool_calls: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Birden fazla tool_call'i paralel calistir; sonuclari ayni sirada don."""
    results: List[Optional[Dict[str, str]]] = [None] * len(tool_calls)

    def _run(idx: int, tc: Dict[str, Any]) -> tuple[int, Dict[str, str]]:
        fn = (tc.get("function") or {})
        name = fn.get("name") or ""
        raw_args = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
        except Exception:
            args = {}
        t0 = time.time()
        out = dispatch(name, args)
        dt = int((time.time() - t0) * 1000)
        print(f"[llm.tools] {name}({raw_args[:120]}) -> {dt}ms", flush=True)
        return idx, {
            "role": "tool",
            "tool_call_id": tc.get("id") or "",
            "name": name,
            "content": out,
        }

    futs = [_tool_executor.submit(_run, i, tc) for i, tc in enumerate(tool_calls)]
    for fut in as_completed(futs):
        try:
            i, msg = fut.result(timeout=12.0)
            results[i] = msg
        except Exception as e:
            # Hata mesajini bos sloth doldur
            print(f"[llm.tools] paralel dispatch hata: {e}", flush=True)
    # None'lari error placeholder ile doldur
    final: List[Dict[str, str]] = []
    for i, m in enumerate(results):
        if m is None:
            tc = tool_calls[i]
            final.append({
                "role": "tool",
                "tool_call_id": tc.get("id") or "",
                "name": ((tc.get("function") or {}).get("name") or ""),
                "content": json.dumps({"error": "tool timeout"}, ensure_ascii=False),
            })
        else:
            final.append(m)
    return final


# ====================================================================
# TOOL LOOP
# ====================================================================

# Provider whitelist: paralel tool destekli + iyi schema uyumu
_TOOL_CAPABLE_PROVIDERS = {"digitalocean", "openai"}


def is_tool_capable(provider: Optional[str]) -> bool:
    if not provider:
        return False
    return provider.strip().lower() in _TOOL_CAPABLE_PROVIDERS


def run_tool_loop(
    router,
    messages: List[Dict[str, Any]],
    *,
    max_tokens: int,
    temperature: float = 0.4,
    top_p: float = 0.85,
    preferred_provider: Optional[str] = None,
    preferred_model: Optional[str] = None,
    max_iters: int = 3,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """LLM'i tool'lar ile cagir. Tool calls geldikce dispatch et, sonuclari geri besle.

    Returns:
        {"text": str, "model": str, "provider": str, "tokens": int, "tool_trace": [...]}

    Provider tool-capable degilse RuntimeError firlatir (caller fallback path'e
    dusurmeli).
    """
    if not is_tool_capable(preferred_provider):
        raise RuntimeError(
            f"provider '{preferred_provider}' tool calling icin desteklenmiyor"
        )

    tools = tools if tools is not None else TOOL_SCHEMAS
    convo: List[Dict[str, Any]] = list(messages)  # copy
    trace: List[Dict[str, Any]] = []
    total_tokens = 0
    final_model = preferred_model
    final_provider = preferred_provider

    for it in range(max_iters):
        out = router._chat_with_tools_once(
            messages=convo,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            provider=preferred_provider,
            model=preferred_model,
        )
        final_model = out.get("model") or final_model
        final_provider = out.get("provider") or final_provider
        if out.get("tokens"):
            total_tokens += int(out["tokens"])

        assistant_msg = out.get("message") or {}
        tool_calls = assistant_msg.get("tool_calls") or []
        finish_reason = out.get("finish_reason") or ""

        # Stop condition: tool call yoksa veya finish_reason "stop"
        if not tool_calls:
            text = assistant_msg.get("content") or ""
            if isinstance(text, list):
                # Bazi provider'lar list dondurur
                parts = []
                for p in text:
                    if isinstance(p, dict) and isinstance(p.get("text"), str):
                        parts.append(p["text"])
                text = "".join(parts)
            return {
                "text": text or "",
                "model": final_model or "unknown",
                "provider": final_provider or "unknown",
                "tokens": total_tokens or None,
                "tool_trace": trace,
                "iterations": it + 1,
            }

        # Assistant'in tool_call'larini convo'ya ekle (OpenAI protokolu)
        convo.append({
            "role": "assistant",
            "content": assistant_msg.get("content") or None,
            "tool_calls": tool_calls,
        })

        # Tool'lari paralel calistir
        tool_msgs = _dispatch_parallel(tool_calls)
        trace.append({
            "iter": it,
            "calls": [
                {
                    "name": (tc.get("function") or {}).get("name"),
                    "args": (tc.get("function") or {}).get("arguments"),
                }
                for tc in tool_calls
            ],
        })
        # Tool sonuclarini convo'ya ekle
        for tm in tool_msgs:
            convo.append(tm)

        if finish_reason and finish_reason not in ("tool_calls", "function_call"):
            # Provider sinyalle bitti
            break

    # Max iter doldu -> tool'suz son cagri ile finalize
    try:
        finalize = router._chat_with_tools_once(
            messages=convo,
            tools=None,  # tool'larsiz - final cevap
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            provider=preferred_provider,
            model=preferred_model,
        )
        text = (finalize.get("message") or {}).get("content") or ""
        if isinstance(text, list):
            parts = []
            for p in text:
                if isinstance(p, dict) and isinstance(p.get("text"), str):
                    parts.append(p["text"])
            text = "".join(parts)
        if finalize.get("tokens"):
            total_tokens += int(finalize["tokens"])
        return {
            "text": text or "",
            "model": finalize.get("model") or final_model or "unknown",
            "provider": finalize.get("provider") or final_provider or "unknown",
            "tokens": total_tokens or None,
            "tool_trace": trace,
            "iterations": max_iters,
            "max_iters_reached": True,
        }
    except Exception as e:
        return {
            "text": f"(Tool loop tamamlanamadi: {e})",
            "model": final_model or "unknown",
            "provider": final_provider or "unknown",
            "tokens": total_tokens or None,
            "tool_trace": trace,
            "iterations": max_iters,
            "error": str(e),
        }


__all__ = [
    "TOOL_SCHEMAS",
    "dispatch",
    "is_tool_capable",
    "run_tool_loop",
]
