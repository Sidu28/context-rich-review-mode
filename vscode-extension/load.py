#!/usr/bin/env python3
"""
pr-review load — installs a session snapshot as a resumable Claude Code session.

Usage:
    python load.py <session.jsonl>               # install + print resume command
    python load.py <session.jsonl> --launch      # install + launch claude immediately

The script writes a synthetic JSONL into ~/.claude/projects/<cwd-hash>/ with a
review-mode preamble appended, then either prints or executes the resume command.
The reviewer gets a full Claude Code session (file edits, bash, everything) with
the original session already loaded as context.
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Injected at the end of the history so Claude is primed for review before the
# reviewer types their first message.
REVIEW_PREAMBLE_USER = """\
[REVIEW SESSION STARTED]

A code reviewer is now joining this session to understand the changes you made.
They have access to the full codebase on the PR branch and can ask you to read
files, run commands, or make further edits.

Your role in this session:
- You are the author of these changes — answer questions as someone who built this
- Explain WHY you made design decisions, not just what you did
- Surface trade-offs you considered and alternatives you rejected
- Be honest about uncertainty or judgment calls
- If asked to make code changes, do so — the reviewer may want to suggest fixes

Respond to the reviewer's questions directly. Start by briefly summarising what
this session accomplished so they know what they're reviewing.\
"""

REVIEW_PREAMBLE_ASSISTANT = """\
I'm ready for review. Here's a quick summary of what this session accomplished:

I'll answer questions about any design decision, trade-off, or implementation
detail. I also have full access to the codebase here — if you want me to read
a file, run tests, check something, or make a change, just ask.\
"""


MAX_TOOL_RESULT_CHARS = 2000


def _tool_label(name: str, inp: dict) -> str:
    if name == "Read":
        return f"Read({inp.get('file_path', '?')})"
    if name == "Bash":
        cmd = inp.get("command", "")[:100].replace("\n", "; ")
        return f"Bash({cmd!r})"
    if name in ("Edit", "Write"):
        return f"{name}({inp.get('file_path', '?')})"
    if name == "WebFetch":
        return f"WebFetch({inp.get('url', '?')[:60]})"
    if name == "Agent":
        return f"Agent({inp.get('description', '?')[:60]})"
    first = next(iter(inp.items()), ("", "")) if inp else ("", "")
    return f"{name}({first[0]}={str(first[1])[:40]})"


def clean_entry(entry: dict) -> dict | None:
    """Strip tool_use/tool_result/thinking blocks from a message entry.

    The Anthropic API requires tool_use and tool_result blocks to appear in
    matched pairs in consecutive messages. Our synthetic session breaks that
    pairing, so we convert everything to plain text to avoid API rejection.
    Returns None if the entry has no useful content after cleaning.
    """
    msg = entry.get("message", {})
    role = msg.get("role")
    content = msg.get("content", "")

    if isinstance(content, str):
        if not content.strip():
            return None
        return entry  # plain text user message — fine as-is

    if not isinstance(content, list):
        return None

    text_parts = []

    had_tool_use = False
    if role == "assistant":
        for block in content:
            btype = block.get("type")
            if btype == "text" and block.get("text", "").strip():
                text_parts.append(block["text"].strip())
            elif btype == "tool_use":
                text_parts.append(f"[{_tool_label(block.get('name','?'), block.get('input',{}))}]")
                had_tool_use = True
            # drop thinking blocks entirely

    elif role == "user":
        for block in content:
            btype = block.get("type")
            if btype == "tool_result":
                inner = block.get("content", [])
                if isinstance(inner, list):
                    for ib in inner:
                        if isinstance(ib, dict) and ib.get("type") == "text":
                            text = ib["text"].strip()
                            if len(text) > MAX_TOOL_RESULT_CHARS:
                                text = text[:MAX_TOOL_RESULT_CHARS] + " …[truncated]"
                            if text:
                                text_parts.append(f"[Result: {text}]")
                # skip tool_reference inner blocks (harness internals)
            elif btype == "text":
                t = block.get("text", "").strip()
                if t:
                    text_parts.append(t)

    if not text_parts:
        return None

    # User messages use plain string content — Claude Code's own user messages
    # are strings, and list content with non-tool_result blocks may confuse it.
    # Assistant messages use the list-of-blocks format the API requires.
    joined = "\n".join(text_parts)
    if role == "user":
        new_content = joined
    else:
        new_content = [{"type": "text", "text": joined}]
    cleaned_msg = {**msg, "content": new_content}
    # If we stripped tool_use blocks, the stop_reason must change to end_turn.
    # Leaving stop_reason="tool_use" with no tool blocks causes Claude Code to
    # look for a matching tool_result in the next message and fail to resume.
    if had_tool_use:
        cleaned_msg["stop_reason"] = "end_turn"
        cleaned_msg["stop_details"] = None
    # Rebuild from scratch with only the fields the minimal working session needs.
    # Keeping Claude Code internal fields (toolUseResult, sourceToolAssistantUUID,
    # slug, requestId, etc.) confuses the resume logic when content has changed.
    base = {
        "type": entry.get("type"),
        "message": cleaned_msg,
        "uuid": entry.get("uuid"),         # will be replaced with fresh uuid later
        "parentUuid": entry.get("parentUuid"),  # will be rebuilt linearly later
        "isSidechain": False,
        "timestamp": entry.get("timestamp", datetime.now(timezone.utc).isoformat().replace("+00:00","Z")),
        "sessionId": entry.get("sessionId"),    # will be replaced later
        "userType": "external",
        "entrypoint": "cli",
        "cwd": entry.get("cwd", ""),           # will be replaced later
        "version": entry.get("version", "2.1.140"),
        "gitBranch": entry.get("gitBranch"),
    }
    if role == "user":
        base["permissionMode"] = entry.get("permissionMode", "default")
        if entry.get("promptId"):
            base["promptId"] = entry["promptId"]
    elif role == "assistant":
        # Rebuild the message object from scratch — reusing the original msg_ ID
        # causes conflicts since the same ID exists in the source session file.
        # Strip all non-essential fields (iterations, cache_creation, diagnostics,
        # stop_details, server_tool_use, etc.) that aren't in a minimal valid session.
        orig_msg = entry.get("message", {})
        orig_usage = orig_msg.get("usage", {})
        base["message"] = {
            "role": "assistant",
            "model": orig_msg.get("model", "claude-sonnet-4-6"),
            "id": "msg_" + uuid.uuid4().hex[:20],
            "type": "message",
            "content": new_content,
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {
                "input_tokens": orig_usage.get("input_tokens", 0),
                "output_tokens": orig_usage.get("output_tokens", 0),
            },
        }
    return base


