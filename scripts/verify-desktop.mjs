import { verifyEraserDesktop } from './verify-eraser-desktop.mjs';
import { verifyKeyboardDesktop } from './verify-keyboard-desktop.mjs';
import { verifyResourceShortcutsDesktop } from './verify-resource-shortcuts-desktop.mjs';
import { verifyDraftAffordancesDesktop } from './verify-draft-affordances-desktop.mjs';
import { verifyTextDesktop } from './verify-text-desktop.mjs';
import { verifyTiffDesktop } from './verify-tiff-desktop.mjs';
import { verifyDrawingAdmissionDesktop } from './verify-drawing-admission-desktop.mjs';
import { verifyHeldLayerPreviewDesktop } from './verify-held-layer-preview.mjs';
import { chromium } from 'playwright-core';
import { verifyInteractions } from './verify-interactions.mjs';
import { verifyPendingShapesDesktop } from './verify-pending-shapes-desktop.mjs';
import { verifySelectionDesktop } from './verify-selection-desktop.mjs';
import { verifySelectionRotationDesktop } from './verify-selection-rotation-desktop.mjs';
import { verifyPaintProjectDesktop } from './verify-paint-project-desktop.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Attach only to an already running, dedicated test instance. This harness
// neither launches an app nor interacts with the operating system desktop.
const output = new URL('../output/', import.meta.url);
const checks = [], errors = [], pending = new Map();
let socket, browser, version, fixtureLocation, targetWindowClosed = false, fixturesOwned = false, sequence = 0;
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

