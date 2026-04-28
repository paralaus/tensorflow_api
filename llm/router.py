from __future__ import annotations

import os
import time
import json
from typing import Any, Dict, Iterator, List, Optional, Tuple

import requests


class LlmRouter:
    """Multi-provider LLM router with fallback and simple circuit breaker."""

    def __init__(self) -> None:
        self.provider_order = [
            p.strip().lower()
            for p in os.environ.get("LLM_PROVIDER_ORDER", "groq,together,openai,anthropic").split(",")
            if p.strip()
        ]
        self.failover_enabled = os.environ.get("LLM_FAILOVER_ENABLED", "true").lower() == "true"
        self.request_timeout = float(os.environ.get("LLM_REQUEST_TIMEOUT", "30"))
        self.max_retries = int(os.environ.get("LLM_MAX_RETRIES", "1"))
        self.circuit_fails = int(os.environ.get("LLM_CIRCUIT_FAILS", "3"))
        self.circuit_cooldown_sec = int(os.environ.get("LLM_CIRCUIT_COOLDOWN_SEC", "60"))

        self.models = {
            "groq": os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
            "together": os.environ.get("TOGETHER_MODEL", "meta-llama/Llama-3.3-70B-Instruct-Turbo"),
            "openai": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
            "anthropic": os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022"),
        }
        # detailLevel -> provider:model
        self.detail_routes = {
            "brief": self._parse_route(
                os.environ.get("LLM_ROUTE_BRIEF", "together:Qwen/Qwen3.5-9B-Instruct")
            ),
            "standard": self._parse_route(
                os.environ.get("LLM_ROUTE_STANDARD", "together:gpt-oss-120b")
            ),
            "deep": self._parse_route(
                os.environ.get("LLM_ROUTE_DEEP", "groq:llama-3.3-70b-versatile")
            ),
        }
        self.keys = {
            "groq": os.environ.get("GROQ_API_KEY"),
            "together": os.environ.get("TOGETHER_API_KEY"),
            "openai": os.environ.get("OPENAI_API_KEY"),
            "anthropic": os.environ.get("ANTHROPIC_API_KEY"),
        }

        self._circuit: Dict[str, Dict[str, float]] = {}
        self._groq_stream_client = None
        self._init_groq_stream_client()

    def _init_groq_stream_client(self) -> None:
        key = self.keys.get("groq")
        if not key:
            return
        try:
            from groq import Groq  # type: ignore
            self._groq_stream_client = Groq(
                api_key=key,
                timeout=self.request_timeout,
                max_retries=self.max_retries,
            )
        except Exception:
            self._groq_stream_client = None

    def _is_enabled(self, provider: str) -> bool:
        return bool(self.keys.get(provider))

    def _is_circuit_open(self, provider: str) -> bool:
        state = self._circuit.get(provider) or {}
        open_until = state.get("open_until", 0)
        return open_until > time.time()

    def _record_success(self, provider: str) -> None:
        self._circuit[provider] = {"fails": 0, "open_until": 0}

    def _record_failure(self, provider: str) -> None:
        state = self._circuit.get(provider) or {"fails": 0, "open_until": 0}
        fails = int(state.get("fails", 0)) + 1
        open_until = 0
        if fails >= self.circuit_fails:
            open_until = time.time() + self.circuit_cooldown_sec
        self._circuit[provider] = {"fails": fails, "open_until": open_until}

    def _parse_route(self, raw: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        if not raw or not isinstance(raw, str):
            return None, None
        value = raw.strip()
        if not value:
            return None, None
        if ":" in value:
            provider, model = value.split(":", 1)
            p = provider.strip().lower() or None
            m = model.strip() or None
            return p, m
        return value.lower(), None

    def get_preferred_route(
        self,
        detail_level: str = "standard",
        stream: bool = False,
    ) -> Tuple[Optional[str], Optional[str]]:
        level = (detail_level or "standard").strip().lower()
        if level not in ("brief", "standard", "deep"):
            level = "standard"
        provider, model = self.detail_routes.get(level, (None, None))
        if provider and stream and provider not in ("groq", "together", "openai", "anthropic"):
            return None, None
        return provider, model

    def _openai_compatible_chat(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
    ) -> Dict[str, Any]:
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "stream": False,
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        resp = requests.post(url, headers=headers, json=payload, timeout=self.request_timeout)
        if resp.status_code >= 400:
            raise RuntimeError(f"{url} -> {resp.status_code} {resp.text[:300]}")
        data = resp.json()
        msg = ((data.get("choices") or [{}])[0].get("message")) or {}
        content = msg.get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            # Some providers (and some models) return structured content blocks.
            # Normalize to plain text for downstream code.
            parts: List[str] = []
            for part in content:
                if isinstance(part, str):
                    if part:
                        parts.append(part)
                elif isinstance(part, dict):
                    txt = part.get("text")
                    if isinstance(txt, str) and txt:
                        parts.append(txt)
            text = "".join(parts)
        elif isinstance(content, dict):
            txt = content.get("text")
            if isinstance(txt, str):
                text = txt
        usage = data.get("usage") or {}
        if not isinstance(text, str) or not text.strip():
            # Treat empty content as provider failure so router can fail over.
            raise RuntimeError(f"{url} -> empty content in successful response")
        return {
            "text": text,
            "model": data.get("model") or model,
            "tokens": usage.get("total_tokens"),
        }

    def _anthropic_chat(
        self,
        api_key: str,
        model: str,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
    ) -> Dict[str, Any]:
        system_lines: List[str] = []
        convo: List[dict] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(content, str):
                continue
            if role == "system":
                system_lines.append(content)
            elif role in ("user", "assistant"):
                convo.append({"role": role, "content": content})

        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": "\n\n".join(system_lines).strip(),
            "messages": convo,
        }
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers=headers,
            json=payload,
            timeout=self.request_timeout,
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"anthropic -> {resp.status_code} {resp.text[:300]}")
        data = resp.json()
        content_items = data.get("content") or []
        text = ""
        for item in content_items:
            if isinstance(item, dict) and item.get("type") == "text":
                text += item.get("text") or ""
        usage = data.get("usage") or {}
        return {
            "text": text,
            "model": data.get("model") or model,
            "tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        }

    def _anthropic_stream(
        self,
        api_key: str,
        model: str,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
    ) -> Iterator[str]:
        system_lines: List[str] = []
        convo: List[dict] = []
        for m in messages:
            role = m.get("role")
            content = m.get("content")
            if not isinstance(content, str):
                continue
            if role == "system":
                system_lines.append(content)
            elif role in ("user", "assistant"):
                convo.append({"role": role, "content": content})

        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": "\n\n".join(system_lines).strip(),
            "messages": convo,
            "stream": True,
        }
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "accept": "text/event-stream",
        }

        with requests.post(
            "https://api.anthropic.com/v1/messages",
            headers=headers,
            json=payload,
            timeout=self.request_timeout,
            stream=True,
        ) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"anthropic stream -> {resp.status_code} {resp.text[:300]}")

            current_event: Optional[str] = None
            for raw_line in resp.iter_lines(decode_unicode=True):
                if raw_line is None:
                    continue
                line = raw_line.strip()
                if not line:
                    current_event = None
                    continue
                if line.startswith("event:"):
                    current_event = line.split(":", 1)[1].strip()
                    continue
                if not line.startswith("data:"):
                    continue

                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    obj = json.loads(data)
                except Exception:
                    continue

                evt = current_event or obj.get("type")
                if evt == "content_block_delta":
                    delta = obj.get("delta") or {}
                    txt = delta.get("text")
                    if isinstance(txt, str) and txt:
                        yield txt
                elif evt == "message_delta":
                    # Usage / stop_reason gibi metadata eventleri
                    continue
                elif evt == "error":
                    err = obj.get("error") or obj
                    raise RuntimeError(f"anthropic stream error: {err}")

    def _call_provider(
        self,
        provider: str,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
        model_override: Optional[str] = None,
    ) -> Dict[str, Any]:
        key = self.keys.get(provider)
        if not key:
            raise RuntimeError(f"{provider}: api key missing")
        model = model_override or self.models.get(provider)

        if provider == "groq":
            return self._openai_compatible_chat(
                base_url="https://api.groq.com/openai/v1",
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
            )
        if provider == "together":
            return self._openai_compatible_chat(
                base_url="https://api.together.xyz/v1",
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
            )
        if provider == "openai":
            return self._openai_compatible_chat(
                base_url="https://api.openai.com/v1",
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
            )
        if provider == "anthropic":
            return self._anthropic_chat(
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        raise RuntimeError(f"unsupported provider: {provider}")

    def _stream_openai_compatible(
        self,
        base_url: str,
        api_key: str,
        model: str,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
    ) -> Iterator[str]:
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "stream": True,
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        with requests.post(
            url,
            headers=headers,
            json=payload,
            timeout=self.request_timeout,
            stream=True,
        ) as resp:
            if resp.status_code >= 400:
                raise RuntimeError(f"{url} -> {resp.status_code} {resp.text[:300]}")
            for raw_line in resp.iter_lines(decode_unicode=True):
                if not raw_line:
                    continue
                line = raw_line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                delta = (((obj.get("choices") or [{}])[0].get("delta")) or {})
                content = delta.get("content")
                if isinstance(content, str) and content:
                    yield content
                elif isinstance(content, list):
                    # Some providers may return array chunks
                    for part in content:
                        if isinstance(part, dict):
                            txt = part.get("text")
                            if isinstance(txt, str) and txt:
                                yield txt

    def _stream_provider(
        self,
        provider: str,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
        model_override: Optional[str] = None,
    ) -> Iterator[str]:
        key = self.keys.get(provider)
        if not key:
            raise RuntimeError(f"{provider}: api key missing")
        model = model_override or self.models.get(provider)

        if provider == "groq":
            # Groq SDK stream -> normalize to text chunks
            if not self._groq_stream_client:
                raise RuntimeError("groq streaming client unavailable")
            params = {
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "top_p": top_p,
                "stream": True,
            }
            stream = self._groq_stream_client.chat.completions.create(**params)
            for chunk in stream:
                try:
                    if chunk.choices and len(chunk.choices) > 0:
                        delta = chunk.choices[0].delta
                        if delta and delta.content:
                            yield delta.content
                except Exception:
                    continue
            return

        if provider == "together":
            yield from self._stream_openai_compatible(
                base_url="https://api.together.xyz/v1",
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
            )
            return

        if provider == "openai":
            yield from self._stream_openai_compatible(
                base_url="https://api.openai.com/v1",
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                top_p=top_p,
            )
            return

        if provider == "anthropic":
            yield from self._anthropic_stream(
                api_key=key,
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
            return

        raise RuntimeError(f"streaming unsupported for provider: {provider}")

    def _provider_candidates(self, preferred_provider: Optional[str] = None) -> List[str]:
        if preferred_provider:
            preferred = preferred_provider.strip().lower()
            rest = [p for p in self.provider_order if p != preferred]
            return [preferred] + rest
        return list(self.provider_order)

    def chat(
        self,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
        preferred_provider: Optional[str] = None,
        preferred_model: Optional[str] = None,
    ) -> Dict[str, Any]:
        candidates = self._provider_candidates(preferred_provider)
        attempts: List[str] = []
        last_err: Optional[Exception] = None

        for provider in candidates:
            if not self._is_enabled(provider):
                continue
            if self._is_circuit_open(provider):
                continue
            attempts.append(provider)
            t0 = time.time()
            try:
                if preferred_model and provider == (preferred_provider or "").strip().lower():
                    out = self._call_provider(
                        provider, messages, max_tokens, temperature, top_p, model_override=preferred_model
                    )
                else:
                    out = self._call_provider(provider, messages, max_tokens, temperature, top_p)
                self._record_success(provider)
                out["provider"] = provider
                out["latency_ms"] = int((time.time() - t0) * 1000)
                out["attempts"] = attempts
                return out
            except Exception as e:
                last_err = e
                self._record_failure(provider)
                if not self.failover_enabled:
                    break

        raise RuntimeError(f"all providers failed; attempts={attempts}; last={last_err}")

    def stream_chat(
        self,
        messages: List[dict],
        max_tokens: int,
        temperature: float,
        top_p: float,
        preferred_provider: Optional[str] = None,
        preferred_model: Optional[str] = None,
    ):
        """Streaming support (phase-2): Groq, Together, OpenAI."""
        candidates = self._provider_candidates(preferred_provider)
        last_err: Optional[Exception] = None
        for provider in candidates:
            if provider not in ("groq", "together", "openai", "anthropic"):
                continue
            if not self._is_enabled(provider):
                continue
            if self._is_circuit_open(provider):
                continue
            try:
                return self._stream_provider(
                    provider=provider,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    top_p=top_p,
                    model_override=(
                        preferred_model if provider == (preferred_provider or "").strip().lower() else None
                    ),
                )
            except Exception as e:
                last_err = e
                self._record_failure(provider)
                if not self.failover_enabled:
                    break
                continue
        raise RuntimeError(f"streaming providers failed; last={last_err}")

    def status(self) -> Dict[str, Any]:
        enabled = {p: self._is_enabled(p) for p in self.provider_order}
        open_circuit = {p: self._is_circuit_open(p) for p in self.provider_order}
        resolved_routes: Dict[str, Dict[str, Any]] = {}
        for level in ("brief", "standard", "deep"):
            provider, model = self.get_preferred_route(level, stream=False)
            resolved_routes[level] = {
                "provider": provider,
                "model": model or (self.models.get(provider) if provider else None),
                "enabled": bool(provider and enabled.get(provider, False)),
                "circuit_open": bool(provider and open_circuit.get(provider, False)),
            }
        return {
            "order": self.provider_order,
            "enabled": enabled,
            "circuit_open": open_circuit,
            "streaming": {
                "groq": bool(self._groq_stream_client) and bool(self.keys.get("groq")),
                "together": bool(self.keys.get("together")),
                "openai": bool(self.keys.get("openai")),
                "anthropic": bool(self.keys.get("anthropic")),
            },
            "models": self.models,
            "detail_routes": self.detail_routes,
            "detail_routes_resolved": resolved_routes,
        }
