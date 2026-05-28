#!/usr/bin/env python3
"""
One-command pipeline:
  1) Export JSONL from Mongo (optional)
  2) Prepare train/val/test datasets
  3) Run LoRA training (optional)
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from typing import List


def _run(cmd: List[str]) -> None:
    printable = " ".join(shlex.quote(x) for x in cmd)
    print(f"\n>>> {printable}\n")
    subprocess.run(cmd, check=True)


def _count_jsonl_rows(path: Path) -> int:
    if not path.exists():
        return 0
    count = 0
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                count += 1
    return count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run export + prepare + train pipeline.")

    # Shared paths
    parser.add_argument("--raw-output", default="data/raw/chat_qa.jsonl")
    parser.add_argument("--prepared-dir", default="data/finetune")
    parser.add_argument("--model-name", default="meta-llama/Meta-Llama-3-8B-Instruct")
    parser.add_argument("--adapter-output", default="outputs/hissechat-lora")
    parser.add_argument("--python-bin", default=sys.executable, help="Python executable path")

    # Stage toggles
    parser.add_argument("--skip-export", action="store_true")
    parser.add_argument("--skip-train", action="store_true")

    # Export options
    parser.add_argument("--mongo-uri", default="")
    parser.add_argument("--db", default="")
    parser.add_argument("--collection", default="")
    parser.add_argument(
        "--backend-env",
        default="",
        help="Optional backend .env path to auto-read MONGODB_URL and db name",
    )
    parser.add_argument("--mode", choices=["qa", "messages"], default="qa")
    parser.add_argument("--query", default="{}")
    parser.add_argument("--limit", type=int, default=50000)
    parser.add_argument("--sort-field", default="createdAt")
    parser.add_argument("--sort-direction", type=int, default=-1, choices=[-1, 1])
    parser.add_argument("--user-field", default="question")
    parser.add_argument("--assistant-field", default="answer")
    parser.add_argument("--context-field", default="context")
    parser.add_argument("--system-field", default="")
    parser.add_argument("--messages-field", default="messages")
    parser.add_argument("--role-field", default="role")
    parser.add_argument("--content-field", default="content")

    # Prepare options
    parser.add_argument("--train-ratio", type=float, default=0.9)
    parser.add_argument("--val-ratio", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=42)

    # Train options
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument("--train-batch-size", type=int, default=1)
    parser.add_argument("--eval-batch-size", type=int, default=1)
    parser.add_argument("--grad-accum-steps", type=int, default=8)
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--bf16", action="store_true")
    parser.add_argument("--fp16", action="store_true")
    parser.add_argument("--load-in-4bit", action="store_true")

    return parser.parse_args()


def _read_env_value(env_path: Path, key: str) -> str:
    if not env_path.exists():
        return ""
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return ""
    prefix = f"{key}="
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith(prefix):
            return line[len(prefix) :].strip().strip('"').strip("'")
    return ""


def _read_first_env_value(env_path: Path, keys: List[str]) -> str:
    for key in keys:
        value = _read_env_value(env_path, key)
        if value:
            return value
    return ""


def _infer_db_name_from_mongo_uri(uri: str) -> str:
    if not uri:
        return ""
    parsed = urlparse(uri)
    # mongodb+srv://.../borsa?retryWrites=true  -> "/borsa"
    path = (parsed.path or "").strip("/")
    if not path:
        return ""
    # keep only first segment as db name
    return path.split("/")[0].strip()


def main() -> None:
    args = parse_args()
    py = args.python_bin

    raw_output = Path(args.raw_output)
    prepared_dir = Path(args.prepared_dir)

    mongo_uri = args.mongo_uri
    db_name = args.db
    collection = args.collection

    if args.backend_env:
        env_path = Path(args.backend_env)
        if not mongo_uri:
            mongo_uri = _read_first_env_value(
                env_path,
                ["MONGODB_URI", "MONGODB_URL"],
            )
        if not db_name:
            db_name = _infer_db_name_from_mongo_uri(mongo_uri)

    if not args.skip_export:
        if not mongo_uri or not db_name or not collection:
            raise ValueError(
                "--skip-export verilmediyse mongo-uri/db/collection gerekli. "
                "--backend-env ile MONGODB_URL ve db otomatik doldurulabilir."
            )

        export_cmd = [
            py,
            "scripts/export_training_data.py",
            "--mongo-uri",
            mongo_uri,
            "--db",
            db_name,
            "--collection",
            collection,
            "--mode",
            args.mode,
            "--query",
            args.query,
            "--limit",
            str(args.limit),
            "--sort-field",
            args.sort_field,
            "--sort-direction",
            str(args.sort_direction),
            "--output",
            str(raw_output),
        ]

        if args.mode == "qa":
            export_cmd.extend(
                [
                    "--user-field",
                    args.user_field,
                    "--assistant-field",
                    args.assistant_field,
                    "--context-field",
                    args.context_field,
                ]
            )
            if args.system_field:
                export_cmd.extend(["--system-field", args.system_field])
        else:
            export_cmd.extend(
                [
                    "--messages-field",
                    args.messages_field,
                    "--role-field",
                    args.role_field,
                    "--content-field",
                    args.content_field,
                ]
            )

        _run(export_cmd)

    prepare_cmd = [
        py,
        "scripts/prepare_finetune_dataset.py",
        "--input",
        str(raw_output),
        "--output-dir",
        str(prepared_dir),
        "--train-ratio",
        str(args.train_ratio),
        "--val-ratio",
        str(args.val_ratio),
        "--seed",
        str(args.seed),
    ]
    _run(prepare_cmd)

    if args.skip_train:
        print("\nTraining skipped by --skip-train.")
        return

    train_cmd = [
        py,
        "scripts/train_lora.py",
        "--model-name",
        args.model_name,
        "--train-file",
        str(prepared_dir / "train.jsonl"),
        "--output-dir",
        args.adapter_output,
        "--epochs",
        str(args.epochs),
        "--learning-rate",
        str(args.learning_rate),
        "--max-seq-len",
        str(args.max_seq_len),
        "--train-batch-size",
        str(args.train_batch_size),
        "--eval-batch-size",
        str(args.eval_batch_size),
        "--grad-accum-steps",
        str(args.grad_accum_steps),
        "--warmup-ratio",
        str(args.warmup_ratio),
        "--weight-decay",
        str(args.weight_decay),
    ]

    val_file = prepared_dir / "val.jsonl"
    val_rows = _count_jsonl_rows(val_file)
    if val_rows > 0:
        train_cmd.extend(["--val-file", str(val_file)])
    else:
        train_cmd.append("--no-eval")
        print("[pipeline] validation split empty; running train without eval.")
    if args.bf16:
        train_cmd.append("--bf16")
    if args.fp16:
        train_cmd.append("--fp16")
    if args.load_in_4bit:
        train_cmd.append("--load-in-4bit")

    _run(train_cmd)
    print(f"\nPipeline completed. Adapter path: {args.adapter_output}")


if __name__ == "__main__":
    main()
