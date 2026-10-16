const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { writeFileAtomically } = require('./atomic-write.cjs');
const { FileTargets } = require('./file-targets.cjs');
const { createLocalAiService } = require('./local-ai-service.cjs');
const PROJECT = require('../src/project-format.json');

app.setName(PROJECT.productName);

const MAX_BYTES = 64 * 1024 * 1024;
const entry = path.resolve(__dirname, '../dist/index.html');
const entryUrl = pathToFileURL(entry).href;
const hidden = process.argv.includes('--hidden');
let mainWindow;
let dialogBusy = false;
let closeRequest = null;
const fileTargets = new FileTargets();
const localAi = createLocalAiService();

function authorized(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entryUrl) {
    throw new Error('Untrusted desktop request.');
  }
}

function handle(name, callback) {
  ipcMain.handle(`paint:${name}`, async (event, ...args) => {
    authorized(event);
    if (args.length > 1) throw new Error('Invalid desktop request.');
    return callback(...args);
  });
}

async function withDialog(callback) {
  if (dialogBusy) throw new Error('Finish the current dialog first.');
  dialogBusy = true;
  try { return await callback(); } finally { dialogBusy = false; }
}

function suggestedName(value, extension) {
  if (typeof value !== 'string' || value.length > 250) throw new Error('Invalid filename.');
  let stem = value.replace(/^.*[/\\]/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
  const suffix = stem.slice(stem.lastIndexOf('.') + 1).toLowerCase();
  if (stem.includes('.') && ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'paint', ...PROJECT.readableExtensions].includes(suffix)) stem = stem.slice(0, stem.lastIndexOf('.'));
  stem = stem.replace(/[. ]+$/g, '') || 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
  return `${stem}.${extension}`;
}

async function readBounded(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Choose a regular file smaller than 64 MiB.');
    const bytes = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await file.read(bytes, total, bytes.length - total, total);
      if (!result.bytesRead) break;
      total += result.bytesRead;
    }
    if (total > stat.size) throw new Error('The file changed while being opened. Try again.');
    return bytes.subarray(0, total);
  } finally { await file.close(); }
}

async function openedFile(filePath, owner) {
  const bytes = new Uint8Array(await readBounded(filePath));
  if (!owner || mainWindow !== owner || owner.isDestroyed()) return null;
  const name = path.basename(filePath), format = fileTargets.formatForName(name);
  return { bytes, name, ...(format ? { target: fileTargets.grant(filePath, format), targetFormat: format } : {}) };
}

async function saveFile(request, format, options, bytes) {
  const owner = mainWindow;
  let destination;
  if (request.target !== undefined) destination = fileTargets.resolve(request.target, format);
  else {
    const result = await dialog.showSaveDialog(mainWindow, options);
    if (result.canceled || !result.filePath) return false;
    destination = result.filePath;
  }
  if (!owner || mainWindow !== owner || owner.isDestroyed()) return false;
  await writeFileAtomically(destination, bytes);
  if (mainWindow !== owner || owner.isDestroyed()) return false;
  return { name: path.basename(destination), target: request.target ?? fileTargets.grant(destination, format) };
}

