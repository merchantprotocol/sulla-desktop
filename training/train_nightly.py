#!/usr/bin/env python3
"""
train_nightly.py — Sulla LoRA fine-tuning pipeline.

This is the ONE training path. All training data producers write their
output to ~/sulla/training/*.jsonl, and this script consumes ALL of them.

Training data producers (many paths IN):
  - TrainingDataPreprocessor → sessions-preprocessed-*.jsonl  (from conversations)
  - documents_processor.py  → documents_knowledge.jsonl       (from user docs)
  - (future: skills, manual uploads, etc.)

This script (one path OUT):
  1. Reads ALL *.jsonl from --training-dir (~/sulla/training/)
  2. Appends to replay buffer (accumulates past training data)
  3. Loads document knowledge from <llm-root>/training/documents_knowledge.jsonl
  4. Trains a LoRA adapter (MLX on macOS Apple Silicon, Unsloth on Linux/Windows)
  5. Evaluates on test_set/ if present
  6. Fuses adapter + exports GGUF quantized model
  7. Copies GGUF to <llm-root>/models/ for llama-server hot-reload
  8. Archives consumed training files to --training-dir/processed/

Usage:
  python train_nightly.py --model unsloth/Qwen3.5-0.8B \\
    --llm-root /path/to/llm --training-dir ~/sulla/training

Environment:
  Runs inside the .venv created by LlamaCppService.installTrainingDeps().
"""

import argparse
import glob
import json
import math
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Force unbuffered output so logs appear in real-time when piped
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)


def load_training_data(training_dir: Path):
    """Load all JSONL files from the training directory."""
    conversations = []
    pattern = str(training_dir / "*.jsonl")
    for fpath in sorted(glob.glob(pattern)):
        with open(fpath, "r") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        conversations.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
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
    """Convert conversation dicts to SFT format: {\"messages\": [...]}."""
    formatted = []
    for conv in conversations:
        messages = conv.get("messages", [])
        if not messages:
            continue
        formatted.append({"messages": messages})
    return formatted


def is_macos_arm():
    """Check if running on macOS with Apple Silicon."""
    return platform.system() == "Darwin" and platform.machine() == "arm64"


