import { chromium } from 'playwright-core';
import { verifyInteractions } from './verify-interactions.mjs';
import { verifyPendingShapesDesktop } from './verify-pending-shapes-desktop.mjs';
import { verifySelectionDesktop } from './verify-selection-desktop.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Attach only to an already running, dedicated test instance. This harness
// neither launches an app nor interacts with the operating system desktop.
const output = new URL('../output/', import.meta.url);
const checks = [], errors = [], pending = new Map();
let socket, browser, version, fixturesOwned = false, sequence = 0;
await fs.mkdir(output, { recursive: true });

function check(name, ok, detail = null) {
  checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
}

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

async function main(expression) {
  const id = ++sequence;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Main-process inspector request timed out.'));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function fixture(name, previousContent) {
  return main(`(() => {
    const q = globalThis.__sjPaintVerification;
    q.file = q.path.join(q.directory, ${JSON.stringify(name)});
    ${previousContent === undefined ? '' : `q.fs.writeFileSync(q.file, ${JSON.stringify(previousContent)});`}
    return q.file;
  })()`);
}

async function readProject() {
  return main('JSON.parse(__sjPaintVerification.fs.readFileSync(__sjPaintVerification.file, "utf8"))');
}

async function waitForFile() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const size = await main('(() => { const q = __sjPaintVerification; return q.fs.existsSync(q.file) ? q.fs.statSync(q.file).size : 0; })()');
    if (size > 50) return size;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Native save did not produce a complete fixture within 10 seconds.');
}

