const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const pty = require('node-pty')

const LOAD_SCRIPT = path.join(__dirname, '..', 'load.py')

let win = null
let activePty = null

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 600,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (activePty) activePty.kill()
  if (process.platform !== 'darwin') app.quit()
})

// ── open file dialog ──────────────────────────────────────────────────────────

ipcMain.handle('open-file-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'PR Snapshots', extensions: ['snapshot', 'jsonl'] }],
    properties: ['openFile'],
  })
  return canceled ? null : filePaths[0]
})

// ── parse snapshot metadata (no side effects) ─────────────────────────────────

ipcMain.handle('parse-snapshot', async (_event, filePath) => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    if (data.session) {
      return {
        format: 'snapshot',
        branch: data.git?.branch || '—',
        headCommit: data.git?.head_commit || '—',
        remote: data.git?.remote || '—',
        prNumber: data.pr?.number || null,
        prTitle: data.pr?.title || null,
        prUrl: data.pr?.url || null,
        entryCount: data.session?.entry_count || 0,
        exportedAt: data.exported_at || null,
        originalCwd: data.session?.original_cwd || '',
      }
    }
    return parseJsonl(raw)
  } catch (e) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      return parseJsonl(raw)
    } catch {
      return { error: e.message }
    }
  }
})

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

// ── install session + spawn embedded PTY ─────────────────────────────────────

ipcMain.handle('start-review', async (_event, { snapshotPath, projectDir }) => {
  return new Promise((resolve) => {
    // 1. Run load.py to install the synthetic session
    const py = spawn('python3', [LOAD_SCRIPT, snapshotPath, `--cwd=${projectDir}`], { cwd: projectDir })

    let stdout = '', stderr = ''
    py.stdout.on('data', d => { stdout += d.toString() })
    py.stderr.on('data', d => { stderr += d.toString() })

    py.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr || `load.py exited with code ${code}` })
        return
      }

      const match = stdout.match(/Session ID:\s+([0-9a-f-]{36})/i)
      if (!match) {
        resolve({ ok: false, error: 'Could not parse session ID from load.py output', detail: stdout })
        return
      }

      resolve({ ok: true, sessionId: match[1] })
    })
  })
})

// ── PTY lifecycle ─────────────────────────────────────────────────────────────

// Renderer signals it's ready to receive data; we spawn the PTY now so no
// output is lost before xterm is attached.
ipcMain.on('pty-ready', (_event, { sessionId, projectDir, cols, rows }) => {
  if (activePty) {
    activePty.kill()
    activePty = null
  }

  activePty = pty.spawn('claude', ['--resume', sessionId], {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 36,
    cwd: projectDir,
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  activePty.on('data', (data) => {
    if (win) win.webContents.send('pty-data', data)
  })

  activePty.on('exit', () => {
    if (win) win.webContents.send('pty-exit')
    activePty = null
  })

  // Expand the window for the terminal view
  if (win) win.setSize(1400, 820, true)
})

ipcMain.on('pty-input', (_event, data) => {
  if (activePty) activePty.write(data)
})

ipcMain.on('pty-resize', (_event, { cols, rows }) => {
  if (activePty) activePty.resize(cols, rows)
})

ipcMain.on('kill-pty', () => {
  if (activePty) {
    activePty.kill()
    activePty = null
  }
  if (win) win.setSize(720, 600, true)
})

// ── file system IPC ───────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set(['node_modules', '.git', '.claude', '__pycache__', 'dist', '.next', '.venv', 'venv'])

function buildTree(dirPath, depth = 0) {
  if (depth > 3) return []
  let entries
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }) } catch { return [] }
  const result = []
  for (const e of entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })) {
    if (e.name.startsWith('.') && e.isDirectory()) continue
    const fullPath = path.join(dirPath, e.name)
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      result.push({ name: e.name, path: fullPath, type: 'dir', children: buildTree(fullPath, depth + 1) })
    } else {
      result.push({ name: e.name, path: fullPath, type: 'file' })
    }
  }
  return result
}

ipcMain.handle('list-directory', async (_e, dirPath) => {
  try {
    return { ok: true, tree: buildTree(dirPath) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('read-file', async (_e, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return { ok: true, content }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('write-file', async (_e, filePath, content) => {
  try {
    fs.writeFileSync(filePath, content, 'utf8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})
