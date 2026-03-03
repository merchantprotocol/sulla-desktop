#!/usr/bin/env python3
"""
train_nightly.py — Sulla nightly LoRA fine-tuning pipeline.

Workflow:
  1. Reads new conversations from feedback_queue/*.jsonl
  2. Combines with replay buffer (past training data)
  3. Loads document knowledge (from documents_processor.py output)
  4. Trains a LoRA adapter (1–3 epochs)
  5. Evaluates on test_set/ if present
  6. Merges adapter into base model
  7. Exports a new GGUF quantized model
  8. Moves the new GGUF into models/ for llama-server hot-reload

Usage:
  python train_nightly.py --model unsloth/Qwen3.5-9B --llm-root /path/to/llm

Environment:
  Runs inside the .venv created by LlamaCppService.installTrainingDeps().
  On macOS uses MLX backend; on Linux/Windows uses CUDA.
"""

import argparse
import glob
import json
import os
import shutil
import sys
from pathlib import Path


def load_feedback(feedback_dir: Path):
    """Load all JSONL files from a directory."""
    conversations = []
    pattern = str(feedback_dir / "*.jsonl")
    for fpath in sorted(glob.glob(pattern)):
        with open(fpath, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    conversations.append(json.loads(line))
    return conversations


def save_replay_buffer(replay_path: Path, conversations: list):
    """Append new conversations to the replay buffer."""
    with open(replay_path, "a") as f:
        for conv in conversations:
            f.write(json.dumps(conv) + "\n")


def load_replay_buffer(replay_path: Path, max_entries: int = 5000):
    """Load the replay buffer, keeping only the most recent entries."""
    if not replay_path.exists():
        return []
    entries = []
    with open(replay_path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    return entries[-max_entries:]


def format_for_sft(conversations: list):
    """Convert conversation dicts to Unsloth SFT format."""
    formatted = []
    for conv in conversations:
        messages = conv.get("messages", [])
        if not messages:
            continue
        formatted.append({"messages": messages})
    return formatted


def main():
    parser = argparse.ArgumentParser(description="Sulla nightly LoRA training")
    parser.add_argument("--model", required=True, help="HuggingFace model ID (e.g. unsloth/Qwen3.5-9B)")
    parser.add_argument("--llm-root", required=True, help="Absolute path to the llm/ directory")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: <llm-root>/training/output)")
    parser.add_argument("--epochs", type=int, default=2, help="Training epochs (default: 2)")
    parser.add_argument("--batch-size", type=int, default=2, help="Batch size (default: 2)")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate (default: 2e-4)")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank (default: 16)")
    parser.add_argument("--quant-method", default="q4_k_m", help="GGUF quant method (default: q4_k_m)")
    args = parser.parse_args()

    llm_root = Path(args.llm_root)
    training_dir = llm_root / "training"
    feedback_dir = llm_root / "feedback_queue"
    models_dir = llm_root / "models"
    output_dir = Path(args.output_dir) if args.output_dir else training_dir / "output"
    replay_path = training_dir / "replay_buffer.jsonl"

    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Load new feedback
    new_convs = load_feedback(feedback_dir)
    if not new_convs:
        print("[train_nightly] No new feedback data found. Nothing to train on.")
        sys.exit(0)

    print(f"[train_nightly] Loaded {len(new_convs)} new conversations from feedback queue")

    # 2. Combine with replay buffer
    save_replay_buffer(replay_path, new_convs)
    all_convs = load_replay_buffer(replay_path)
    training_data = format_for_sft(all_convs)

    # 2b. Include document knowledge (produced by documents_processor.py)
    documents_knowledge_path = training_dir / "documents_knowledge.jsonl"
    if documents_knowledge_path.exists():
        doc_count = 0
        with open(documents_knowledge_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    training_data.append(json.loads(line))
                    doc_count += 1
        print(f"[train_nightly] Loaded {doc_count} document knowledge entries")

    print(f"[train_nightly] Total training samples: {len(training_data)}")

    if len(training_data) < 5:
        print("[train_nightly] Need at least 5 training samples. Waiting for more feedback.")
        sys.exit(0)

    # 3. Load model with Unsloth
    try:
        from unsloth import FastLanguageModel
    except ImportError:
        print("[train_nightly] ERROR: unsloth not installed. Run installTrainingDeps() first.")
        sys.exit(1)

    print(f"[train_nightly] Loading model: {args.model}")
    model, tokenizer = FastLanguageModel.get_peft_model(
        FastLanguageModel.from_pretrained(
            model_name=args.model,
            max_seq_length=2048,
            dtype=None,  # auto-detect
            load_in_4bit=True,
        )[0],
        r=args.lora_r,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                         "gate_proj", "up_proj", "down_proj"],
        lora_alpha=args.lora_r,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
    )

    # 4. Prepare dataset
    from datasets import Dataset
    dataset = Dataset.from_list(training_data)

    from trl import SFTTrainer
    from transformers import TrainingArguments

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        args=TrainingArguments(
            per_device_train_batch_size=args.batch_size,
            gradient_accumulation_steps=4,
            warmup_steps=5,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            fp16=not os.environ.get("UNSLOTH_MLX"),  # fp16 on CUDA, not on MLX
            bf16=bool(os.environ.get("UNSLOTH_MLX")),
            logging_steps=1,
            output_dir=str(output_dir / "checkpoints"),
            optim="adamw_8bit",
            seed=42,
        ),
        max_seq_length=2048,
    )

    print("[train_nightly] Starting LoRA training...")
    trainer.train()

    # 5. Evaluate on test_set if present
    test_dir = training_dir / "test_set"
    if test_dir.exists():
        test_convs = load_feedback(test_dir)
        if test_convs:
            test_data = format_for_sft(test_convs)
            test_dataset = Dataset.from_list(test_data)
            metrics = trainer.evaluate(eval_dataset=test_dataset)
            print(f"[train_nightly] Eval metrics: {metrics}")

    # 6. Merge LoRA + export GGUF
    print("[train_nightly] Merging LoRA adapter and exporting GGUF...")
    merged_dir = str(output_dir / "merged")

    model.save_pretrained_gguf(
        merged_dir,
        tokenizer,
        quantization_method=args.quant_method,
    )

    # 7. Copy the new GGUF to models/ directory
    gguf_files = glob.glob(str(Path(merged_dir) / "*.gguf"))
    if gguf_files:
        newest_gguf = max(gguf_files, key=os.path.getmtime)
        dest = models_dir / Path(newest_gguf).name
        shutil.copy2(newest_gguf, str(dest))
        print(f"[train_nightly] New GGUF exported to: {dest}")
        print("[train_nightly] Restart llama-server to use the new model.")
    else:
        print("[train_nightly] WARNING: No GGUF file produced after merge.")

    # 8. Archive processed feedback
    archive_dir = feedback_dir / "processed"
    archive_dir.mkdir(exist_ok=True)
    for fpath in glob.glob(str(feedback_dir / "*.jsonl")):
        fname = Path(fpath).name
        shutil.move(fpath, str(archive_dir / fname))
    print(f"[train_nightly] Archived {len(glob.glob(str(archive_dir / '*.jsonl')))} feedback files")

    print("[train_nightly] Done!")


if __name__ == "__main__":
    main()
