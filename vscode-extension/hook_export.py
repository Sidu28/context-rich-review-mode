#!/usr/bin/env python3
"""
Claude Code Stop hook — auto-exports a .snapshot to the git repo root.

Claude Code calls this script (via stdin JSON) whenever a session ends.
It reads the session's cwd, then runs export.py from that directory.
"""
import json
import subprocess
import sys
import traceback
from datetime import datetime
from pathlib import Path

LOG_FILE = Path.home() / ".claude" / "pr-review" / "hook.log"


def log(msg):
    with open(LOG_FILE, "a") as f:
        f.write(f"[{datetime.now().isoformat()}] {msg}\n")


def main():
    log("hook_export.py fired")

    raw = sys.stdin.read()
    log(f"stdin: {raw!r}")

    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        log(f"stdin parse error: {e}")
        data = {}

    log(f"parsed data keys: {list(data.keys())}")

    # cwd and session_id are provided directly in the payload
    cwd = data.get("cwd", "")
    session_id = data.get("session_id", "")
    log(f"cwd: {cwd!r}, session_id: {session_id!r}")

    if not cwd or not Path(cwd).is_dir():
        log("cwd missing or not a directory, aborting")
        return

    export_script = Path(__file__).parent / "export.py"
    log(f"export_script: {export_script}, exists: {export_script.exists()}")

    if not export_script.exists():
        log("export.py not found")
        return

    cmd = [sys.executable, str(export_script), "--quiet", "--output-root"]
    if session_id:
        cmd += ["--session", session_id]

    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    log(f"export.py exit={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}")


def find_cwd_from_transcript(transcript_path):
    try:
        with open(transcript_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if entry.get("cwd"):
                        return entry["cwd"]
                except Exception:
                    continue
    except OSError as e:
        log(f"error reading transcript: {e}")
    return None


def find_cwd_by_session_id(session_id):
    """Search all project dirs for the session file."""
    projects_root = Path.home() / ".claude" / "projects"
    if not projects_root.exists():
        return None
    for project_dir in projects_root.iterdir():
        candidate = project_dir / f"{session_id}.jsonl"
        if candidate.exists():
            cwd = find_cwd_from_transcript(str(candidate))
            if cwd:
                return cwd
    return None


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log(f"unhandled exception:\n{traceback.format_exc()}")