try {
  const response = await fetch('http://127.0.0.1:9231/json/list', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Main inspector discovery failed: HTTP ${response.status}`);
  const targets = await response.json();
  if (targets.length !== 1 || !targets[0].webSocketDebuggerUrl) throw new Error('Expected exactly one dedicated main-process inspector target.');
  const endpoint = new URL(targets[0].webSocketDebuggerUrl);
  if (endpoint.hostname === '0.0.0.0' || endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== '9231') throw new Error('Inspector must use the expected loopback endpoint.');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out.')); }, 10000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Inspector connection failed.')); };
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  socket.onclose = () => rejectPending(new Error('Main-process inspector disconnected.'));
  socket.onerror = () => rejectPending(new Error('Main-process inspector connection failed.'));

  version = await main(`(() => {
    const electron = process.mainModule.require('electron');
    const fs = process.mainModule.require('node:fs');
    return { platform: process.platform, arch: process.arch, electron: process.versions.electron,
      pid: process.pid, profile: electron.app.getPath('userData'),
      app: electron.app.getName(), appVersion: electron.app.getVersion(),
      hidden: electron.BrowserWindow.getAllWindows().every(window => !window.isVisible()),
      container: process.platform === 'linux' && (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) };
  })()`);
  check('supported desktop verification platform', ['linux', 'win32'].includes(version.platform), version.platform);
  if (version.platform === 'win32') {
    check('inspector belongs to the launched Windows process', String(version.pid) === process.env.SJ_PAINT_TEST_PID &&
      version.profile === process.env.SJ_PAINT_TEST_PROFILE);
    check('Windows test instance stays hidden', version.hidden, version.hidden);
  }
  delete version.pid;
  delete version.profile;

  browser = await chromium.connectOverCDP('http://127.0.0.1:9229');
  const pages = browser.contexts().flatMap(context => context.pages());
  check('exactly one dedicated renderer', pages.length === 1, pages.length);
  const page = pages[0];
  if (version.platform === 'win32') {
    const token = randomUUID();
    const assign = `globalThis.__sjPaintTestIdentity = ${JSON.stringify(token)}`;
    await main(`process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(assign)})`);
    check('renderer belongs to the verified app', await page.evaluate(() => {
      const token = globalThis.__sjPaintTestIdentity;
      delete globalThis.__sjPaintTestIdentity;
      return token;
    }) === token);
  }
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#overlay');
  check('packaged desktop renderer loaded', await page.title() === 'Untitled - Stack Junkie Paint', await page.title());
  check('isolated preload bridge', await page.evaluate(() => !!window.paintDesktop && typeof require === 'undefined' && typeof process === 'undefined'));

  await main(`(() => {
    if (globalThis.__sjPaintVerification) throw new Error('Another verification session owns the main-process fixtures.');
    const electron = process.mainModule.require('electron');
    const fs = process.mainModule.require('node:fs');
    const path = process.mainModule.require('node:path');
    const os = process.mainModule.require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-paint-verification-'));
    const original = { save: electron.dialog.showSaveDialog, open: electron.dialog.showOpenDialog, confirm: electron.dialog.showMessageBox };
    const q = { fs, path, directory, electron, original, file: path.join(directory, 'verification.sjpaint') };
    globalThis.__sjPaintVerification = q;
    electron.dialog.showSaveDialog = async (_window, options) => {
      q.lastSaveOptions = options;
      return { canceled: false, filePath: q.file };
    };
    electron.dialog.showOpenDialog = async (_window, options) => {
      q.lastOpenOptions = options;
      return { canceled: false, filePaths: [q.file] };
    };
    electron.dialog.showMessageBox = async () => ({ response: 1 });
    return true;
  })()`);
  fixturesOwned = true;
  await verifyInteractions(page, check);
  await verifyPendingShapesDesktop(page, check);
  await verifySelectionDesktop(page, check);
  const command = async (menu, action) => {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await page.locator(`[data-command="${action}"]`).click();
  };
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value, expected, { polling: 100 });
  const waitTitle = prefix => page.waitForFunction(value => document.querySelector('#title').textContent.startsWith(value), prefix, { polling: 100 });
  const saveProject = async () => {
    await command('File', 'save-project');
    await waitForFile();
    await page.waitForFunction(() => !document.title.includes('•'), null, { polling: 100 });
    return readProject();
  };

  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.move(box.x + 70, box.y + 90);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 180, { steps: 20 });
  await page.mouse.up();
  await page.waitForFunction(() => document.title.includes('•'), null, { polling: 100 });
  const painted = await pixels();
  await page.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click();
  await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, painted, { polling: 100 });
  check('desktop undo changes pixels', painted !== await pixels());
  await page.getByRole('button', { name: 'Redo (Ctrl+Y)', exact: true }).click();
  await waitPixels(painted);
  check('desktop redo restores pixels', painted === await pixels());
  await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const textBox = await page.locator('#overlay').boundingBox();
  await page.mouse.click(textBox.x + 70, textBox.y + 210);
  await page.getByRole('textbox', { name: 'Text on canvas' }).fill('Stack Junkie Paint');
  await page.getByRole('button', { name: 'Apply text', exact: true }).click();

  await fixture('verification.sjpaint', 'previous project fixture');
  const project = await saveProject();
  check('native IPC saves new layered project format', project.format === 'sj-paint' && project.version === 1 && project.layers.length === 2,
    { format: project.format, version: project.version, layers: project.layers.length });
  const saveOptions = await main('__sjPaintVerification.lastSaveOptions');
  check('native project save advertises .sjpaint', /\.sjpaint$/i.test(saveOptions.defaultPath) &&
    saveOptions.filters.some(filter => filter.extensions.includes('sjpaint')), saveOptions);
  const beforeReload = await pixels();
  await command('File', 'new');
  await command('File', 'open-project');
  await waitTitle('verification');
  await waitPixels(beforeReload);
  check('native project reopen restores pixels', beforeReload === await pixels());

  await fixture('legacy.linuxpaint', JSON.stringify({ ...project, format: 'paint-linux' }));
  await command('File', 'new');
  await command('File', 'open-project');
  await waitTitle('legacy');
  await waitPixels(beforeReload);
  check('legacy .linuxpaint project restores pixels', beforeReload === await pixels());
  const openExtensions = await main('__sjPaintVerification.lastOpenOptions.filters.flatMap(filter => filter.extensions)');
  check('native project picker accepts new and legacy extensions', ['sjpaint', 'linuxpaint'].every(extension => openExtensions.includes(extension)), openExtensions);
  await fixture('migrated.sjpaint');
  const migrated = await saveProject();
  check('legacy project saves as sj-paint without losing layers', migrated.format === 'sj-paint' && migrated.version === 1 &&
    JSON.stringify(migrated.layers) === JSON.stringify(project.layers) && migrated.background === project.background &&
    migrated.width === project.width && migrated.height === project.height && migrated.activeLayerId === project.activeLayerId);
  await command('File', 'new');
  await command('File', 'open-project');
  await waitTitle('migrated');
  await waitPixels(beforeReload);
  check('migrated project reopens with original pixels', beforeReload === await pixels());

  for (const format of ['png', 'jpeg', 'bmp', 'webp', 'gif', 'tiff']) {
    await fixture(`verification.${format}`, 'previous image fixture');
    await command('File', 'save-as');
    await page.locator('select[name="format"]').selectOption(format);
    await page.locator('#dialog button[type="submit"]').click();
    const size = await waitForFile();
    check(`native ${format} export`, size > 50, size);
  }
  await page.screenshot({ path: fileURLToPath(new URL(`stack-junkie-paint-${version.platform}-runtime.png`, output)) });

  const clipboardEnabled = process.env.SJ_PAINT_TEST_CLIPBOARD === '1' ||
    (version.platform === 'linux' && version.container && process.env.SJ_PAINT_TEST_CLIPBOARD !== '0');
  if (clipboardEnabled) {
    await command('Edit', 'copy-all');
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Copied visible layers.', null, { polling: 100 });
    await command('File', 'new');
    await command('Edit', 'paste');
    await page.waitForFunction(() => document.querySelector('#selection-size').textContent.length > 0, null, { polling: 100 });
    await waitPixels(beforeReload);
    check('desktop clipboard copies visible layers and pastes image', beforeReload === await pixels());
  } else {
    checks.push({ name: 'desktop clipboard copies visible layers and pastes image', skipped: true,
      reason: 'Clipboard is untouched unless the target is an isolated Linux container or SJ_PAINT_TEST_CLIPBOARD=1.' });
  }
  await fixture('verification.png');
  await command('File', 'open');
  await waitTitle('verification');
  await waitPixels(beforeReload);
  check('native PNG reopen restores exported pixels', beforeReload === await pixels());
  check('no renderer errors', errors.length === 0, errors);
  if (version.platform === 'win32') {
    check('Windows window remained hidden', await main('__sjPaintVerification.electron.BrowserWindow.getAllWindows().every(window => !window.isVisible())'));
  }
} catch (error) {
  checks.push({ name: 'failure', ok: false, detail: error.stack });
  process.exitCode = 1;
} finally {
  if (fixturesOwned) {
    try {
      await main(`(() => {
        const q = globalThis.__sjPaintVerification;
        q.electron.dialog.showSaveDialog = q.original.save;
        q.electron.dialog.showOpenDialog = q.original.open;
        q.electron.dialog.showMessageBox = q.original.confirm;
        const directory = q.path.resolve(q.directory);
        const temporaryRoot = q.path.resolve(process.mainModule.require('node:os').tmpdir());
        if (q.path.dirname(directory) !== temporaryRoot || !q.path.basename(directory).startsWith('sj-paint-verification-')) {
          throw new Error('Refusing to remove an unexpected fixture directory: ' + directory);
        }
        q.fs.rmSync(directory, { recursive: true });
        delete globalThis.__sjPaintVerification;
        return true;
      })()`);
      checks.push({ name: 'temporary fixtures removed and native dialogs restored', ok: true });
    } catch (error) {
      checks.push({ name: 'fixture cleanup failed', ok: false, detail: error.message });
      process.exitCode = 1;
    }
  }
  const report = { timestamp: new Date().toISOString(), version,
    environment: 'Already running dedicated desktop target; Windows requires hidden windows. No app launched by this harness.',
    dialogBoundary: 'Native chooser responses controlled through the main-process inspector; real preload IPC, filesystem, encoding and decoding used.',
    checks, errors };
  try {
    await fs.writeFile(new URL('desktop-verification.json', output), JSON.stringify(report, null, 2));
    if (version) await fs.writeFile(new URL(`${version.platform}-verification.json`, output), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ version, passed: checks.filter(item => item.ok === true).length,
      skipped: checks.filter(item => item.skipped), failed: checks.filter(item => item.ok === false), errors }));
  } finally {
    // For a CDP-attached browser, close() disconnects the transport; it does not
    // terminate the already running Electron instance.
    try { await browser?.close(); } finally { socket?.close(); }
  }
}
