const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { writeFileAtomically } = require('./atomic-write.cjs');
const { FileTargets } = require('./file-targets.cjs');
const PROJECT = require('../src/project-format.json');

app.setName(PROJECT.productName);

const MAX_BYTES = 64 * 1024 * 1024;
const entry = path.resolve(__dirname, '../dist/index.html');
const entryUrl = pathToFileURL(entry).href;
const hidden = process.argv.includes('--hidden');
let mainWindow;
let dialogBusy = false;
const fileTargets = new FileTargets();

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
  handle('confirm-discard', () => withDialog(async () => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: 'Unsaved changes', message: 'Discard unsaved changes?',
      detail: 'Save your work first if you want to keep it.', buttons: ['Keep editing', 'Discard'],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  }));
}

function createWindow() {
  fileTargets.clear();
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 800, minHeight: 600, title: PROJECT.productName, show: !hidden,
    backgroundColor: '#f3f3f3', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !hidden },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    if (dialogBusy) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', title: 'Unsaved changes', message: 'Discard unsaved changes and close?',
      buttons: ['Keep editing', 'Discard'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (choice === 1) event.preventDefault();
  });
  mainWindow.on('closed', () => { fileTargets.clear(); mainWindow = null; });
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
