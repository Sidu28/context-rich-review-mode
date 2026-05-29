const vscode = require('vscode')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const LOAD_SCRIPT       = path.join(__dirname, 'load.py')
const EXPORT_SCRIPT     = path.join(__dirname, 'export.py')
const HOOK_EXPORT_SCRIPT = path.join(__dirname, 'hook_export.py')

// Stable location for hook scripts — survives extension updates
const PR_REVIEW_DIR = path.join(os.homedir(), '.claude', 'pr-review')

let outputChannel

// ── activation ────────────────────────────────────────────────────────────────

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('PR Review')

  context.subscriptions.push(
    outputChannel,
    vscode.commands.registerCommand('pr-review.loadSnapshot',     () => startFlow(null)),
    vscode.commands.registerCommand('pr-review.loadSnapshotFile', (uri) => startFlow(uri?.fsPath ?? null)),
    vscode.commands.registerCommand('pr-review.setupCoder',       () => setupCoderMode(context)),
  )

  // Reviewer: scan workspace for snapshots on open
  checkWorkspaceForSnapshots()

  // Reviewer: watch for new/updated snapshot files while workspace is open
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.snapshot')
  watcher.onDidCreate(uri => offerLoadSnapshot(uri.fsPath))
  watcher.onDidChange(uri => offerLoadSnapshot(uri.fsPath))
  context.subscriptions.push(watcher)

  // Re-check when a new folder is added to the workspace
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => checkWorkspaceForSnapshots())
  )
}

// ── reviewer: auto-detect snapshots ──────────────────────────────────────────

async function checkWorkspaceForSnapshots() {
  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) return

  for (const folder of folders) {
    const pattern = new vscode.RelativePattern(folder, '*.snapshot')
    const found = await vscode.workspace.findFiles(pattern, null, 1)
    if (found.length) {
      offerLoadSnapshot(found[0].fsPath)
      return  // one notification at a time
    }
  }
}

// Tracks which snapshots we've already offered so we don't spam
const offeredSnapshots = new Set()

async function offerLoadSnapshot(snapshotPath) {
  if (offeredSnapshots.has(snapshotPath)) return
  offeredSnapshots.add(snapshotPath)

  let meta
  try { meta = parseSnapshot(snapshotPath) } catch { return }

  const label = meta.prTitle
    ? `#${meta.prNumber} ${meta.prTitle}`
    : meta.branch !== '—' ? `branch: ${meta.branch}` : path.basename(snapshotPath)

  const projectDir = resolveProjectDir(snapshotPath, meta)

  const choice = await vscode.window.showInformationMessage(
    `PR Review snapshot found — ${label}`,
    'Load Session',
    'Choose Directory…',
    'Dismiss',
  )

  if (choice === 'Load Session' && projectDir) {
    await runReviewSession(snapshotPath, projectDir, meta)
  } else if (choice === 'Choose Directory…' || (choice === 'Load Session' && !projectDir)) {
    await startFlow(snapshotPath)
  }
}

// Best-effort project dir: prefer the open workspace folder whose path matches
// the snapshot's originalCwd, then fall back to the first workspace folder.
function resolveProjectDir(snapshotPath, meta) {
  const folders = vscode.workspace.workspaceFolders
  if (!folders?.length) return meta.originalCwd || null

  // Snapshot lives inside one of the workspace folders — use that one
  for (const f of folders) {
    if (snapshotPath.startsWith(f.uri.fsPath)) return f.uri.fsPath
  }

  // originalCwd matches a workspace folder
  if (meta.originalCwd) {
    for (const f of folders) {
      if (meta.originalCwd.startsWith(f.uri.fsPath) || f.uri.fsPath === meta.originalCwd) {
        return f.uri.fsPath
      }
    }
  }

  return folders[0].uri.fsPath
}

// ── manual flow (command palette / context menu) ──────────────────────────────

async function startFlow(snapshotPath) {
  outputChannel.appendLine(`[PR Review] LOAD_SCRIPT: ${LOAD_SCRIPT}`)
  outputChannel.appendLine(`[PR Review] load.py exists: ${fs.existsSync(LOAD_SCRIPT)}`)

  if (!snapshotPath) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'PR Snapshots': ['snapshot', 'jsonl'] },
      title: 'Select a PR snapshot file',
    })
    if (!uris?.length) return
    snapshotPath = uris[0].fsPath
  }

  let meta
  try {
    meta = parseSnapshot(snapshotPath)
  } catch (e) {
    vscode.window.showErrorMessage(`PR Review: Could not read snapshot — ${e.message}`)
    return
  }

  const summary = buildSummary(meta)
  const defaultDir = resolveProjectDir(snapshotPath, meta) || ''

  const projectDir = await vscode.window.showInputBox({
    title: `PR Review — ${summary}`,
    prompt: 'Local project directory (your checkout of the PR branch)',
    value: defaultDir,
    validateInput: (v) => (v.trim() ? null : 'Enter the project directory path'),
  })
  if (projectDir === undefined) return

  await runReviewSession(snapshotPath, projectDir.trim(), meta)
}

// ── core: run load.py and open terminal ───────────────────────────────────────

async function runReviewSession(snapshotPath, projectDir, meta) {
  if (!meta) {
    try { meta = parseSnapshot(snapshotPath) } catch {}
  }

  const summary = buildSummary(meta || {})

  const sessionId = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `PR Review: Installing session — ${summary}`,
      cancellable: false,
    },
    () => runLoadPy(snapshotPath, projectDir),
  )
  if (!sessionId) return

  const terminalName = meta?.prTitle
    ? `PR #${meta.prNumber}: ${meta.branch}`
    : `PR Review: ${meta?.branch || 'session'}`

  const terminal = vscode.window.createTerminal({ name: terminalName, cwd: projectDir })
  terminal.show()
  terminal.sendText(`claude --resume ${sessionId}`)
}

