#!/usr/bin/env python3
"""
Train a LoRA adapter for a chat model using SFT.

Example:
python scripts/train_lora.py ^
  --model-name meta-llama/Meta-Llama-3-8B-Instruct ^
  --train-file data/finetune/train.jsonl ^
  --val-file data/finetune/val.jsonl ^
  --output-dir outputs/hissechat-lora
"""

from __future__ import annotations

import argparse
import inspect
from pathlib import Path
from typing import Dict, List

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import AutoModelForCausalLM, AutoTokenizer


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LoRA fine-tuning for chat models.")
    parser.add_argument("--model-name", required=True, help="HF base model id/path.")
    parser.add_argument("--train-file", required=True, help="Prepared train JSONL path.")
    parser.add_argument("--val-file", default="", help="Prepared validation JSONL path (optional).")
    parser.add_argument("--no-eval", action="store_true", help="Disable evaluation stage.")
    parser.add_argument("--output-dir", required=True, help="Output directory for adapter.")
    parser.add_argument("--max-seq-len", type=int, default=2048)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--train-batch-size", type=int, default=1)
    parser.add_argument("--eval-batch-size", type=int, default=1)
    parser.add_argument("--grad-accum-steps", type=int, default=8)
    parser.add_argument("--warmup-ratio", type=float, default=0.03)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--logging-steps", type=int, default=10)
    parser.add_argument("--eval-steps", type=int, default=100)
    parser.add_argument("--save-steps", type=int, default=100)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--load-in-4bit", action="store_true")
    parser.add_argument("--bf16", action="store_true")
    parser.add_argument("--fp16", action="store_true")
    return parser.parse_args()


def _simple_chat_template(messages: List[Dict[str, str]]) -> str:
    parts: List[str] = []
    for m in messages:
        role = m.get("role", "").strip().lower()
        content = str(m.get("content", "")).strip()
        if not content:
            continue
        parts.append(f"<|{role}|>\n{content}")
    return "\n\n".join(parts)


def main() -> None:
    args = parse_args()

    try:
        from trl import SFTConfig, SFTTrainer
    except Exception as exc:  # pragma: no cover - runtime dependency
        raise RuntimeError(
            "trl paketi gerekli. `pip install -r requirements-finetune.txt` calistirin."
        ) from exc

    use_eval = (not args.no_eval) and bool(args.val_file)
    if use_eval:
        val_path = Path(args.val_file)
        if (not val_path.exists()) or val_path.stat().st_size == 0:
            use_eval = False
            print("[train_lora] validation file missing/empty; training will continue without eval.")

    data_files = {"train": args.train_file}
    if use_eval:
        data_files["validation"] = args.val_file
    dataset = load_dataset("json", data_files=data_files)

    tokenizer = AutoTokenizer.from_pretrained(args.model_name, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model_kwargs = {}
    if args.load_in_4bit:
        model_kwargs["load_in_4bit"] = True
        model_kwargs["torch_dtype"] = torch.bfloat16 if args.bf16 else torch.float16
    elif args.bf16:
        model_kwargs["torch_dtype"] = torch.bfloat16
    elif args.fp16:
        model_kwargs["torch_dtype"] = torch.float16

    model = AutoModelForCausalLM.from_pretrained(args.model_name, **model_kwargs)
    model.config.use_cache = False

    if args.load_in_4bit:
        model = prepare_model_for_kbit_training(model)

    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "up_proj", "down_proj", "gate_proj"],
    )

    def formatting_prompts_func(example: Dict) -> str:
        messages = example.get("messages") or []
        if hasattr(tokenizer, "apply_chat_template") and tokenizer.chat_template:
            return tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=False,
            )
        return _simple_chat_template(messages)

    sft_config_params = inspect.signature(SFTConfig).parameters
    config_kwargs = dict(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.train_batch_size,
        per_device_eval_batch_size=args.eval_batch_size,
        gradient_accumulation_steps=args.grad_accum_steps,
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        warmup_ratio=args.warmup_ratio,
        weight_decay=args.weight_decay,
        logging_steps=args.logging_steps,
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=2,
        bf16=args.bf16,
        fp16=args.fp16 and not args.bf16,
        report_to=[],
    )

    # TRL version compatibility:
    # - newer: max_seq_length
    # - some versions: max_length
    if "max_seq_length" in sft_config_params:
        config_kwargs["max_seq_length"] = args.max_seq_len
    elif "max_length" in sft_config_params:
        config_kwargs["max_length"] = args.max_seq_len

    if "eval_strategy" in sft_config_params:
        config_kwargs["eval_strategy"] = "steps" if use_eval else "no"
    elif "evaluation_strategy" in sft_config_params:
        config_kwargs["evaluation_strategy"] = "steps" if use_eval else "no"

    if use_eval and "eval_steps" in sft_config_params:
        config_kwargs["eval_steps"] = args.eval_steps

    training_args = SFTConfig(**config_kwargs)

    trainer_kwargs = dict(
        model=model,
        args=training_args,
        train_dataset=dataset["train"],
        eval_dataset=dataset["validation"] if use_eval else None,
        peft_config=peft_config,
        formatting_func=formatting_prompts_func,
    )

    trainer_params = inspect.signature(SFTTrainer).parameters
    if "processing_class" in trainer_params:
        trainer_kwargs["processing_class"] = tokenizer
    elif "tokenizer" in trainer_params:
        trainer_kwargs["tokenizer"] = tokenizer
    else:
        # Last-resort compatibility for unusual TRL versions.
        trainer_kwargs["tokenizer"] = tokenizer

    trainer = SFTTrainer(**trainer_kwargs)

    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print(f"LoRA adapter saved to: {args.output_dir}")


if __name__ == "__main__":
    main()
