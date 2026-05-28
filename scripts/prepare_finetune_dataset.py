#!/usr/bin/env python3
"""
Prepare a supervised fine-tuning dataset from app logs / exports.

Supported input record shapes (JSONL):
1) {"question": "...", "answer": "...", "context": "...", "system": "..."}
2) {"prompt": "...", "response": "...", "context": "..."}
3) {"messages": [{"role":"system|user|assistant","content":"..."}]}

Output format (JSONL):
{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path
from typing import Dict, List, Optional, Tuple


DEFAULT_SYSTEM_PROMPT = (
    "Sen Hisse Chat uygulamasinin finans odakli AI asistanisin. "
    "Yaniti kisa, tutarli ve kullanici sorusuna dogrudan olacak sekilde ver."
)


def _clean_text(value: object) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r", "\n")
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join([line for line in lines if line])
    return text.strip()


def _extract_from_messages(record: Dict, default_system: str) -> Optional[List[Dict[str, str]]]:
    raw_messages = record.get("messages")
    if not isinstance(raw_messages, list) or not raw_messages:
        return None

    messages: List[Dict[str, str]] = []
    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        role = _clean_text(item.get("role")).lower()
        content = _clean_text(item.get("content"))
        if role not in {"system", "user", "assistant"}:
            continue
        if not content:
            continue
        messages.append({"role": role, "content": content})

    if not messages:
        return None

    has_user = any(m["role"] == "user" for m in messages)
    has_assistant = any(m["role"] == "assistant" for m in messages)
    if not has_user or not has_assistant:
        return None

    has_system = any(m["role"] == "system" for m in messages)
    if not has_system:
        messages.insert(0, {"role": "system", "content": default_system})
    return messages


def _extract_from_qa(record: Dict, default_system: str) -> Optional[List[Dict[str, str]]]:
    question = _clean_text(record.get("question") or record.get("prompt") or record.get("input"))
    answer = _clean_text(record.get("answer") or record.get("response") or record.get("output"))
    context = _clean_text(record.get("context") or record.get("marketContext"))
    system = _clean_text(record.get("system")) or default_system

    if not question or not answer:
        return None

    if context:
        user_content = f"Soru:\n{question}\n\nBaglam:\n{context}"
    else:
        user_content = question

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
        {"role": "assistant", "content": answer},
    ]


def normalize_record(record: Dict, default_system: str) -> Optional[Dict[str, List[Dict[str, str]]]]:
    messages = _extract_from_messages(record, default_system)
    if messages is None:
        messages = _extract_from_qa(record, default_system)
    if messages is None:
        return None
    return {"messages": messages}


def pair_signature(item: Dict[str, List[Dict[str, str]]]) -> str:
    user = ""
    assistant = ""
    for msg in item["messages"]:
        if msg["role"] == "user" and not user:
            user = msg["content"]
        if msg["role"] == "assistant":
            assistant = msg["content"]
    raw = f"{user}\n---\n{assistant}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def split_dataset(
    rows: List[Dict[str, List[Dict[str, str]]]],
    train_ratio: float,
    val_ratio: float,
    seed: int,
) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    random.Random(seed).shuffle(rows)
    n = len(rows)
    n_train = int(n * train_ratio)
    n_val = int(n * val_ratio)
    train = rows[:n_train]
    val = rows[n_train : n_train + n_val]
    test = rows[n_train + n_val :]
    return train, val, test


def write_jsonl(path: Path, rows: List[Dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare fine-tuning dataset from JSONL.")
    parser.add_argument("--input", required=True, help="Input JSONL file path.")
    parser.add_argument("--output-dir", required=True, help="Output directory.")
    parser.add_argument("--train-ratio", type=float, default=0.9)
    parser.add_argument("--val-ratio", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--min-user-chars", type=int, default=6)
    parser.add_argument("--min-assistant-chars", type=int, default=6)
    parser.add_argument("--default-system", default=DEFAULT_SYSTEM_PROMPT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    prepared: List[Dict[str, List[Dict[str, str]]]] = []
    seen = set()
    total = 0
    skipped = 0

    with input_path.open("r", encoding="utf-8") as f:
        for line in f:
            total += 1
            line = line.strip()
            if not line:
                skipped += 1
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                skipped += 1
                continue
            if not isinstance(record, dict):
                skipped += 1
                continue

            normalized = normalize_record(record, args.default_system)
            if normalized is None:
                skipped += 1
                continue

            first_user = next((m["content"] for m in normalized["messages"] if m["role"] == "user"), "")
            last_assistant = ""
            for msg in normalized["messages"]:
                if msg["role"] == "assistant":
                    last_assistant = msg["content"]

            if len(first_user) < args.min_user_chars or len(last_assistant) < args.min_assistant_chars:
                skipped += 1
                continue

            sig = pair_signature(normalized)
            if sig in seen:
                skipped += 1
                continue
            seen.add(sig)
            prepared.append(normalized)

    if not prepared:
        raise RuntimeError("No valid rows found. Check input schema and filters.")

    train, val, test = split_dataset(prepared, args.train_ratio, args.val_ratio, args.seed)

    write_jsonl(output_dir / "train.jsonl", train)
    write_jsonl(output_dir / "val.jsonl", val)
    write_jsonl(output_dir / "test.jsonl", test)

    meta = {
        "input": str(input_path),
        "total_rows": total,
        "accepted_rows": len(prepared),
        "skipped_rows": skipped,
        "train_rows": len(train),
        "val_rows": len(val),
        "test_rows": len(test),
        "seed": args.seed,
    }
    with (output_dir / "meta.json").open("w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