// ── load.py runner ────────────────────────────────────────────────────────────

function runLoadPy(snapshotPath, projectDir) {
  return new Promise((resolve) => {
    outputChannel.clear()
    outputChannel.appendLine(`Running: python3 ${LOAD_SCRIPT}`)
    outputChannel.appendLine(`snapshot: ${snapshotPath}`)
    outputChannel.appendLine(`cwd:      ${projectDir}`)
    outputChannel.appendLine('')

    const py = spawn('python3', [LOAD_SCRIPT, snapshotPath, `--cwd=${projectDir}`], { cwd: projectDir })

    let stdout = '', stderr = ''
    py.stdout.on('data', (d) => { const s = d.toString(); stdout += s; outputChannel.append(s) })
    py.stderr.on('data', (d) => { const s = d.toString(); stderr += s; outputChannel.append(s) })

    py.on('close', (code) => {
      if (code !== 0) {
        outputChannel.show(true)
        vscode.window.showErrorMessage(
          `PR Review: load.py failed (exit ${code}) — see Output panel for details`,
          'Show Output',
        ).then(c => { if (c === 'Show Output') outputChannel.show() })
        resolve(null)
        return
      }

      const match = stdout.match(/Session ID:\s+([0-9a-f-]{36})/i)
      if (!match) {
        outputChannel.show(true)
        vscode.window.showErrorMessage('PR Review: Could not parse session ID — see Output panel')
        resolve(null)
        return
      }

      resolve(match[1])
    })

    py.on('error', (err) => {
      outputChannel.appendLine(`spawn error: ${err.message}`)
      outputChannel.show(true)
      vscode.window.showErrorMessage(`PR Review: Failed to run python3 — ${err.message}`)
      resolve(null)
    })
  })
}

// ── coder mode setup ──────────────────────────────────────────────────────────

async function setupCoderMode(context) {
  // 1. Copy scripts to stable location
  try {
    fs.mkdirSync(PR_REVIEW_DIR, { recursive: true })
    fs.copyFileSync(EXPORT_SCRIPT,      path.join(PR_REVIEW_DIR, 'export.py'))
    fs.copyFileSync(HOOK_EXPORT_SCRIPT, path.join(PR_REVIEW_DIR, 'hook_export.py'))
  } catch (e) {
    vscode.window.showErrorMessage(`PR Review: Could not install scripts — ${e.message}`)
    return
  }

  // 2. Update ~/.claude/settings.json to add Stop hook
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const hookCommand = `python3 ${path.join(PR_REVIEW_DIR, 'hook_export.py')}`

  let settings = {}
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    }
  } catch (e) {
    vscode.window.showErrorMessage(`PR Review: Could not read ~/.claude/settings.json — ${e.message}`)
    return
  }

  // Merge hook into existing settings without clobbering other hooks
  if (!settings.hooks) settings.hooks = {}
  if (!settings.hooks.Stop) settings.hooks.Stop = []

  const alreadyInstalled = settings.hooks.Stop.some(
    group => group.hooks?.some(h => h.command?.includes('pr-review'))
  )

  if (!alreadyInstalled) {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: hookCommand }],
    })

    try {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    } catch (e) {
      vscode.window.showErrorMessage(`PR Review: Could not write ~/.claude/settings.json — ${e.message}`)
      return
    }
  }

  vscode.window.showInformationMessage(
    alreadyInstalled
      ? 'PR Review coder mode is already set up.'
      : 'PR Review coder mode enabled. A .snapshot file will be saved to your repo root each time a Claude session ends.',
  )
}

// ── snapshot parsing ──────────────────────────────────────────────────────────

function parseSnapshot(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
  try {
    const data = JSON.parse(raw)
    if (data.session) {
      return {
        format: 'snapshot',
        branch: data.git?.branch || '—',
        headCommit: data.git?.head_commit || '—',
        remote: data.git?.remote || '—',
        prNumber: data.pr?.number ?? null,
        prTitle: data.pr?.title ?? null,
        prUrl: data.pr?.url ?? null,
        entryCount: data.session?.entry_count || 0,
        exportedAt: data.exported_at ?? null,
        originalCwd: data.session?.original_cwd || '',
      }
    }
  } catch {}
  return parseJsonl(raw)
}

function parseJsonl(raw) {
  const lines = raw.trim().split('\n')
  let branch = null, cwd = null, ts = null, count = 0
  for (const line of lines) {
    try {
      const d = JSON.parse(line)
      if (d.type === 'user' || d.type === 'assistant') {
        if (!d.isSidechain) count++
        if (!branch && d.gitBranch) branch = d.gitBranch
        if (!cwd && d.cwd) cwd = d.cwd
        if (d.timestamp) ts = d.timestamp
      }
    } catch {}
  }
  return { format: 'jsonl', branch: branch || '—', originalCwd: cwd || '', entryCount: count, exportedAt: ts }
}

function buildSummary(meta) {
  const parts = []
  if (meta.branch && meta.branch !== '—') parts.push(meta.branch)
  if (meta.prTitle) parts.push(`#${meta.prNumber} ${meta.prTitle}`)
  if (meta.entryCount) parts.push(`${meta.entryCount} messages`)
  return parts.join(' · ') || 'unknown snapshot'
}

function deactivate() {}

module.exports = { activate, deactivate }
