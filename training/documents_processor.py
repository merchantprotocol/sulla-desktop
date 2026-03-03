#!/usr/bin/env python3
"""
documents_processor.py — Incremental document scanner for Sulla training.

Scans configured folders for new/changed documents, extracts text,
generates QA pairs, and appends them to documents_knowledge.jsonl.
Uses processed_manifest.json to track file hashes so only new or
modified files are processed (zero duplication).

Supports: .txt, .md, .pdf, .docx

Usage:
  python documents_processor.py --llm-root /path/to/llm
"""

import argparse
import json
import hashlib
import os
from pathlib import Path

# Optional imports — graceful degradation if not installed
try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    from docx import Document as DocxDocument
except ImportError:
    DocxDocument = None


def extract_text(file_path: Path) -> str:
    """Extract text from a supported file type."""
    try:
        suffix = file_path.suffix.lower()

        if suffix == ".pdf":
            if fitz is None:
                print(f"  [SKIP] PyMuPDF not installed, cannot read: {file_path.name}")
                return ""
            doc = fitz.open(str(file_path))
            return "\n".join(page.get_text() for page in doc)

        if suffix == ".docx":
            if DocxDocument is None:
                print(f"  [SKIP] python-docx not installed, cannot read: {file_path.name}")
                return ""
            return "\n".join(p.text for p in DocxDocument(str(file_path)).paragraphs)

        if suffix in (".md", ".txt"):
            return file_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""

    return ""


def generate_qa_pairs(text: str, filename: str) -> list:
    """Generate QA training pairs from document text.

    Uses paragraph-based chunking for meaningful QA pairs.
    Each paragraph (50+ chars) becomes an answer to a contextual question.
    Capped at 15 paragraphs per document for speed.
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 50]
    pairs = []

    for para in paragraphs[:15]:
        pairs.append({
            "messages": [
                {
                    "role": "system",
                    "content": "You are my personal AI twin. Answer using ONLY my personal documents and skills."
                },
                {
                    "role": "user",
                    "content": f"Based on my document '{filename}', answer this question: What are the key points and how do I apply them?"
                },
                {
                    "role": "assistant",
                    "content": para
                }
            ]
        })

    return pairs


def main():
    parser = argparse.ArgumentParser(description="Sulla incremental document processor")
    parser.add_argument("--llm-root", required=True, help="Absolute path to the llm/ directory")
    args = parser.parse_args()

    llm_root = Path(args.llm_root)
    training_dir = llm_root / "training"
    config_path = training_dir / "documents_config.json"
    manifest_path = training_dir / "processed_manifest.json"
    output_path = training_dir / "documents_knowledge.jsonl"

    if not config_path.exists():
        print("[documents_processor] No documents_config.json found. Skipping.")
        return

    config = json.loads(config_path.read_text(encoding="utf-8"))
    folders = config.get("folders", [])
    file_types = [ft.lower() for ft in config.get("file_types", [".txt", ".md", ".pdf", ".docx"])]

    if not folders:
        print("[documents_processor] No folders configured. Skipping.")
        return

    # Load manifest of already-processed file hashes
    manifest = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    new_count = 0
    total_pairs = 0

    for folder in folders:
        folder_path = Path(folder).expanduser()
        if not folder_path.exists():
            print(f"[documents_processor] Folder not found, skipping: {folder}")
            continue

        for file_path in folder_path.rglob("*"):
            if not file_path.is_file():
                continue
            if file_path.suffix.lower() not in file_types:
                continue

            # Compute hash for incremental detection
            try:
                file_hash = hashlib.md5(file_path.read_bytes()).hexdigest()
            except (PermissionError, OSError) as e:
                print(f"  [SKIP] Cannot read {file_path}: {e}")
                continue

            key = str(file_path)
            if manifest.get(key) == file_hash:
                continue  # Already processed, unchanged

            text = extract_text(file_path)
            if len(text) < 100:
                continue

            qa_pairs = generate_qa_pairs(text, file_path.name)
            if not qa_pairs:
                continue

            with output_path.open("a", encoding="utf-8") as f:
                for pair in qa_pairs:
                    f.write(json.dumps(pair) + "\n")

            manifest[key] = file_hash
            new_count += 1
            total_pairs += len(qa_pairs)
            print(f"  [OK] Processed new/changed: {file_path.name} ({len(qa_pairs)} pairs)")

    # Save updated manifest
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if new_count:
        kb = output_path.stat().st_size // 1000 if output_path.exists() else 0
        print(f"[documents_processor] Processed {new_count} files, {total_pairs} new pairs. Knowledge base: {kb} KB")
    else:
        print("[documents_processor] No new or changed documents found.")


if __name__ == "__main__":
    main()