def train_mlx(args, training_data, output_dir, llm_root, models_dir):
    """Train using mlx_lm on macOS Apple Silicon."""
    try:
        from mlx_lm import lora as mlx_lora
        from mlx_lm import fuse as mlx_fuse
    except ImportError as e:
        print(f"[train_nightly] ERROR: mlx_lm not installed ({e}). Run installTrainingDeps() first.")
        sys.exit(1)

    # mlx_lm expects {train.jsonl, valid.jsonl} in a data directory
    data_dir = output_dir / "mlx_data"
    data_dir.mkdir(parents=True, exist_ok=True)

    # Split: 90% train, 10% valid
    n = len(training_data)
    split_idx = max(1, int(n * 0.9))
    train_split = training_data[:split_idx]
    valid_split = training_data[split_idx:] if split_idx < n else training_data[-1:]

    with open(data_dir / "train.jsonl", "w") as f:
        for entry in train_split:
            f.write(json.dumps(entry) + "\n")
    with open(data_dir / "valid.jsonl", "w") as f:
        for entry in valid_split:
            f.write(json.dumps(entry) + "\n")

    print(f"[train_nightly] MLX data: {len(train_split)} train, {len(valid_split)} valid samples")

    adapter_path = str(output_dir / "adapters")

    # MLX memory management:
    # - batch_size=1 is safest for Metal GPU memory
    # - max_seq_length=1024 avoids OOM on long conversations
    # - grad_checkpoint trades compute for memory
    # - cap iters at 500 to keep training under ~30 min on Apple Silicon
    mlx_batch_size = 1
    mlx_max_seq = 1024
    raw_iters = max(1, len(train_split) // mlx_batch_size) * args.epochs
    iters = min(raw_iters, 500)
    if iters < raw_iters:
        print(f"[train_nightly] Capping iterations from {raw_iters} to {iters} (full pass not needed for LoRA)")

    print(f"[train_nightly] Starting MLX LoRA training ({iters} iters, batch={mlx_batch_size}, seq_len={mlx_max_seq})...")

    # Use mlx_lm CLI — more reliable than calling internal APIs directly
    train_cmd = [
        sys.executable, "-m", "mlx_lm", "lora",
        "--model", args.model,
        "--train",
        "--data", str(data_dir),
        "--fine-tune-type", "lora",
        "--batch-size", str(mlx_batch_size),
        "--iters", str(iters),
        "--learning-rate", str(args.lr),
        "--adapter-path", adapter_path,
        "--num-layers", "16",
        "--steps-per-report", "10",
        "--save-every", str(max(1, iters)),
        "--max-seq-length", str(mlx_max_seq),
        "--grad-checkpoint",
    ]

    print(f"[train_nightly] Running: {' '.join(train_cmd)}")
    print(f"[PROGRESS] phase=training iter=0 total={iters} pct=0")

    import re
    import time
    iter_pattern = re.compile(r"Iter\s+(\d+):")
    training_start = time.time()

    proc = subprocess.Popen(
        train_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    for line in proc.stdout:
        line = line.rstrip("\n")
        print(line)

        # Parse MLX iteration lines (e.g. "Iter 10: Train loss 2.821, ...")
        m = iter_pattern.search(line)
        if m:
            current_iter = int(m.group(1))
            pct = min(99, int(current_iter / iters * 100))
            elapsed = time.time() - training_start
            if current_iter > 0:
                eta_seconds = int(elapsed / current_iter * (iters - current_iter))
                eta_min = eta_seconds // 60
                eta_sec = eta_seconds % 60
                eta_str = f"{eta_min}m{eta_sec:02d}s"
            else:
                eta_str = "calculating..."
            print(f"[PROGRESS] phase=training iter={current_iter} total={iters} pct={pct} eta={eta_str}")

    proc.wait()
    if proc.returncode != 0:
        print(f"[train_nightly] ERROR: MLX LoRA training failed (exit {proc.returncode})")
        sys.exit(1)

    print(f"[PROGRESS] phase=training iter={iters} total={iters} pct=100 eta=0m00s")

    # Evaluate on test_set if present
    test_dir = llm_root / "training" / "test_set"
    if test_dir.exists():
        test_convs = load_training_data(test_dir)
        if test_convs:
            test_data = format_for_sft(test_convs)
            test_file = data_dir / "test.jsonl"
            with open(test_file, "w") as f:
                for entry in test_data:
                    f.write(json.dumps(entry) + "\n")
            test_cmd = [
                sys.executable, "-m", "mlx_lm", "lora",
                "--model", args.model,
                "--test",
                "--data", str(data_dir),
                "--adapter-path", adapter_path,
            ]
            print("[train_nightly] Evaluating on test set...")
            subprocess.run(test_cmd, capture_output=False)

    # Fuse adapter + export GGUF
    fused_dir = str(output_dir / "fused")
    gguf_path = str(output_dir / "fused" / "ggml-model-f16.gguf")

    print("[train_nightly] Fusing adapter and exporting GGUF...")
    print("[PROGRESS] phase=fusing iter=0 total=1 pct=0 eta=calculating...")
    fuse_cmd = [
        sys.executable, "-m", "mlx_lm", "fuse",
        "--model", args.model,
        "--adapter-path", adapter_path,
        "--save-path", fused_dir,
        "--export-gguf",
        "--gguf-path", gguf_path,
    ]
    result = subprocess.run(fuse_cmd, capture_output=False)
    if result.returncode != 0:
        print(f"[train_nightly] ERROR: GGUF export failed (exit {result.returncode})")
        print(f"[train_nightly] Adapter saved at: {adapter_path}")
        sys.exit(1)

    print("[PROGRESS] phase=fusing iter=1 total=1 pct=100 eta=0m00s")

    # Copy GGUF to models dir
    print("[PROGRESS] phase=copying iter=0 total=1 pct=0 eta=calculating...")
    copy_gguf_to_models(output_dir / "fused", models_dir)
    print("[PROGRESS] phase=complete iter=1 total=1 pct=100 eta=0m00s")


def train_unsloth(args, training_data, output_dir, llm_root, models_dir):
    """Train using Unsloth on Linux/Windows with CUDA."""
    try:
        import torch
        from unsloth import FastLanguageModel
        from datasets import Dataset
        from trl import SFTTrainer
        from transformers import TrainingArguments
    except ImportError as e:
        print(f"[train_nightly] ERROR: Required package not installed ({e}). Run installTrainingDeps() first.")
        sys.exit(1)

    print(f"[train_nightly] Loading model: {args.model}")
    try:
        model, tokenizer = FastLanguageModel.get_peft_model(
            FastLanguageModel.from_pretrained(
                model_name=args.model,
                max_seq_length=2048,
                dtype=None,
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
    except torch.cuda.OutOfMemoryError:
        print("[train_nightly] ERROR: GPU out of memory. Try a smaller model or reduce batch size.")
        sys.exit(1)
    except Exception as e:
        print(f"[train_nightly] ERROR: Failed to load model '{args.model}': {e}")
        sys.exit(1)

    dataset = Dataset.from_list(training_data)

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
            fp16=True,
            logging_steps=1,
            output_dir=str(output_dir / "checkpoints"),
            optim="adamw_8bit",
            seed=42,
        ),
        max_seq_length=2048,
    )

    print("[train_nightly] Starting LoRA training...")
    try:
        trainer.train()
    except torch.cuda.OutOfMemoryError:
        print("[train_nightly] ERROR: GPU OOM during training. Try reducing --batch-size or using a smaller model.")
        sys.exit(1)
    except RuntimeError as e:
        if "out of memory" in str(e).lower():
            print(f"[train_nightly] ERROR: Out of memory during training: {e}")
            sys.exit(1)
        raise

    # Evaluate on test_set if present
    test_dir = llm_root / "training" / "test_set"
    if test_dir.exists():
        test_convs = load_training_data(test_dir)
        if test_convs:
            test_data = format_for_sft(test_convs)
            test_dataset = Dataset.from_list(test_data)
            metrics = trainer.evaluate(eval_dataset=test_dataset)
            print(f"[train_nightly] Eval metrics: {metrics}")

    # Merge LoRA + export GGUF
    print("[train_nightly] Merging LoRA adapter and exporting GGUF...")
    merged_dir = str(output_dir / "merged")

    try:
        model.save_pretrained_gguf(
            merged_dir,
            tokenizer,
            quantization_method=args.quant_method,
        )
    except Exception as e:
        print(f"[train_nightly] ERROR: GGUF export failed: {e}")
        print(f"[train_nightly] Checkpoint saved at: {output_dir / 'checkpoints'}")
        sys.exit(1)

    copy_gguf_to_models(output_dir / "merged", models_dir)


def copy_gguf_to_models(source_dir: Path, models_dir: Path):
    """Find and copy the GGUF file from source_dir to models/."""
    gguf_files = glob.glob(str(source_dir / "*.gguf"))
    if gguf_files:
        newest_gguf = max(gguf_files, key=os.path.getmtime)
        dest = models_dir / Path(newest_gguf).name
        shutil.copy2(newest_gguf, str(dest))
        print(f"[train_nightly] New GGUF exported to: {dest}")
        print("[train_nightly] Restart llama-server to use the new model.")
    else:
        print("[train_nightly] WARNING: No GGUF file produced after merge.")


def main():
    parser = argparse.ArgumentParser(description="Sulla nightly LoRA training")
    parser.add_argument("--model", required=True, help="HuggingFace model ID (e.g. unsloth/Qwen3.5-9B)")
    parser.add_argument("--llm-root", required=True, help="Absolute path to the llm/ directory")
    parser.add_argument("--training-dir", default=None, help="Absolute path to ~/sulla/training/ (default: <llm-root>/feedback_queue for backwards compat)")
    parser.add_argument("--output-dir", default=None, help="Output directory (default: <llm-root>/training/output)")
    parser.add_argument("--epochs", type=int, default=2, help="Training epochs (default: 2)")
    parser.add_argument("--batch-size", type=int, default=2, help="Batch size (default: 2)")
    parser.add_argument("--lr", type=float, default=2e-4, help="Learning rate (default: 2e-4)")
    parser.add_argument("--lora-r", type=int, default=16, help="LoRA rank (default: 16)")
    parser.add_argument("--quant-method", default="q4_k_m", help="GGUF quant method (default: q4_k_m)")
    args = parser.parse_args()

    llm_root = Path(args.llm_root)
    models_dir = llm_root / "models"
    output_dir = Path(args.output_dir) if args.output_dir else llm_root / "training" / "output"

    # Training data directory — ~/sulla/training/ when passed, else legacy feedback_queue
    if args.training_dir:
        training_data_dir = Path(args.training_dir)
    else:
        training_data_dir = llm_root / "feedback_queue"

    replay_path = training_data_dir / "replay_buffer.jsonl"

    output_dir.mkdir(parents=True, exist_ok=True)

    use_mlx = is_macos_arm()
    backend = "MLX (Apple Silicon)" if use_mlx else "Unsloth (CUDA)"

    print(f"[train_nightly] Backend: {backend}")
    print(f"[train_nightly] Training data dir: {training_data_dir}")
    print(f"[train_nightly] Output dir: {output_dir}")
    print(f"[train_nightly] Models dir: {models_dir}")

    # 1. Load training data
    new_convs = load_training_data(training_data_dir)
    if not new_convs:
        print("[train_nightly] No new feedback data found. Nothing to train on.")
        sys.exit(0)

    print(f"[train_nightly] Loaded {len(new_convs)} new conversations from {training_data_dir}")

    # 2. Combine with replay buffer
    save_replay_buffer(replay_path, new_convs)
    all_convs = load_replay_buffer(replay_path)
    training_data = format_for_sft(all_convs)

    # 2b. Include document knowledge (produced by documents_processor.py)
    documents_knowledge_path = llm_root / "training" / "documents_knowledge.jsonl"
    if documents_knowledge_path.exists():
        doc_count = 0
        with open(documents_knowledge_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    training_data.append(json.loads(line))
                    doc_count += 1
        print(f"[train_nightly] Loaded {doc_count} document knowledge entries")

    print(f"[train_nightly] Total training samples (before validation): {len(training_data)}")

    # 2c. Validate and clean training data
    #     Removes entries with invalid roles, missing fields, etc.
    try:
        from validate_training_data import validate_and_clean
        training_data, report = validate_and_clean(training_data)
        print(f"[train_nightly] Validation: {report['total_input']} input → {report['total_output']} valid ({report['removed']} removed)")
        if report['issues']:
            for issue in report['issues'][:10]:
                print(f"[train_nightly]   ISSUE: {issue}")
    except ImportError:
        print("[train_nightly] WARNING: validate_training_data.py not found, skipping validation")

    print(f"[train_nightly] Total training samples (after validation): {len(training_data)}")

    if len(training_data) < 5:
        print("[train_nightly] Need at least 5 training samples. Waiting for more feedback.")
        sys.exit(0)

    # 3. Pre-flight RAM check
    try:
        if platform.system() == "Darwin":
            mem_bytes = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"]).strip())
        else:
            mem_bytes = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        mem_gb = mem_bytes / (1024 ** 3)
        min_ram_gb = 4
        model_lower = args.model.lower()
        if "9b" in model_lower or "8b" in model_lower or "7b" in model_lower:
            min_ram_gb = 12
        elif "4b" in model_lower or "3b" in model_lower:
            min_ram_gb = 6
        if mem_gb < min_ram_gb:
            print(f"[train_nightly] ERROR: Not enough RAM. Have {mem_gb:.1f} GB, need ~{min_ram_gb} GB.")
            sys.exit(1)
        print(f"[train_nightly] RAM check: {mem_gb:.1f} GB available (need ~{min_ram_gb} GB) — OK")
    except Exception as e:
        print(f"[train_nightly] WARNING: Could not check RAM ({e}), proceeding anyway")

    # 4. Train
    if use_mlx:
        train_mlx(args, training_data, output_dir, llm_root, models_dir)
    else:
        train_unsloth(args, training_data, output_dir, llm_root, models_dir)

    # 5. Archive processed training files
    archive_dir = training_data_dir / "processed"
    archive_dir.mkdir(exist_ok=True)
    for fpath in glob.glob(str(training_data_dir / "*.jsonl")):
        fname = Path(fpath).name
        if fname == "replay_buffer.jsonl":
            continue
        dest = str(archive_dir / fname)
        try:
            shutil.move(fpath, dest)
        except OSError:
            shutil.copy2(fpath, dest)
            os.remove(fpath)
    print(f"[train_nightly] Archived processed training files")

    print("[train_nightly] Done!")


if __name__ == "__main__":
    main()
