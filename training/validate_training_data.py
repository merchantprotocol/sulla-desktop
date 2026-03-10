#!/usr/bin/env python3
"""
validate_training_data.py — Validate and clean training data before LoRA fine-tuning.

This script is run automatically by train_nightly.py before training.
It can also be run standalone to inspect training data quality.

Checks performed on each {"messages": [...]} entry:
  1. Valid JSON structure with a "messages" array
  2. Each message has a "role" field with a valid value
  3. Each message has "content" (string or null for tool-call messages)
  4. Tool messages have required fields (tool_call_id)
  5. Conversations have at least one user + one assistant message
  6. No empty conversations

Invalid entries are removed. A summary report is printed.

Valid roles (OpenAI chat format):
  - system: System prompt
  - user: User input
  - assistant: Model response (may include tool_calls)
  - tool: Tool/function result (requires tool_call_id)

Usage:
  # Validate and write cleaned output:
  python validate_training_data.py --input /path/to/data.jsonl --output /path/to/clean.jsonl

  # Validate in-place (overwrites input):
  python validate_training_data.py --input /path/to/data.jsonl --in-place

  # Validate a directory of JSONL files:
  python validate_training_data.py --dir ~/sulla/training/

  # Dry run (report only, no writes):
  python validate_training_data.py --dir ~/sulla/training/ --dry-run

  # As a library (called by train_nightly.py):
  from validate_training_data import validate_and_clean
  clean_data, report = validate_and_clean(training_data)
"""

import argparse
import glob
import json
import sys
from pathlib import Path

# Force unbuffered output so logs appear in real-time when piped
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

# Roles accepted by standard chat templates (OpenAI / Qwen / Llama / etc.)
VALID_ROLES = {"system", "user", "assistant", "tool"}

# Roles that are sometimes present in raw data but should be stripped
# before training (they cause "Unexpected message role" errors)
STRIPPABLE_ROLES = {"function"}


def validate_message(msg: dict, entry_index: int, msg_index: int) -> list[str]:
    """
    Validate a single message dict.
    Returns a list of issues found (empty = valid).
    """
    issues = []

    if not isinstance(msg, dict):
        issues.append(f"entry[{entry_index}].messages[{msg_index}]: not a dict (got {type(msg).__name__})")
        return issues

    role = msg.get("role")
    if role is None:
        issues.append(f"entry[{entry_index}].messages[{msg_index}]: missing 'role' field")
        return issues

    if role not in VALID_ROLES:
        issues.append(f"entry[{entry_index}].messages[{msg_index}]: invalid role '{role}'")
        return issues

    # Tool messages must have tool_call_id
    if role == "tool" and not msg.get("tool_call_id"):
        issues.append(f"entry[{entry_index}].messages[{msg_index}]: tool message missing 'tool_call_id'")

    return issues


def validate_entry(entry: dict, index: int) -> tuple[bool, list[str]]:
    """
    Validate a single training entry {"messages": [...]}.
    Returns (is_valid, list_of_issues).
    """
    issues = []

    if not isinstance(entry, dict):
        return False, [f"entry[{index}]: not a dict"]

    messages = entry.get("messages")
    if not isinstance(messages, list):
        return False, [f"entry[{index}]: missing or invalid 'messages' field"]

    if len(messages) == 0:
        return False, [f"entry[{index}]: empty messages array"]

    # Validate each message
    for i, msg in enumerate(messages):
        msg_issues = validate_message(msg, index, i)
        issues.extend(msg_issues)

    # Must have at least one user + one assistant message
    roles_present = {msg.get("role") for msg in messages if isinstance(msg, dict)}
    if "user" not in roles_present:
        issues.append(f"entry[{index}]: no 'user' message found")
    if "assistant" not in roles_present:
        issues.append(f"entry[{index}]: no 'assistant' message found")

    return len(issues) == 0, issues


def clean_message(msg: dict) -> dict | None:
    """
    Clean a single message for training.
    Returns None if the message should be removed entirely.
    """
    if not isinstance(msg, dict):
        return None

    role = msg.get("role")

    # Strip roles that are not in the valid set
    if role in STRIPPABLE_ROLES:
        return None

    if role not in VALID_ROLES:
        return None

    # Build a clean message with only the fields the template expects
    clean: dict = {"role": role}

    content = msg.get("content")
    if content is not None:
        # Ensure content is a string
        if isinstance(content, str):
            clean["content"] = content
        elif isinstance(content, list):
            # Some providers return content as an array of {type, text} blocks
            text_parts = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(str(part.get("text", "")))
                elif isinstance(part, str):
                    text_parts.append(part)
            clean["content"] = "\n".join(text_parts) if text_parts else ""
        else:
            clean["content"] = str(content)
    else:
        # Assistant messages with tool_calls can have null content
        if role == "assistant" and msg.get("tool_calls"):
            clean["content"] = None
        else:
            clean["content"] = ""

    # Preserve tool_calls for assistant messages
    if role == "assistant" and msg.get("tool_calls"):
        clean["tool_calls"] = msg["tool_calls"]

    # Preserve tool_call_id for tool messages
    if role == "tool" and msg.get("tool_call_id"):
        clean["tool_call_id"] = msg["tool_call_id"]

    return clean