async function waitForFile({ differentFrom } = {}) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const size = await main('(() => { const q = __sjPaintVerification; return q.fs.existsSync(q.file) ? q.fs.statSync(q.file).size : 0; })()');
    if (size > 50 && (differentFrom === undefined || await main('__sjPaintVerification.fs.readFileSync(__sjPaintVerification.file).toString("base64")') !== Buffer.from(differentFrom).toString('base64'))) return size;
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
  // Electron owns beforeunload through will-prevent-unload. Prevent Playwright
  // from auto-accepting the corresponding CDP event: Chromium has no browser
  // dialog to accept here, and that races Electron's native close decision.
  page.on('dialog', dialog => {
    if (dialog.type() !== 'beforeunload') errors.push(`Unexpected browser dialog: ${dialog.type()}`);
  });
  page.on('close', () => { targetWindowClosed = true; });
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

  const fixtureOwner = randomUUID();
  fixtureLocation = await main(`(() => {
    if (globalThis.__sjPaintVerification) throw new Error('Another verification session owns the main-process fixtures.');
    const electron = process.mainModule.require('electron');
    const fs = process.mainModule.require('node:fs');
    const path = process.mainModule.require('node:path');
    const os = process.mainModule.require('node:os');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-paint-verification-'));
    const original = { save: electron.dialog.showSaveDialog, open: electron.dialog.showOpenDialog, confirm: electron.dialog.showMessageBox };
    const owner = ${JSON.stringify(fixtureOwner)};
    fs.writeFileSync(path.join(directory, '.verification-owner'), owner, { flag: 'wx' });
    const q = { fs, path, directory, owner, electron, original, confirmResponse: 1, confirmCalls: 0, saveDialogs: 0, file: path.join(directory, 'verification.sjpaint') };
    globalThis.__sjPaintVerification = q;
    electron.dialog.showSaveDialog = async (_window, options) => {
      q.saveDialogs++;
      q.lastSaveOptions = options;
      return { canceled: false, filePath: q.file };
    };
    electron.dialog.showOpenDialog = async (_window, options) => {
      q.lastOpenOptions = options;
      return { canceled: false, filePaths: [q.file] };
    };
    electron.dialog.showMessageBox = async (_window, options) => {
      q.confirmCalls++; q.lastConfirmOptions = options;
      return { response: q.confirmResponse };
    };
    return { directory, temporaryRoot: os.tmpdir(), owner };
  })()`);
  fixturesOwned = true;
  await verifyInteractions(page, check);
  await verifyPendingShapesDesktop(page, check);
  await verifySelectionDesktop(page, check);
  await verifySelectionRotationDesktop(page, check);
  await verifyPaintProjectDesktop(page, check, { main, waitForFile });
  await verifyEraserDesktop(page, check, { main });
  await verifyTiffDesktop(page, check, { main, waitForFile });
  await verifyKeyboardDesktop(page, check);
  await verifyResourceShortcutsDesktop(page, check);
  await verifyDraftAffordancesDesktop(page, check);
  await verifyTextDesktop(page, check);
  await verifyDrawingAdmissionDesktop(page, check);
  await verifyHeldLayerPreviewDesktop(page, check);
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
    await page.getByRole('heading', { name: 'Save as flattened image?' }).waitFor(); await page.locator('#dialog button[type="submit"]').click();
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

  // Exercise the production BrowserWindow close -> preload notification ->
  // renderer confirmation/save -> beforeunload path. Only dialog responses are
  // substituted; native window closure and saved bytes remain real.
  check('closed-window fixtures are on the verifier filesystem',
    path.resolve(fixtureLocation.temporaryRoot) === path.resolve(tmpdir()) &&
    path.dirname(path.resolve(fixtureLocation.directory)) === path.resolve(tmpdir()) &&
    await fs.readFile(path.join(fixtureLocation.directory, '.verification-owner'), 'utf8') === fixtureOwner);
  await page.getByRole('button', { name: 'Pencil', exact: true }).click();
  await page.getByRole('button', { name: 'Color #ed1c24', exact: true }).click();
  const closeBox = await page.locator('#overlay').boundingBox();
  await page.mouse.move(closeBox.x + 15, closeBox.y + 15);
  await page.mouse.down();
  await page.mouse.move(closeBox.x + 65, closeBox.y + 35, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.title.includes('•'));
  const closePixels = await pixels();
  const closeFile = await main('__sjPaintVerification.file');
  const beforeCloseBytes = await fs.readFile(closeFile);
  const reloadIdentity = randomUUID();
  await page.evaluate(value => { globalThis.__sjPaintReloadIdentity = value; }, reloadIdentity);
  await main(`(() => {
    const q = __sjPaintVerification, owner = q.electron.BrowserWindow.getAllWindows()[0];
    q.confirmResponse = 2; q.confirmCalls = 0; q.reloadVetoSeen = false;
    owner.webContents.once('will-prevent-unload', () => { q.reloadVetoSeen = true; });
    owner.webContents.reload();
    return true;
  })()`);
  let reloadVetoSeen = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await main('__sjPaintVerification.reloadVetoSeen')) { reloadVetoSeen = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check('dirty native reload is vetoed without a close prompt', reloadVetoSeen && !page.isClosed() &&
    await page.evaluate(() => globalThis.__sjPaintReloadIdentity) === reloadIdentity &&
    await pixels() === closePixels && (await page.title()).includes('•') &&
    await main('__sjPaintVerification.confirmCalls') === 0);
  await main(`(() => {
    const q = __sjPaintVerification;
    q.confirmResponse = 2; q.confirmCalls = 0;
    q.electron.BrowserWindow.getAllWindows()[0].close();
    return true;
  })()`);
  let closePromptSeen = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await main('__sjPaintVerification.confirmCalls') > 0) { closePromptSeen = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check('native close asks Save, Don\'t save or Cancel', closePromptSeen &&
    JSON.stringify(await main('__sjPaintVerification.lastConfirmOptions.buttons')) === JSON.stringify(['Save', "Don't save", 'Cancel']));
  check('native close Cancel retains dirty drawing and original file', !page.isClosed() &&
    await pixels() === closePixels && (await page.title()).includes('•') &&
    beforeCloseBytes.equals(await fs.readFile(closeFile)));

  // Leave a real application modal open with an unsubmitted dimension edit.
  // Closing through Save must not submit that form or silently resize pixels.
  await command('File', 'properties');
  await page.getByRole('heading', { name: 'Image properties', exact: true }).waitFor();
  const draftWidth = Number(await page.locator('#dialog input[name="width"]').inputValue()) + 1;
  await page.locator('#dialog input[name="width"]').fill(String(draftWidth));
  check('native close Save starts with an unsubmitted Properties modal',
    await page.locator('#dialog').evaluate(dialog => dialog.open) && await pixels() === closePixels);

  // Keep inspector evaluation independent of shutdown: schedule close after its
  // reply, then await the actual renderer closing rather than a success receipt.
  await main(`(() => {
    const q = __sjPaintVerification; q.confirmResponse = 0;
    return true;
  })()`);
  const closed = page.waitForEvent('close', { timeout: 30000 });
  await main(`(() => {
    const owner = __sjPaintVerification.electron.BrowserWindow.getAllWindows()[0];
    setTimeout(() => owner.close(), 50);
    return true;
  })()`);
  await closed;
  socket.close();
  const closeSavedBytes = await fs.readFile(closeFile);
  check('native close Save writes current pixels before closing without submitting Properties', targetWindowClosed &&
    closeSavedBytes.equals(Buffer.from(closePixels.split(',')[1], 'base64')) && !closeSavedBytes.equals(beforeCloseBytes));
  check('native close workflow has no renderer errors', errors.length === 0, errors);
} catch (error) {
  checks.push({ name: 'failure', ok: false, detail: error.stack });
  try {
    const page = browser?.contexts().flatMap(context => context.pages())[0];
    if (page) {
      const state = await page.evaluate(() => ({
        title: document.title, focus: document.activeElement?.outerHTML,
        canvas: { width: document.querySelector('#canvas')?.width, height: document.querySelector('#canvas')?.height },
        tool: document.querySelector('#tool-label')?.textContent,
        dialog: document.querySelector('#dialog')?.open,
        undoDisabled: document.querySelector('[data-action="undo"]')?.disabled,
        redoDisabled: document.querySelector('[data-action="redo"]')?.disabled,
        textDraft: document.querySelector('.text-editor')?.value,
      }));
      await fs.writeFile(new URL('desktop-failure-state.json', output), JSON.stringify(state, null, 2));
      await page.screenshot({ path: fileURLToPath(new URL('desktop-failure.png', output)) });
    }
  } catch (diagnosticError) { errors.push(`Failure capture: ${diagnosticError.message}`); }
  process.exitCode = 1;
} finally {
  if (fixturesOwned) {
    try {
      if (targetWindowClosed) {
        const directory = path.resolve(fixtureLocation.directory), temporaryRoot = path.resolve(fixtureLocation.temporaryRoot);
        if (temporaryRoot !== path.resolve(tmpdir()) || path.dirname(directory) !== temporaryRoot ||
            !path.basename(directory).startsWith('sj-paint-verification-') ||
            (await fs.lstat(directory)).isSymbolicLink() ||
            await fs.readFile(path.join(directory, '.verification-owner'), 'utf8') !== fixtureLocation.owner) {
          throw new Error('Refusing to remove an unverified closed-app fixture directory: ' + directory);
        }
        await fs.rm(directory, { recursive: true });
        checks.push({ name: 'closed-app owned temporary fixtures removed', ok: true });
      } else {
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
      }
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
