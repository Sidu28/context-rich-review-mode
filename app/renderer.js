// ── xterm setup ───────────────────────────────────────────────────────────────

const term = new Terminal({
  fontFamily: "'SF Mono', 'Menlo', 'Cascadia Code', monospace",
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  theme: {
    background: '#0d0d0d',
    foreground: '#e2e2f0',
    cursor: '#7c6af7',
    selectionBackground: 'rgba(124,106,247,0.3)',
    black:   '#141414', red:     '#f56565', green:  '#3dd68c', yellow: '#f6c90e',
    blue:    '#7c6af7', magenta: '#c678dd', cyan:   '#56b6c2', white:  '#e2e2f0',
    brightBlack:   '#4a4a6a', brightRed:     '#ff7070', brightGreen:  '#5af0a0',
    brightYellow:  '#ffe066', brightBlue:    '#9580ff', brightMagenta:'#d98cee',
    brightCyan:    '#6fcfe0', brightWhite:   '#ffffff',
  },
})
const fitAddon = new FitAddon.FitAddon()
term.loadAddon(fitAddon)

let termOpened = false

window.addEventListener('resize', () => {
  if (!termOpened) return
  fitAddon.fit()
  window.api.ptyResize(term.cols, term.rows)
})

term.onData(data => window.api.ptyInput(data))
window.api.onPtyData(data => term.write(data))
window.api.onPtyExit(() => {
  term.write('\r\n\r\n\x1b[2m[Session ended — click New Review to start another]\x1b[0m\r\n')
})

// ── setup pane refs ───────────────────────────────────────────────────────────

const dropZone    = document.getElementById('dropZone')
const browseBtn   = document.getElementById('browseBtn')
const card        = document.getElementById('card')
const changeBtn   = document.getElementById('changeBtn')
const metaBranch  = document.getElementById('metaBranch')
const metaPrTitle = document.getElementById('metaPrTitle')
const metaChips   = document.getElementById('metaChips')
const dirInput    = document.getElementById('dirInput')
const btnStart    = document.getElementById('btnStart')
const statusEl    = document.getElementById('status')
const statusBody  = document.getElementById('statusBody')
const setupPane   = document.getElementById('setupPane')

const terminalPane = document.getElementById('terminalPane')
const termBranch   = document.getElementById('termBranch')
const termPr       = document.getElementById('termPr')
const btnNewReview = document.getElementById('btnNewReview')

const sidebar         = document.getElementById('sidebar')
const fileTree        = document.getElementById('fileTree')
const btnCollapseAll  = document.getElementById('btnCollapseAll')
const editorPanel     = document.getElementById('editorPanel')
const editorTabsEl    = document.getElementById('editorTabs')
const monacoContainer = document.getElementById('monacoContainer')
const resizeV         = document.getElementById('resizeV')
const resizeH         = document.getElementById('resizeH')
const terminalContainer = document.getElementById('terminalContainer')

let currentSnapshotPath = null
let currentMeta = null

// ── drag and drop ─────────────────────────────────────────────────────────────

document.addEventListener('dragover', (e) => { e.preventDefault() })
document.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (file) loadSnapshot(file.path)
})

dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'))
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', () => dropZone.classList.remove('drag-over'))

browseBtn.addEventListener('click', async () => {
  const filePath = await window.api.openFileDialog()
  if (filePath) loadSnapshot(filePath)
})

dropZone.addEventListener('click', async (e) => {
  if (e.target === browseBtn) return
  const filePath = await window.api.openFileDialog()
  if (filePath) loadSnapshot(filePath)
})

changeBtn.addEventListener('click', resetToSetup)

// ── load snapshot ─────────────────────────────────────────────────────────────

async function loadSnapshot(filePath) {
  showStatus('info', 'Reading snapshot…')
  const meta = await window.api.parseSnapshot(filePath)

  if (meta.error) {
    showStatus('err', `Could not read file: ${meta.error}`)
    return
  }

  currentSnapshotPath = filePath
  currentMeta = meta
  hideStatus()
  renderCard(meta)
}

