#!/usr/bin/env python3
"""
PR Review PoC — replays a Claude Code session into the Anthropic API
so a reviewer can query Claude about design decisions.

Usage:
    python replay.py <path-to-session.jsonl>
    python replay.py <path-to-session.jsonl> --summary   # print conversation summary only

Requires: ANTHROPIC_API_KEY env var
"""

import json
import os
import sys
import textwrap
from pathlib import Path

import anthropic

REVIEW_SYSTEM_PROMPT = """\
You are Claude, and you are being asked to review and justify a coding session you previously completed.

The conversation history below is the EXACT session you had with the developer — every file you read, \
every bash command you ran, every decision you made is captured there. You have full memory of this work.

Your role now is to act as the author of the code changes, not as a fresh assistant. When the reviewer \
asks questions:
- Explain WHY you made specific design decisions, not just what you did
- Surface trade-offs you considered and rejected alternatives
- Be honest about areas of uncertainty or places where you made judgment calls
- If you spot something you'd now do differently, say so
- Ground your answers in the actual code and decisions visible in the history

Be direct and specific. The reviewer is a developer doing a code review — they want substance, not reassurance.\
"""

MAX_TOOL_RESULT_CHARS = 4000  # truncate large tool outputs to keep tokens sane


def load_session(path: str) -> list[dict]:
    """Parse JSONL and return ordered text-only messages for the API.

    We extract only the conversational narrative — user questions and assistant
    text responses. Tool calls are summarised as inline notes rather than
    replayed as tool_use/tool_result blocks, which avoids the strict pairing
    rules the API enforces and keeps the context compact.
    """
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entries.append(json.loads(line))

    messages = []
    for entry in entries:
        t = entry.get("type")
        if t not in ("user", "assistant"):
            continue
        if entry.get("isSidechain"):
            continue

        msg = entry["message"]
        role = msg["role"]
        content = msg.get("content", [])

        if isinstance(content, str):
            # Plain text user message — pass through directly
            if content.strip():
                messages.append({"role": role, "content": content})
            continue

        # content is a list of blocks — extract text and summarise tool activity
        text_parts = _extract_text(role, content)
        if text_parts:
            messages.append({"role": role, "content": text_parts})

    # Merge consecutive same-role messages (happens when tool turns are collapsed)
    return _merge_consecutive(messages)


