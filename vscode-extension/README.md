# Claude PR Review

A VS Code extension that lets code reviewers step into the exact Claude Code session from a PR branch — ask the author questions, read files, and make edits, all with full context.

---

## How it works

When a developer works with Claude Code on a feature branch, the session captures the full context: every question asked, every file read, every decision made. This extension packages that session and lets a reviewer resume it — so instead of reading a diff blind, you can ask *why* a decision was made and get an answer from the same AI that made it.

---

## Setup

### Coder (the person writing the code)

Run this once per machine after installing the extension:

```
Cmd+Shift+P → Claude PR Review: Setup Auto-Snapshot (Coder Mode)
```

This installs a hook into Claude Code that automatically saves a `.snapshot` file to your repo root every time you end a Claude session. The file is named after your current branch (e.g. `feature-auth.snapshot`).

**Workflow:**
1. Work on your feature branch with Claude Code as usual
2. When you exit Claude (`/exit` or Ctrl+C), the snapshot is saved automatically
3. Commit the `.snapshot` file with your branch and push

```bash
git add feature-auth.snapshot
git commit -m "add session snapshot"
git push
```

---

### Reviewer (the person reviewing the code)

**Workflow:**
1. Check out the PR branch locally
2. Open the folder in VS Code
3. A notification appears automatically:

   > **PR Review snapshot found — feature-auth**
   > `Load Session` · `Choose Directory…` · `Dismiss`

4. Click **Load Session**
5. A terminal opens running `claude --resume` with the full session context loaded

You now have a Claude Code session with complete knowledge of everything that happened during development. Ask it anything:
- *"Why did you structure it this way?"*
- *"What alternatives did you consider?"*
- *"Can you show me the tests for this?"*
- *"Make this change..."*

---

## Manual load

If the notification doesn't appear, or you want to load a snapshot file from anywhere:

```
Cmd+Shift+P → Claude PR Review: Load Snapshot…
```

Or right-click any `.snapshot` file in the Explorer sidebar → **Claude PR Review: Load This Snapshot**.

---

## Requirements

- [Claude Code](https://claude.ai/code) installed and on your PATH (`claude --version` should work in terminal)
- Python 3 (`python3 --version` should work in terminal)
- The PR branch checked out locally

---

## FAQ

**Do I need to commit the snapshot file?**
Yes — the reviewer gets it by checking out your branch. You can add `*.snapshot` to `.gitignore` if you don't want it in the repo, but then you'd need to share the file manually.

**Is the snapshot file large?**
Typically 50–500 KB depending on session length. It's plain JSON.

**Can the reviewer make real code edits?**
Yes. The resumed session has full Claude Code access — file reads, edits, bash commands, everything.

**What if I had multiple Claude sessions on the same branch?**
The hook picks the session with the most activity on that branch. You can override with `python3 export.py --list` to see all candidates.

**The snapshot notification didn't appear.**
Try `Cmd+Shift+P → Claude PR Review: Load Snapshot…` to load it manually. Make sure the `.snapshot` file is in the root of the folder you have open in VS Code.