function renderCard(meta) {
  metaBranch.textContent = meta.branch

  if (meta.prTitle) {
    metaPrTitle.style.display = 'block'
    if (meta.prUrl) {
      metaPrTitle.innerHTML = `<a class="pr-link" href="#" data-url="${meta.prUrl}">#${meta.prNumber}</a> ${escHtml(meta.prTitle)}`
      metaPrTitle.querySelector('.pr-link').addEventListener('click', (e) => {
        e.preventDefault()
        navigator.clipboard.writeText(e.target.dataset.url)
      })
    } else {
      metaPrTitle.textContent = meta.prTitle
    }
  } else {
    metaPrTitle.style.display = 'none'
  }

  metaChips.innerHTML = ''
  addChip(`${meta.entryCount} messages`)
  if (meta.headCommit) addChip(meta.headCommit.split(' ')[0])
  if (meta.exportedAt) addChip('exported ' + fmtDate(meta.exportedAt))

  dirInput.value = meta.originalCwd || ''

  dropZone.style.display = 'none'
  card.classList.add('visible')
  btnStart.classList.add('visible')
}

function addChip(text) {
  const span = document.createElement('span')
  span.className = 'meta-chip'
  span.textContent = text
  metaChips.appendChild(span)
}

// ── start review ──────────────────────────────────────────────────────────────

btnStart.addEventListener('click', async () => {
  const projectDir = dirInput.value.trim()
  if (!projectDir) {
    showStatus('err', 'Enter the local project directory first.')
    dirInput.focus()
    return
  }

  btnStart.disabled = true
  showStatus('info', 'Installing session…')

  const result = await window.api.startReview({
    snapshotPath: currentSnapshotPath,
    projectDir,
  })

  btnStart.disabled = false

  if (!result.ok) {
    showStatus('err', `Failed: ${result.error}${result.detail ? '\n' + result.detail : ''}`)
    return
  }

  showTerminal(result.sessionId, projectDir)
})

function showTerminal(sessionId, projectDir) {
  termBranch.textContent = currentMeta?.branch || ''
  if (currentMeta?.prTitle) {
    if (currentMeta?.prUrl) {
      termPr.innerHTML = `<a href="#" data-url="${currentMeta.prUrl}">#${currentMeta.prNumber} ${escHtml(currentMeta.prTitle)}</a>`
      termPr.querySelector('a').addEventListener('click', (e) => {
        e.preventDefault()
        navigator.clipboard.writeText(e.target.dataset.url)
      })
    } else {
      termPr.textContent = `#${currentMeta.prNumber} ${currentMeta.prTitle}`
    }
  } else {
    termPr.textContent = ''
  }

  setupPane.style.display = 'none'
  terminalPane.classList.add('visible')

  requestAnimationFrame(() => {
    if (!termOpened) {
      term.open(terminalContainer)
      termOpened = true
    }
    fitAddon.fit()
    window.api.ptyReady({ sessionId, projectDir, cols: term.cols, rows: term.rows })

    // Load file tree
    loadFileTree(projectDir)

    // Init Monaco (lazy, once)
    initMonaco()
  })
}

// ── new review button ─────────────────────────────────────────────────────────

btnNewReview.addEventListener('click', () => {
  window.api.killPty()
  term.clear()
  resetToSetup()
})

function resetToSetup() {
  currentSnapshotPath = null
  currentMeta = null
  terminalPane.classList.remove('visible')
  setupPane.style.display = ''
  card.classList.remove('visible')
  btnStart.classList.remove('visible')
  dropZone.style.display = ''
  hideStatus()
  closeAllTabs()
  fileTree.innerHTML = ''
}

// ── Monaco editor ─────────────────────────────────────────────────────────────

let editor = null
let monacoReady = false
let pendingOpen = null

function initMonaco() {
  if (monacoReady || typeof require === 'undefined') return
  require.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } })
  require(['vs/editor/editor.main'], () => {
    editor = monaco.editor.create(monacoContainer, {
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'gutter',
    })
    editor.onDidChangeModelContent(() => {
      const model = editor.getModel()
      if (!model) return
      const tab = tabs.find(t => t.model === model)
      if (tab && !tab.dirty) {
        tab.dirty = true
        renderTabs()
      }
    })
    monacoReady = true
    if (pendingOpen) {
      openFile(pendingOpen)
      pendingOpen = null
    }
  })
}

