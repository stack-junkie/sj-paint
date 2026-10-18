import { chromium } from 'playwright-core';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { createVerificationResults } from './verification-results.mjs';
import { verifyManagedAiDesktop } from './verify-managed-ai-desktop.mjs';
import { verifyManagedGenerationDesktop } from './verify-managed-generation-desktop.mjs';
import { verifyAiReleaseBoundaryDesktop } from './verify-ai-release-boundary-desktop.mjs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const { checks, check, summary } = createVerificationResults();
const pending = new Map();
let socket, browser, capacity, sequence = 0;
const mainPort = Number(process.env.SJ_PAINT_MAIN_PORT), rendererPort = Number(process.env.SJ_PAINT_RENDERER_PORT);
const filename = process.env.SJ_PAINT_TEST_FILE;
const workflow = process.env.SJ_PAINT_TEST_WORKFLOW || 'editor';
const errors = [];
async function discover(port) {
  const deadline = Date.now() + 30000;
  let error;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch (failure) { error = failure; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Installed app inspector ${port} did not become ready`, { cause: error });
}
async function main(expression) {
  const id = ++sequence;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Installed app inspector timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
try {
  check('owned Linux workflow inputs are explicit', process.platform === 'linux' && !!filename &&
    ['editor', 'managed-status', 'managed-ai', 'managed-generation'].includes(workflow) &&
    Number.isSafeInteger(mainPort) && mainPort > 0 && Number.isSafeInteger(rendererPort) && rendererPort > 0);
  const targets = await discover(mainPort);
  check('exactly one installed main inspector', targets.length === 1);
  const endpoint = new URL(targets[0].webSocketDebuggerUrl);
  check('main inspector stays on expected loopback address', endpoint.hostname === '127.0.0.1' && Number(endpoint.port) === mainPort);
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Inspector connection timed out')), 10000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Inspector connection failed')); };
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  };
  const identity = await main(`(() => { const e = process.mainModule.require('electron'); return {
    pid: process.pid, executable: process.execPath, noSandbox: e.app.commandLine.hasSwitch('no-sandbox'),
    sandbox: e.BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences().sandbox }; })()`);
  check('GIO workflow owns the installed process with sandbox enabled', String(identity.pid) === process.env.SJ_PAINT_TEST_PID &&
    await realpath(identity.executable) === await realpath(process.env.SJ_PAINT_TEST_EXECUTABLE) && identity.sandbox === true && !identity.noSandbox, identity);
  await discover(rendererPort);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${rendererPort}`);
  const pages = browser.contexts().flatMap(context => context.pages());
  check('one installed drawing window', pages.length === 1);
  const page = pages[0]; page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.locator('#overlay').waitFor();
  await verifyAiReleaseBoundaryDesktop(page, check);
  await main(`(() => { const e = process.mainModule.require('electron'); globalThis.__sjPaintVerification = {
    electron: e, fs: process.mainModule.require('node:fs'), path: process.mainModule.require('node:path'),
    save: e.dialog.showSaveDialog, open: e.dialog.showOpenDialog, file: ${JSON.stringify(filename)} }; e.dialog.showSaveDialog = async () =>
    ({ canceled: false, filePath: __sjPaintVerification.file }); e.dialog.showOpenDialog = async () =>
    ({ canceled: false, filePaths: [__sjPaintVerification.file] }); })()`);
  if (workflow !== 'editor') {
    const profile = await main("process.mainModule.require('electron').app.getPath('userData')");
    check('installed app uses the explicitly preserved managed profile',
      await realpath(profile) === await realpath(process.env.SJ_PAINT_TEST_MANAGED_PROFILE), { profile });
    const state = await page.evaluate(() => window.paintDesktop.localAiStatus());
    check('installed managed profile resolves full U2Net and EfficientSAM with no active worker', state.ok &&
      state.value.model.name === 'u2net' && state.value.setup.features.u2net.installed &&
      state.value.setup.features['efficientsam-ti'].installed && !state.value.ownsProcess && !state.value.active, state);
    if (workflow === 'managed-generation') {
      const samplerPath = process.env.SJ_PAINT_TEST_CAPACITY_SAMPLER || '';
      check('generation resource sampler is an explicit absolute harness module', isAbsolute(samplerPath));
      const sampler = await import(pathToFileURL(samplerPath).href);
      check('generation sampler exposes sampling and owned cleanup',
        ['sampleCapacity', 'closeCapacity', 'pendingCapacityOwners'].every(name => typeof sampler[name] === 'function'));
      capacity = sampler;
      await verifyManagedGenerationDesktop(page, check, main, {
        outputDirectory: process.env.SJ_PAINT_TEST_GENERATION_OUTPUT,
        sampleCapacity: capacity.sampleCapacity,
        photoFixture: process.env.SJ_PAINT_TEST_PHOTO,
        scope: process.env.SJ_PAINT_TEST_GENERATION_SCOPE ?? 'all',
        verifyIsolatedCopy: async () => {
          check('clipboard access remains confined to the owned Linux display', process.env.SJ_PAINT_DISPOSABLE_DISPLAY === '1');
          return main(`(async () => {
            const items = await __sjPaintVerification.electron.clipboard.read();
            const item = items.find(item => item.types.includes('image/png'));
            if (!item) throw new Error('The isolated native clipboard contains no PNG image.');
            const png = await item.getType('image/png');
            return 'data:image/png;base64,' + Buffer.from(await png.arrayBuffer()).toString('base64');
          })()`);
        },
      });
    } else if (workflow === 'managed-ai') await verifyManagedAiDesktop(page, check, main, process.env.SJ_PAINT_TEST_PHOTO, {
      outputDirectory: process.env.SJ_PAINT_TEST_AI_OUTPUT,
      capture: options => page.screenshot(options),
    });
    else {
      const plan = await page.evaluate(() => window.paintDesktop.localAiSetupPlan({ features: ['u2net', 'efficientsam-ti'] }));
      check('installed setup plan reuses ready ONNX assets without downloading or reinstalling', plan.ok &&
        plan.value.estimatedDownloadBytes === 0 && plan.value.capacity.runtimeBytes === 0 && plan.value.capacity.modelBytes === 0, plan);
    }
  } else {
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const blank = await pixels();
  await page.locator('[data-tool="pencil"]').click();
  const box = await page.locator('#overlay').boundingBox();
  await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 75, box.y + 45, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(previous => document.querySelector('#canvas').toDataURL() !== previous, blank);
  const drawing = await pixels();
  await page.locator('#overlay').focus(); await page.keyboard.press('Control+Shift+s');
  await page.locator('#dialog [name="format"]').selectOption('sjpaint');
  await page.locator('#dialog button[type="submit"]').click();
  await page.waitForFunction(() => document.title.startsWith('drawing - ') && !document.title.includes('•'));
  const saved = JSON.parse(await readFile(filename, 'utf8'));
  check('installed app writes real editable project bytes', saved.format === 'sj-paint' && saved.layers.length === 1);
  await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
  await page.waitForFunction(() => document.title.startsWith('Untitled - '));
  await page.keyboard.press('Control+o');
  await page.waitForFunction(() => document.title.startsWith('drawing - '));
  check('installed app reopens saved drawing exactly', await pixels() === drawing);
  }
  check('installed workflow has no renderer errors', errors.length === 0, errors);
  check('installed workflow leaves a clean document before native close', !(await page.title()).includes('•'), await page.title());
  await main(`(() => { const e = process.mainModule.require('electron');
    e.dialog.showSaveDialog = __sjPaintVerification.save; e.dialog.showOpenDialog = __sjPaintVerification.open;
    delete globalThis.__sjPaintVerification; })()`);
  const closed = page.waitForEvent('close', { timeout: 10000 });
  await main("setTimeout(() => process.mainModule.require('electron').BrowserWindow.getAllWindows()[0].close(), 50); true");
  await closed;
  check('clean installed document closes normally', page.isClosed());
} catch (error) {
  checks.push({ name: 'installed workflow failure', ok: false, detail: error.stack }); process.exitCode = 1;
} finally {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Inspector disposed')); }
  pending.clear(); socket?.close();
  try { await browser?.close(); }
  catch (error) {
    process.exitCode = 1;
    checks.push({ name: 'installed inspector transport cleanup', ok: false, detail: error.message });
  }
  if (typeof capacity?.closeCapacity === 'function') {
    const cleanupPath = new URL('../output/linux-installed-capacity-cleanup.json', import.meta.url);
    const cleanup = { startedUtc: new Date().toISOString(), status: 'closing', owners: [] };
    try {
      cleanup.owners = await capacity.closeCapacity();
      cleanup.status = 'confirmed closure';
    } catch (error) {
      process.exitCode = 1;
      checks.push({ name: 'installed generation sampler cleanup deadline', ok: false, detail: error.message });
      const owned = capacity.pendingCapacityOwners();
      cleanup.status = 'cleanup pending'; cleanup.error = error.message;
      cleanup.owners = owned.map(owner => owner.receipt);
      await writeFile(cleanupPath, JSON.stringify(cleanup, null, 2));
      console.error(JSON.stringify(cleanup));
      // A timeout does not relinquish ownership. Retain the failure evidence
      // and wait for actual child closure before the harness can exit.
      await Promise.all(owned.map(owner => owner.waitForClose()));
      cleanup.owners = await capacity.closeCapacity();
      cleanup.status = 'confirmed late closure';
    }
    cleanup.finishedUtc = new Date().toISOString();
    await writeFile(cleanupPath, JSON.stringify(cleanup, null, 2));
  }
  const reportName = workflow === 'editor' ? 'workflow' : workflow;
  await writeFile(new URL(`../output/linux-installed-${reportName}.json`, import.meta.url), JSON.stringify({ checks, errors, workflow,
    limitations: 'Actual installed app launched by GIO using a copy of the installed entry with loopback inspector arguments. Native chooser responses supplied by the harness; real IPC, encoding and filesystem.' }, null, 2));
  console.log(JSON.stringify(summary()));
}
