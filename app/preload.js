const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parseSnapshot: (filePath) => ipcRenderer.invoke('parse-snapshot', filePath),
  startReview: (opts) => ipcRenderer.invoke('start-review', opts),

  // PTY
  ptyReady: (opts) => ipcRenderer.send('pty-ready', opts),
  ptyInput: (data) => ipcRenderer.send('pty-input', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  killPty: () => ipcRenderer.send('kill-pty'),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e) => cb()),

  // File system
  listDirectory: (dirPath) => ipcRenderer.invoke('list-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
})