// Keyboard shortcut: Cmd+S / Ctrl+S to save
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    saveActiveTab()
  }
})

// ── Tab management ────────────────────────────────────────────────────────────

let tabs = []
let activeTabPath = null

function openFile(filePath) {
  if (!monacoReady) {
    pendingOpen = filePath
    return
  }

  // Activate existing tab
  const existing = tabs.find(t => t.path === filePath)
  if (existing) {
    activateTab(filePath)
    return
  }

  window.api.readFile(filePath).then(({ ok, content, error }) => {
    if (!ok) { console.error('read-file error:', error); return }

    const model = monaco.editor.createModel(content, detectLang(filePath))
    tabs.push({ path: filePath, model, dirty: false })
    editorPanel.classList.remove('hidden')
    activateTab(filePath)
  })
}

function activateTab(filePath) {
  activeTabPath = filePath
  const tab = tabs.find(t => t.path === filePath)
  if (tab && editor) {
    editor.setModel(tab.model)
    editor.focus()
  }
  renderTabs()
  highlightTreeRow(filePath)
}

function closeTab(filePath) {
  const idx = tabs.findIndex(t => t.path === filePath)
  if (idx === -1) return
  tabs[idx].model.dispose()
  tabs.splice(idx, 1)

  if (activeTabPath === filePath) {
    const next = tabs[Math.min(idx, tabs.length - 1)]
    if (next) {
      activateTab(next.path)
    } else {
      activeTabPath = null
      if (editor) editor.setModel(null)
      editorPanel.classList.add('hidden')
    }
  }
  renderTabs()
}

function closeAllTabs() {
  tabs.forEach(t => t.model.dispose())
  tabs = []
  activeTabPath = null
  if (editor) editor.setModel(null)
  editorPanel.classList.add('hidden')
  renderTabs()
}

function renderTabs() {
  editorTabsEl.innerHTML = ''
  for (const tab of tabs) {
    const name = tab.path.split('/').pop()
    const div = document.createElement('div')
    div.className = 'tab' + (tab.path === activeTabPath ? ' active' : '')

    const nameEl = document.createElement('span')
    nameEl.className = 'tab-name'
    nameEl.title = tab.path
    nameEl.textContent = name

    const closeEl = document.createElement('span')
    closeEl.className = 'tab-close'
    closeEl.innerHTML = tab.dirty ? '&#9679;' : '&times;'
    if (tab.dirty) closeEl.style.color = 'var(--accent)'
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(tab.path) })

    div.appendChild(nameEl)
    div.appendChild(closeEl)
    div.addEventListener('click', () => activateTab(tab.path))
    editorTabsEl.appendChild(div)
  }
}

async function saveActiveTab() {
  if (!activeTabPath || !editor) return
  const tab = tabs.find(t => t.path === activeTabPath)
  if (!tab) return
  const content = editor.getValue()
  const { ok, error } = await window.api.writeFile(tab.path, content)
  if (ok) {
    tab.dirty = false
    renderTabs()
  } else {
    console.error('write-file error:', error)
  }
}

// ── File tree ─────────────────────────────────────────────────────────────────

let treeData = []
let expandedPaths = new Set()
let selectedPath = null

async function loadFileTree(projectDir) {
  fileTree.innerHTML = '<div style="padding: 8px 14px; font-size: 12px; color: var(--muted);">Loading…</div>'
  const { ok, tree, error } = await window.api.listDirectory(projectDir)
  if (!ok) {
    fileTree.innerHTML = `<div style="padding: 8px 14px; font-size: 12px; color: var(--red);">${error}</div>`
    return
  }
  treeData = tree
  renderTree()
}

function renderTree() {
  fileTree.innerHTML = ''
  renderNodes(treeData, 0, fileTree)
}

