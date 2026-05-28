#!/usr/bin/env python3
"""
Export chat records from MongoDB into JSONL for fine-tuning preparation.

Output shapes:
1) qa:
   {"question":"...","answer":"...","context":"...","system":"..."}
2) messages:
   {"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from pymongo import MongoClient


def _clean(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r", "\n")
    lines = [line.strip() for line in text.split("\n")]
    return "\n".join([line for line in lines if line]).strip()


def _load_query(raw_query: str) -> Dict[str, Any]:
    if not raw_query:
        return {}
    try:
        query = json.loads(raw_query)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid --query JSON: {exc}") from exc
    if not isinstance(query, dict):
        raise ValueError("--query must be a JSON object")
    return query


def _build_projection(fields: Iterable[str]) -> Dict[str, int]:
    projection: Dict[str, int] = {"_id": 1}
    for f in fields:
        ff = str(f).strip()
        if ff:
            projection[ff] = 1
    return projection


def _to_qa_record(
    doc: Dict[str, Any],
    user_field: str,
    assistant_field: str,
    context_field: Optional[str],
    system_field: Optional[str],
) -> Optional[Dict[str, str]]:
    question = _clean(doc.get(user_field))
    answer = _clean(doc.get(assistant_field))
    context = _clean(doc.get(context_field)) if context_field else ""
    system = _clean(doc.get(system_field)) if system_field else ""

    if not question or not answer:
        return None

    out = {"question": question, "answer": answer}
    if context:
        out["context"] = context
    if system:
        out["system"] = system
    return out


def _normalize_role(role: Any) -> str:
    value = _clean(role).lower()
    if value in {"user", "assistant", "system"}:
        return value
    if value in {"human", "customer"}:
        return "user"
    if value in {"ai", "bot", "model"}:
        return "assistant"
    return ""


def _to_messages_record(
    doc: Dict[str, Any],
    messages_field: str,
    role_field: str,
    content_field: str,
) -> Optional[Dict[str, List[Dict[str, str]]]]:
    raw_messages = doc.get(messages_field)
    if not isinstance(raw_messages, list):
        return None

    messages: List[Dict[str, str]] = []
    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        role = _normalize_role(item.get(role_field))
        content = _clean(item.get(content_field))
        if not role or not content:
            continue
        messages.append({"role": role, "content": content})

    has_user = any(m["role"] == "user" for m in messages)
    has_assistant = any(m["role"] == "assistant" for m in messages)
    if not has_user or not has_assistant:
        return None
    return {"messages": messages}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export training records from MongoDB.")
    parser.add_argument("--mongo-uri", required=True, help="Mongo URI")
    parser.add_argument("--db", required=True, help="Mongo database name")
    parser.add_argument("--collection", required=True, help="Collection name")
    parser.add_argument("--output", required=True, help="Output JSONL path")
    parser.add_argument("--query", default="{}", help="Mongo query as JSON string")
    parser.add_argument("--limit", type=int, default=50000, help="Max docs to export")
    parser.add_argument("--sort-field", default="createdAt", help="Sort field")
    parser.add_argument("--sort-direction", type=int, default=-1, choices=[-1, 1], help="Sort direction")
    parser.add_argument(
        "--mode",
        default="qa",
        choices=["qa", "messages"],
        help="qa: map question/answer fields, messages: map nested messages array",
    )
    parser.add_argument("--user-field", default="question", help="Question field (qa mode)")
    parser.add_argument("--assistant-field", default="answer", help="Answer field (qa mode)")
    parser.add_argument("--context-field", default="", help="Context field (qa mode, optional)")
    parser.add_argument("--system-field", default="", help="System field (qa mode, optional)")
    parser.add_argument("--messages-field", default="messages", help="Messages array field (messages mode)")
    parser.add_argument("--role-field", default="role", help="Role field inside each message")
    parser.add_argument("--content-field", default="content", help="Content field inside each message")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    query = _load_query(args.query)

    projection_fields = [args.sort_field]
    if args.mode == "qa":
        projection_fields.extend([args.user_field, args.assistant_field])
        if args.context_field:
            projection_fields.append(args.context_field)
        if args.system_field:
            projection_fields.append(args.system_field)
    else:
        projection_fields.append(args.messages_field)

    projection = _build_projection(projection_fields)

    client = MongoClient(args.mongo_uri)
    coll = client[args.db][args.collection]

    cursor = (
        coll.find(query, projection=projection)
        .sort(args.sort_field, args.sort_direction)
        .limit(args.limit)
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total = 0
    written = 0
    skipped = 0

    with output_path.open("w", encoding="utf-8") as f:
        for doc in cursor:
            total += 1
            if args.mode == "qa":
                row = _to_qa_record(
                    doc=doc,
                    user_field=args.user_field,
                    assistant_field=args.assistant_field,
                    context_field=args.context_field or None,
                    system_field=args.system_field or None,
                )
            else:
                row = _to_messages_record(
                    doc=doc,
                    messages_field=args.messages_field,
                    role_field=args.role_field,
                    content_field=args.content_field,
                )

            if row is None:
                skipped += 1
                continue

            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            written += 1

    stats = {
        "collection": args.collection,
        "mode": args.mode,
        "total_read": total,
        "written": written,
        "skipped": skipped,
        "output": str(output_path),
    }
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