function registerHandlers() {
  handle('local-ai-status', () => localAi.status());
  handle('local-ai-probe', request => localAi.probe(request));
  handle('local-ai-run', request => localAi.run(request));
  handle('local-ai-cancel', request => localAi.cancel(request));
  handle('open-image', (request) => withDialog(async () => {
    const owner = mainWindow;
    if (request !== undefined && (!request || typeof request.allowProjects !== 'boolean')) throw new Error('Invalid open request.');
    const extensions = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'];
    if (request?.allowProjects) extensions.push('paint', ...PROJECT.readableExtensions);
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open image', properties: ['openFile'],
      filters: [{ name: request?.allowProjects ? 'Images and layered projects' : 'Images', extensions }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return openedFile(result.filePaths[0], owner);
  }));
  handle('save-image', (request) => withDialog(async () => {
    if (!request || !['png', 'jpeg', 'webp', 'bmp', 'gif', 'tiff'].includes(request.format) ||
        !Array.isArray(request.bytes) || request.bytes.length === 0 || request.bytes.length > MAX_BYTES ||
        !request.bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
      throw new Error('Invalid image data or unsupported format. Maximum encoded size is 64 MiB.');
    }
    const extension = request.format === 'jpeg' ? 'jpg' : request.format;
    return saveFile(request, request.format, {
      title: 'Save image', defaultPath: suggestedName(request.suggestedName, extension),
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    }, Buffer.from(request.bytes));
  }));
  handle('open-project', () => withDialog(async () => {
    const owner = mainWindow;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open layered project', properties: ['openFile'],
      filters: [{ name: 'Layered projects', extensions: ['paint', ...PROJECT.readableExtensions] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return openedFile(result.filePaths[0], owner);
  }));
  handle('save-project', (request) => withDialog(async () => {
    if (!request || typeof request.text !== 'string' || Buffer.byteLength(request.text) > MAX_BYTES) {
      throw new Error('Invalid project data. Maximum project size is 64 MiB.');
    }
    const data = JSON.parse(request.text);
    if (!PROJECT.readableFormats.includes(data?.format) || data.version !== PROJECT.schemaVersion || !Array.isArray(data.layers)) {
      throw new Error('Unsupported project format.');
    }
    return saveFile(request, PROJECT.extension, {
      title: 'Save layered project', defaultPath: suggestedName(request.suggestedName, PROJECT.extension),
      filters: [{ name: `${PROJECT.productName} project`, extensions: [PROJECT.extension] }],
    }, JSON.stringify({ ...data, format: PROJECT.format, version: PROJECT.schemaVersion }));
  }));
  handle('set-title', (title) => {
    if (typeof title !== 'string' || title.length > 500 || /[\u0000-\u001f]/.test(title)) throw new Error('Invalid title.');
    mainWindow.setTitle(title);
  });
  handle('save-paint', (request) => withDialog(async () => {
    if (!request || !(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > MAX_BYTES) {
      throw new Error('Invalid .paint bytes. Maximum project size is 64 MiB.');
    }
    return saveFile(request, 'paint', {
      title: 'Save Paint project', defaultPath: suggestedName(request.suggestedName, 'paint'),
      filters: [{ name: 'Paint project', extensions: ['paint'] }],
    }, Buffer.from(request.bytes));
  }));
  handle('print', () => withDialog(() => new Promise((resolve, reject) => {
    mainWindow.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
      if (success) resolve(true);
      else if (/cancel/i.test(reason || '')) resolve(false);
      else reject(new Error(reason || 'Printing failed.'));
    });
  })));
  handle('confirm-save-changes', () => withDialog(async () => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Unsaved changes', message: 'Do you want to save your changes?',
      buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    });
    return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel';
  }));
  handle('finish-close', (request) => {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).length !== 2 || typeof request.requestId !== 'string' || typeof request.allow !== 'boolean' ||
        !closeRequest || closeRequest.owner !== mainWindow || closeRequest.requestId !== request.requestId || closeRequest.finalizing) {
      throw new Error('Invalid or expired close request.');
    }
    if (!request.allow) { closeRequest = null; return false; }
    const pending = closeRequest;
    pending.finalizing = true;
    // Retry normal close. The renderer must independently allow beforeunload
    // for the exact document state it approved; main never overrides that gate.
    try { pending.owner.close(); }
    catch (error) { if (closeRequest === pending) closeRequest = null; throw error; }
    return true;
  });
}

function createWindow() {
  fileTargets.clear();
  closeRequest = null;
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 800, minHeight: 600, title: PROJECT.productName, show: !hidden,
    backgroundColor: '#f3f3f3', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !hidden },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const owner = mainWindow;
  owner.webContents.on('render-process-gone', () => {
    if (owner !== mainWindow) return;
    const operation = localAi.status().value.active;
    if (operation) void localAi.cancel({ id: operation.id });
  });
  let closeIntent = false;
  owner.on('close', () => { closeIntent = true; });
  owner.webContents.on('will-prevent-unload', () => {
    if (owner !== mainWindow) return;
    // Reload also emits will-prevent-unload. Only a real window-close attempt
    // may start a workflow that eventually closes the window.
    const requestedClose = closeIntent;
    closeIntent = false;
    if (!requestedClose) return;
    // A newer edit can veto the final retry. Retire its nonce without starting
    // another prompt; the user may request close again for the newer document.
    if (closeRequest?.finalizing) { closeRequest = null; return; }
    if (dialogBusy || closeRequest) return;
    closeRequest = { owner, requestId: randomUUID(), finalizing: false };
    owner.webContents.send('paint:close-requested', closeRequest.requestId);
  });
  owner.on('closed', () => {
    const operation = localAi.status().value.active;
    if (operation) void localAi.cancel({ id: operation.id });
    fileTargets.clear(); closeRequest = null; mainWindow = null;
  });
  mainWindow.loadFile(entry);
}

app.whenReady().then(() => {
  const allowClipboard = (contents, permission) => Boolean(mainWindow &&
    contents === mainWindow.webContents && contents.getURL() === entryUrl &&
    ['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => allowClipboard(contents, permission));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(allowClipboard(contents, permission)));
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'"],
    } });
  });
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
let aiExitCancellation = null;
app.on('before-quit', event => {
  const state = localAi.status().value;
  if (!state.active) return;
  event.preventDefault();
  if (!aiExitCancellation) aiExitCancellation = localAi.cancel({ id: state.active.id }).then(result => {
    aiExitCancellation = null;
    if (result.ok) app.quit();
    else console.error('Local worker cleanup is unresolved; application exit remains blocked.');
  });
});