function renderNodes(nodes, depth, container) {
  for (const node of nodes) {
    const row = document.createElement('div')
    row.className = 'tree-row' + (node.path === selectedPath ? ' selected' : '') + (expandedPaths.has(node.path) ? ' expanded' : '')
    row.style.paddingLeft = `${8 + depth * 14}px`
    row.dataset.path = node.path

    const arrow = document.createElement('span')
    arrow.className = 'arrow'
    arrow.textContent = node.type === 'dir' ? '›' : ''

    const icon = document.createElement('span')
    icon.className = 'tree-icon'
    icon.textContent = node.type === 'dir' ? (expandedPaths.has(node.path) ? '📂' : '📁') : fileIcon(node.name)

    const label = document.createElement('span')
    label.className = 'tree-name'
    label.textContent = node.name

    row.appendChild(arrow)
    row.appendChild(icon)
    row.appendChild(label)
    container.appendChild(row)

    if (node.type === 'dir') {
      const childContainer = document.createElement('div')
      childContainer.dataset.children = node.path
      if (expandedPaths.has(node.path) && node.children?.length) {
        renderNodes(node.children, depth + 1, childContainer)
      }
      container.appendChild(childContainer)

      row.addEventListener('click', () => {
        if (expandedPaths.has(node.path)) {
          expandedPaths.delete(node.path)
        } else {
          expandedPaths.add(node.path)
        }
        renderTree()
      })
    } else {
      row.addEventListener('click', () => {
        selectedPath = node.path
        renderTree()
        openFile(node.path)
      })
    }
  }
}

function highlightTreeRow(filePath) {
  selectedPath = filePath
  document.querySelectorAll('.tree-row').forEach(r => {
    r.classList.toggle('selected', r.dataset.path === filePath)
  })
}

btnCollapseAll.addEventListener('click', () => {
  expandedPaths.clear()
  renderTree()
})

// ── Resize handles ────────────────────────────────────────────────────────────

// Vertical: sidebar width
resizeV.addEventListener('mousedown', (e) => {
  e.preventDefault()
  resizeV.classList.add('dragging')
  const startX = e.clientX
  const startW = sidebar.offsetWidth

  function onMove(e) {
    const w = Math.max(120, Math.min(600, startW + e.clientX - startX))
    sidebar.style.width = w + 'px'
  }
  function onUp() {
    resizeV.classList.remove('dragging')
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    if (editor) editor.layout()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
})

// Horizontal: editor vs terminal split
resizeH.addEventListener('mousedown', (e) => {
  e.preventDefault()
  resizeH.classList.add('dragging')
  const startY = e.clientY
  const startH = editorPanel.offsetHeight

  function onMove(e) {
    const h = Math.max(80, startH + e.clientY - startY)
    editorPanel.style.flex = 'none'
    editorPanel.style.height = h + 'px'
    if (editor) editor.layout()
    fitAddon.fit()
    window.api.ptyResize(term.cols, term.rows)
  }
  function onUp() {
    resizeH.classList.remove('dragging')
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
})

// ── helpers ───────────────────────────────────────────────────────────────────

function detectLang(filePath) {
  const ext = filePath.split('.').pop().toLowerCase()
  return {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', json: 'json', md: 'markdown', html: 'html', css: 'css',
    scss: 'scss', sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml',
    toml: 'ini', rs: 'rust', go: 'go', rb: 'ruby', java: 'java', c: 'c',
    cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  }[ext] || 'plaintext'
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  const icons = {
    js: '🟨', jsx: '🟨', ts: '🔷', tsx: '🔷', py: '🐍', json: '📋',
    md: '📝', html: '🌐', css: '🎨', scss: '🎨', sh: '📜', yaml: '⚙️',
    yml: '⚙️', toml: '⚙️', rs: '🦀', go: '🐹', rb: '💎', java: '☕',
  }
  return icons[ext] || '📄'
}

function showStatus(type, text) {
  statusEl.className = `status visible ${type}`
  statusBody.textContent = text
}

function hideStatus() {
  statusEl.className = 'status'
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return iso }
}