def clean_entry(entry: dict) -> dict | None:
    """
    Clean a training entry, removing invalid messages and roles.
    Returns None if the entry should be removed entirely.
    """
    if not isinstance(entry, dict):
        return None

    messages = entry.get("messages")
    if not isinstance(messages, list) or len(messages) == 0:
        return None

    cleaned_messages = []
    for msg in messages:
        clean = clean_message(msg)
        if clean is not None:
            cleaned_messages.append(clean)

    if len(cleaned_messages) == 0:
        return None

    # Must still have user + assistant after cleaning
    roles = {m["role"] for m in cleaned_messages}
    if "user" not in roles or "assistant" not in roles:
        return None

    return {"messages": cleaned_messages}


def validate_and_clean(
    data: list[dict],
    strip_tool_messages: bool = False,
) -> tuple[list[dict], dict]:
    """
    Validate and clean a list of training entries.

    Args:
        data: List of {"messages": [...]} dicts
        strip_tool_messages: If True, remove all tool/tool_calls messages
                             (useful for models that don't support tool use)

    Returns:
        (cleaned_data, report) where report contains counts and issues
    """
    report = {
        "total_input": len(data),
        "valid": 0,
        "cleaned": 0,
        "removed": 0,
        "issues": [],
    }

    cleaned = []
    for i, entry in enumerate(data):
        # First try cleaning
        clean = clean_entry(entry)
        if clean is None:
            report["removed"] += 1
            _, issues = validate_entry(entry, i)
            report["issues"].extend(issues[:3])  # limit issue count
            continue

        if strip_tool_messages:
            msgs = [m for m in clean["messages"]
                    if m["role"] != "tool" and not m.get("tool_calls")]
            roles = {m["role"] for m in msgs}
            if "user" not in roles or "assistant" not in roles:
                report["removed"] += 1
                continue
            clean = {"messages": msgs}

        # Validate the cleaned entry
        is_valid, issues = validate_entry(clean, i)
        if is_valid:
            report["valid"] += 1
            cleaned.append(clean)
        else:
            report["cleaned"] += 1
            report["issues"].extend(issues[:3])
            # Still try to use it if it has user+assistant
            roles = {m.get("role") for m in clean.get("messages", []) if isinstance(m, dict)}
            if "user" in roles and "assistant" in roles:
                cleaned.append(clean)

    report["total_output"] = len(cleaned)
    return cleaned, report


def process_file(filepath: str, output_path: str | None = None, dry_run: bool = False, strip_tools: bool = False) -> dict:
    """
    Validate and clean a single JSONL file.

    Args:
        filepath: Path to input JSONL file
        output_path: Path to write cleaned output (None = no output)
        dry_run: If True, only report issues without writing
        strip_tools: If True, remove tool messages

    Returns:
        Report dict with counts and issues
    """
    data = []
    parse_errors = 0
    with open(filepath, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                data.append(json.loads(line))
            except json.JSONDecodeError:
                parse_errors += 1

    cleaned, report = validate_and_clean(data, strip_tool_messages=strip_tools)
    report["parse_errors"] = parse_errors

    if not dry_run and output_path and cleaned:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            for entry in cleaned:
                f.write(json.dumps(entry) + "\n")

    return report


def main():
    parser = argparse.ArgumentParser(description="Validate and clean training data")
    parser.add_argument("--input", help="Input JSONL file to validate")
    parser.add_argument("--output", help="Output path for cleaned JSONL (default: stdout report only)")
    parser.add_argument("--in-place", action="store_true", help="Clean the input file in-place")
    parser.add_argument("--dir", help="Validate all *.jsonl files in a directory")
    parser.add_argument("--dry-run", action="store_true", help="Report only, don't write any files")
    parser.add_argument("--strip-tools", action="store_true", help="Remove all tool/function messages")
    args = parser.parse_args()

    if not args.input and not args.dir:
        parser.error("Must specify --input or --dir")

    files_to_process = []

    if args.dir:
        pattern = str(Path(args.dir) / "*.jsonl")
        files_to_process = sorted(glob.glob(pattern))
        if not files_to_process:
            print(f"[validate] No .jsonl files found in {args.dir}")
            return
    elif args.input:
        files_to_process = [args.input]

    total_input = 0
    total_output = 0
    total_removed = 0
    all_issues = []

    for filepath in files_to_process:
        filename = Path(filepath).name
        if filename == "replay_buffer.jsonl":
            continue  # Skip the replay buffer

        output_path = None
        if args.in_place and not args.dry_run:
            output_path = filepath
        elif args.output and len(files_to_process) == 1:
            output_path = args.output

        report = process_file(filepath, output_path, args.dry_run, args.strip_tools)

        total_input += report["total_input"]
        total_output += report.get("total_output", 0)
        total_removed += report["removed"]

        status = "OK" if report["removed"] == 0 else f"CLEANED ({report['removed']} removed)"
        print(f"[validate] {filename}: {report['total_input']} entries → {report.get('total_output', '?')} valid  [{status}]")

        if report.get("parse_errors", 0) > 0:
            print(f"  WARNING: {report['parse_errors']} JSON parse errors")

        if report["issues"]:
            all_issues.extend(report["issues"])
            for issue in report["issues"][:5]:
                print(f"  ISSUE: {issue}")

    print(f"\n[validate] Summary: {total_input} input → {total_output} output ({total_removed} removed)")
    if all_issues:
        print(f"[validate] {len(all_issues)} issue(s) found across all files")


if __name__ == "__main__":
    main()