def cwd_to_project_hash(cwd: str) -> str:
    """Convert an absolute path to the Claude Code project directory name.

    Claude Code stores sessions at ~/.claude/projects/<hash>/ where <hash>
    is the absolute path with the leading '/' removed and all '/' replaced by '-'.
    e.g. /Users/alice/my-repo  ->  -Users-alice-my-repo
    """
    return cwd.replace("/", "-")


def make_entry(
    entry_type: str,
    message: dict,
    session_id: str,
    parent_uuid: str | None,
    cwd: str,
    branch: str | None = None,
) -> dict:
    entry_uuid = str(uuid.uuid4())
    if entry_type == "assistant":
        message = {
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "id": "msg_" + uuid.uuid4().hex[:20],
            "type": "message",
            "content": message.get("content", []),
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
    entry = {
        "type": entry_type,
        "message": message,
        "uuid": entry_uuid,
        "parentUuid": parent_uuid,
        "isSidechain": False,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "sessionId": session_id,
        "userType": "external",
        "entrypoint": "cli",
        "cwd": cwd,
        "version": "2.1.140",
    }
    if branch:
        entry["gitBranch"] = branch
    if entry_type == "user":
        entry["permissionMode"] = "default"
    return entry


def load_session_entries(path: str) -> tuple[list[dict], dict]:
    """Load entries from a .snapshot file or raw .jsonl file.

    Returns (entries, metadata) where metadata contains git/pr info if available.
    """
    raw = Path(path).read_text()

    # Snapshot format: single JSON object with a 'session.entries' key
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and "session" in data:
            entries = [
                e for e in data["session"]["entries"]
                if e.get("type") in ("user", "assistant") and not e.get("isSidechain")
            ]
            meta = {
                "git": data.get("git", {}),
                "pr": data.get("pr", {}),
                "original_cwd": data["session"].get("original_cwd", ""),
            }
            return entries, meta
    except json.JSONDecodeError:
        pass

    # Raw JSONL format
    entries = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") in ("user", "assistant") and not d.get("isSidechain"):
            entries.append(d)
    return entries, {}


def detect_branch(entries: list[dict]) -> str | None:
    for e in reversed(entries):
        if b := e.get("gitBranch"):
            return b
    return None


def detect_original_cwd(entries: list[dict]) -> str | None:
    for e in entries:
        if c := e.get("cwd"):
            return c
    return None


def build_synthetic_session(
    source_entries: list[dict],
    new_session_id: str,
    reviewer_cwd: str,
    branch: str | None,
) -> list[str]:
    """Return JSONL lines for the synthetic session.

    - Copies all source entries verbatim, updating only sessionId.
    - Appends a review-mode preamble (user + assistant) at the end.
    """
    lines = []

    # Permission-mode header — pr_review_synthetic marks this so export.py
    # skips it during session discovery (we don't want reviewers reviewing reviews)
    header = {
        "type": "permission-mode",
        "permissionMode": "default",
        "sessionId": new_session_id,
        "pr_review_synthetic": True,
    }
    lines.append(json.dumps(header))

    # Clean and merge entries:
    # 1. Strip tool_use/tool_result/thinking → plain text (avoids API pair-matching rules)
    # 2. Drop entries that become empty after cleaning
    # 3. Merge consecutive same-role entries (dropping a user-only-tool_reference entry
    #    can leave back-to-back assistant messages, which the API rejects)
    # 4. Rebuild parentUuid chain linearly (original chain has gaps from filtered entries)
    cleaned_entries = []
    for entry in source_entries:
        c = clean_entry(entry)
        if c is None:
            continue
        if cleaned_entries and cleaned_entries[-1].get("message", {}).get("role") == c.get("message", {}).get("role"):
            # Merge into previous entry by appending text
            prev = cleaned_entries[-1]
            prev_text = prev["message"]["content"][0]["text"]
            new_text = c["message"]["content"][0]["text"] if isinstance(c["message"]["content"], list) else c["message"]["content"]
            prev["message"]["content"][0]["text"] = prev_text + "\n" + new_text
        else:
            cleaned_entries.append(c)

    prev_uuid = None
    last_uuid = None
    for entry in cleaned_entries:
        entry["uuid"] = str(uuid.uuid4())  # fresh UUID — reusing originals causes conflicts
        entry["sessionId"] = new_session_id
        entry["cwd"] = reviewer_cwd
        entry["parentUuid"] = prev_uuid
        prev_uuid = entry["uuid"]
        last_uuid = entry["uuid"]
        lines.append(json.dumps(entry))

    # Append review preamble — linked to the end of the original chain
    user_entry = make_entry(
        entry_type="user",
        message={"role": "user", "content": REVIEW_PREAMBLE_USER},
        session_id=new_session_id,
        parent_uuid=last_uuid,
        cwd=reviewer_cwd,
        branch=branch,
    )
    lines.append(json.dumps(user_entry))

    assistant_entry = make_entry(
        entry_type="assistant",
        message={
            "role": "assistant",
            "content": [{"type": "text", "text": REVIEW_PREAMBLE_ASSISTANT}],
        },
        session_id=new_session_id,
        parent_uuid=user_entry["uuid"],
        cwd=reviewer_cwd,
        branch=branch,
    )
    lines.append(json.dumps(assistant_entry))

    return lines


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0 if "--help" in sys.argv else 1)

    source_path = sys.argv[1]
    launch = "--launch" in sys.argv

    if not Path(source_path).exists():
        print(f"Error: session file not found: {source_path}")
        sys.exit(1)

    print(f"Loading: {source_path}")
    source_entries, meta = load_session_entries(source_path)
    print(f"  {len(source_entries)} conversation entries found")

    branch = meta.get("git", {}).get("branch") or detect_branch(source_entries)
    original_cwd = meta.get("original_cwd") or detect_original_cwd(source_entries)

    if original_cwd:
        print(f"  Original cwd: {original_cwd}")
    if branch:
        print(f"  Branch: {branch}")
    if pr := meta.get("pr"):
        if pr.get("number"):
            print(f"  PR: #{pr['number']} — {pr.get('title', '')}")
            print(f"  URL: {pr.get('url', '')}")

    # Accept an explicit --cwd override; otherwise use the snapshot's original cwd so
    # that `claude --resume` can find the session from the reviewer's local checkout.
    cwd_override = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--cwd=")), None)
    reviewer_cwd = cwd_override or original_cwd or os.getcwd()

    project_hash = cwd_to_project_hash(reviewer_cwd)
    projects_dir = Path.home() / ".claude" / "projects" / project_hash
    projects_dir.mkdir(parents=True, exist_ok=True)

    new_session_id = str(uuid.uuid4())
    lines = build_synthetic_session(source_entries, new_session_id, reviewer_cwd, branch)

    out_path = projects_dir / f"{new_session_id}.jsonl"
    out_path.write_text("\n".join(lines) + "\n")
    print(f"\nSession installed: {out_path}")
    print(f"Session ID:        {new_session_id}")

    resume_cmd = f"claude --resume {new_session_id}"

    if launch:
        print(f"\nLaunching: {resume_cmd}\n")
        subprocess.run(["claude", "--resume", new_session_id], cwd=reviewer_cwd)
    else:
        print(f"\nTo start the review session, run:")
        print(f"\n    cd \"{reviewer_cwd}\" && {resume_cmd}\n")
        print("The session will open with the full original context loaded.")
        print("You have complete Claude Code access — ask questions, read files, make edits.")


if __name__ == "__main__":
    main()
