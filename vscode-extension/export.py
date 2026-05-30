#!/usr/bin/env python3
"""
pr-review export — bundles the Claude Code session for the current PR branch
into a portable .snapshot file that reviewers can load with load.py.

Usage:
    python export.py                        # auto-detect branch + best session
    python export.py --session <id>         # pin a specific session ID
    python export.py --output <file>        # custom output path (default: <branch>.snapshot)
    python export.py --list                 # list candidate sessions and exit

Run from the project root (same directory you ran claude in).
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


# ── git helpers ──────────────────────────────────────────────────────────────

def git(*args) -> str:
    result = subprocess.run(["git"] + list(args), capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def get_git_info() -> dict:
    branch = git("branch", "--show-current")
    remote = git("remote", "get-url", "origin")
    head = git("log", "-1", "--format=%h %s")
    base = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or "origin/main"
    return {
        "branch": branch,
        "remote": remote,
        "head_commit": head,
        "base_branch": base.split("/", 1)[-1] if "/" in base else base,
    }


def get_pr_info() -> dict:
    try:
        result = subprocess.run(
            ["gh", "pr", "view", "--json", "number,title,url,body"],
            capture_output=True, text=True
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {}


# ── session discovery ─────────────────────────────────────────────────────────

def cwd_to_project_hash(cwd: str) -> str:
    return cwd.replace("/", "-")


def scan_session(path: Path) -> dict | None:
    """Return metadata for a session file, or None if unreadable."""
    entries = []
    branches = set()
    last_ts = None
    is_synthetic = False

    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Detect sessions written by our own load.py
                if d.get("type") == "permission-mode" and d.get("pr_review_synthetic"):
                    is_synthetic = True
                    break

                if d.get("type") in ("user", "assistant") and not d.get("isSidechain"):
                    entries.append(d)
                    if b := d.get("gitBranch"):
                        branches.add(b)
                    if ts := d.get("timestamp"):
                        last_ts = ts
    except OSError:
        return None

    if is_synthetic or not entries:
        return None

    return {
        "path": path,
        "session_id": path.stem,
        "entry_count": len(entries),
        "branches": branches,
        "last_timestamp": last_ts,
        "cwd": entries[0].get("cwd", "") if entries else "",
    }


def find_sessions_for_branch(project_hash: str, branch: str) -> list[dict]:
    """Return all non-synthetic sessions that have activity on `branch`, best first."""
    projects_dir = Path.home() / ".claude" / "projects" / project_hash
    if not projects_dir.exists():
        return []

    candidates = []
    for jsonl in projects_dir.glob("*.jsonl"):
        meta = scan_session(jsonl)
        if meta and branch in meta["branches"]:
            candidates.append(meta)

    # Best first: most entries, then most recent timestamp
    candidates.sort(key=lambda m: (m["entry_count"], m["last_timestamp"] or ""), reverse=True)
    return candidates


# ── snapshot builder ──────────────────────────────────────────────────────────

def load_entries(path: Path) -> list[dict]:
    entries = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") in ("user", "assistant") and not d.get("isSidechain"):
                entries.append(d)
    return entries


def build_snapshot(session_metas: list, git_info: dict, pr_info: dict) -> dict:
    # Sort sessions chronologically by their earliest timestamp
    sorted_metas = sorted(session_metas, key=lambda m: (m["last_timestamp"] or ""))
    total = len(sorted_metas)
    all_entries = []

    for i, meta in enumerate(sorted_metas):
        entries = load_entries(meta["path"])
        if not entries:
            continue
        if total > 1:
            label = (
                f"[Session 1 of {total} — start of work on this branch]"
                if i == 0
                else f"[Session {i + 1} of {total} — developer started a new Claude session]"
            )
            all_entries.append({
                "type": "user",
                "message": {"role": "user", "content": label},
                "uuid": str(uuid.uuid4()),
                "timestamp": entries[0].get("timestamp"),
                "cwd": meta["cwd"],
            })
        all_entries.extend(entries)

    original_cwd = sorted_metas[0]["cwd"] if sorted_metas else ""
    return {
        "version": "1",
        "exported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "git": git_info,
        "pr": pr_info,
        "session": {
            "original_ids": [m["session_id"] for m in sorted_metas],
            "original_cwd": original_cwd,
            "session_count": total,
            "entry_count": len(all_entries),
            "entries": all_entries,
        },
    }


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    if "-h" in args or "--help" in args:
        print(__doc__)
        sys.exit(0)

    pinned_session = None
    output_path = None
    list_only = "--list" in args
    quiet = "--quiet" in args
    output_root = "--output-root" in args

    i = 0
    while i < len(args):
        if args[i] == "--session" and i + 1 < len(args):
            pinned_session = args[i + 1]; i += 2
        elif args[i] == "--output" and i + 1 < len(args):
            output_path = args[i + 1]; i += 2
        else:
            i += 1

    def log(*a, **kw):
        if not quiet:
            print(*a, **kw)

    # Git context
    git_info = get_git_info()
    branch = git_info.get("branch")
    if not branch:
        print("Error: not in a git repo or no branch checked out.")
        sys.exit(1)

    cwd = os.getcwd()
    project_hash = cwd_to_project_hash(cwd)

    log(f"Branch:  {branch}")
    log(f"Project: {cwd}")

    # Find sessions
    if pinned_session:
        path = Path.home() / ".claude" / "projects" / project_hash / f"{pinned_session}.jsonl"
        meta = scan_session(path)
        if not meta:
            print(f"Error: session {pinned_session} not found or unreadable.")
            sys.exit(1)
        candidates = [meta]  # single pinned session
    else:
        candidates = find_sessions_for_branch(project_hash, branch)
        if not candidates:
            # In quiet (hook) mode, exit 0 silently — no session is not an error
            if not quiet:
                print(f"No Claude Code sessions found for branch '{branch}'.")
                print(f"Looked in: ~/.claude/projects/{project_hash}/")
            sys.exit(0)

    # List mode
    if list_only:
        print(f"\nSessions for branch '{branch}' ({len(candidates)} found):\n")
        for i, m in enumerate(candidates):
            marker = " [best]" if i == 0 else ""
            print(f"  {i+1}. {m['session_id']}")
            print(f"     entries={m['entry_count']}  last={m['last_timestamp'][:10] if m['last_timestamp'] else '?'}{marker}")
        return

    # Use all sessions for the branch (or just the pinned one)
    if len(candidates) > 1:
        log(f"\nFound {len(candidates)} sessions for '{branch}' — merging all into snapshot:")
        for m in candidates:
            log(f"  {m['session_id']}  ({m['entry_count']} entries, last active {m['last_timestamp'][:10] if m['last_timestamp'] else '?'})")
        log(f"  (use --session <id> to pin a single session)\n")
    else:
        m = candidates[0]
        log(f"\nSession: {m['session_id']}  ({m['entry_count']} entries)")

    # PR metadata (optional, don't fail if gh isn't available)
    pr_info = get_pr_info()
    if pr_info:
        log(f"PR:      #{pr_info.get('number')} — {pr_info.get('title')}")

    # Build snapshot from all sessions
    log("\nBuilding snapshot...")
    snapshot = build_snapshot(candidates, git_info, pr_info)

    if not output_path:
        safe_branch = branch.replace("/", "-")
        if output_root:
            git_root = git("rev-parse", "--show-toplevel") or cwd
            output_path = str(Path(git_root) / f"{safe_branch}.snapshot")
        else:
            output_path = f"{safe_branch}.snapshot"

    # Ensure output directory exists
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w") as f:
        json.dump(snapshot, f, indent=2)

    size_kb = Path(output_path).stat().st_size // 1024
    if quiet:
        # Hook-friendly output: just the path, easy to parse
        print(output_path)
    else:
        print(f"Snapshot written: {output_path}  ({size_kb} KB)")
        print(f"  {snapshot['session']['entry_count']} conversation entries")
        print(f"  branch: {branch}")
        if git_info.get("head_commit"):
            print(f"  head:   {git_info['head_commit']}")
        print(f"\nShare {output_path} with your reviewer.")
        print(f"They run:  python load.py {output_path}")


if __name__ == "__main__":
    main()