def _extract_text(role: str, blocks: list) -> str:
    """Return a plain-text representation of a message's content blocks."""
    parts = []
    for block in blocks:
        btype = block.get("type")

        if btype == "text":
            t = block.get("text", "").strip()
            if t:
                parts.append(t)

        elif btype == "thinking":
            pass  # strip — internal reasoning not useful for review

        elif btype == "tool_use" and role == "assistant":
            name = block.get("name", "?")
            inp = block.get("input", {})
            # Summarise the call without including full inputs (can be huge)
            summary = _tool_summary(name, inp)
            parts.append(f"[Tool call: {summary}]")

        elif btype == "tool_result" and role == "user":
            inner = block.get("content", [])
            if isinstance(inner, list):
                result_texts = [
                    b.get("text", "")
                    for b in inner
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                combined = "\n".join(result_texts).strip()
                if combined:
                    if len(combined) > MAX_TOOL_RESULT_CHARS:
                        combined = combined[:MAX_TOOL_RESULT_CHARS] + f"\n... [truncated]"
                    parts.append(f"[Tool result: {combined}]")
            # skip tool_reference inner blocks entirely (harness internals)

    return "\n".join(parts)


def _tool_summary(name: str, inp: dict) -> str:
    """One-line summary of a tool call for the review context."""
    if name in ("Read",):
        return f"Read({inp.get('file_path', '?')})"
    if name in ("Bash",):
        cmd = inp.get("command", "")[:120].replace("\n", "; ")
        return f"Bash({cmd!r})"
    if name in ("Edit", "Write"):
        return f"{name}({inp.get('file_path', '?')})"
    if name in ("WebFetch",):
        return f"WebFetch({inp.get('url', '?')[:80]})"
    if name in ("Agent",):
        return f"Agent({inp.get('description', '?')[:80]})"
    # Fallback: show first key=value pair
    first = next(iter(inp.items()), ("?", "?")) if inp else ("", "")
    return f"{name}({first[0]}={str(first[1])[:60]})"


def _merge_consecutive(messages: list[dict]) -> list[dict]:
    """Merge back-to-back messages with the same role into one."""
    merged = []
    for msg in messages:
        if merged and merged[-1]["role"] == msg["role"]:
            merged[-1]["content"] += "\n" + msg["content"]
        else:
            merged.append(dict(msg))
    return merged


def summarize_session(messages: list[dict]) -> None:
    """Print a human-readable summary of the session for inspection."""
    print(f"\n{'='*60}")
    print(f"Session summary: {len(messages)} messages")
    print(f"{'='*60}")
    for i, msg in enumerate(messages):
        role = msg["role"].upper()
        content = msg["content"]
        if isinstance(content, str):
            preview = content[:120].replace("\n", " ")
        else:
            parts = []
            for b in content:
                if isinstance(b, dict):
                    if b.get("type") == "text":
                        parts.append(f"[text: {b['text'][:80].replace(chr(10),' ')}]")
                    elif b.get("type") == "tool_use":
                        parts.append(f"[tool_use: {b['name']}({json.dumps(b.get('input',{}))[:60]})]")
                    elif b.get("type") == "tool_result":
                        inner = b.get("content", [])
                        size = sum(len(ib.get("text","")) for ib in inner if isinstance(ib, dict))
                        parts.append(f"[tool_result: {b.get('tool_use_id','?')[:12]}... ({size} chars)]")
            preview = " | ".join(parts)[:140]
        print(f"\n[{i:03d}] {role}: {preview}")
    print(f"\n{'='*60}\n")


def run_review_repl(messages: list[dict], client: anthropic.Anthropic) -> None:
    """Interactive review session — load history then accept reviewer questions."""
    print("\n" + "="*60)
    print("PR REVIEW MODE")
    print("="*60)
    print(f"Session loaded: {len(messages)} messages replayed into context.")
    print("Ask Claude to justify any design decision from this session.")
    print("Commands: 'quit' or Ctrl-C to exit\n")

    # We keep the original session history read-only and append reviewer Q&A separately
    review_messages = list(messages)

    while True:
        try:
            question = input("Reviewer > ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nExiting review session.")
            break

        if question.lower() in ("quit", "exit", "q"):
            break
        if not question:
            continue

        review_messages.append({"role": "user", "content": question})

        try:
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=2048,
                system=REVIEW_SYSTEM_PROMPT,
                messages=review_messages,
            )
        except anthropic.BadRequestError as e:
            print(f"\n[Error from API: {e}]")
            print("This often means the session is too long for the context window.")
            print("Try using a shorter session or the --summary flag to inspect it first.\n")
            review_messages.pop()
            continue

        reply = response.content[0].text
        review_messages.append({"role": "assistant", "content": reply})

        print(f"\nClaude > {textwrap.fill(reply, width=80, subsequent_indent='         ')}\n")


def main():
    if len(sys.argv) < 2:
        print("Usage: python replay.py <session.jsonl> [--summary]")
        sys.exit(1)

    session_path = sys.argv[1]
    summary_only = "--summary" in sys.argv

    if not Path(session_path).exists():
        print(f"Session file not found: {session_path}")
        sys.exit(1)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key and not summary_only:
        print("ANTHROPIC_API_KEY not set. Use --summary to inspect the session without calling the API.")
        sys.exit(1)

    print(f"Loading session: {session_path}")
    messages = load_session(session_path)
    print(f"Parsed {len(messages)} messages.")

    if summary_only:
        summarize_session(messages)
        return

    client = anthropic.Anthropic(api_key=api_key)
    run_review_repl(messages, client)


if __name__ == "__main__":
    main()
