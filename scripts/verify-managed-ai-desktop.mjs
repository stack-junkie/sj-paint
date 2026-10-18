import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { verifyLocalAiDesktop } from './verify-local-ai-desktop.mjs';
import { verifyObjectSelectionDesktop } from './verify-object-selection-desktop.mjs';
import { verifyObjectSelectionPhoto } from './verify-object-selection-photo.mjs';

// Real packaged IPC and workers throughout. Only the native Open response is
// controlled by the caller's existing owned fixture harness. No AI replies,
// model paths, clipboard, document internals or installed assets are modified.
export async function verifyManagedAiDesktop(page, check, main, photoFixture, { outputDirectory, capture } = {}) {
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) throw new Error('Managed AI requires an absolute fresh retained photo evidence directory.');
  await stat(outputDirectory).then(() => { throw new Error('Photo evidence directory already exists.'); }, error => { if (error.code !== 'ENOENT') throw error; });
  const info = await stat(photoFixture);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Photo fixture must be an existing image below 64 MiB.');
  const bytes = await readFile(photoFixture), digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5') throw new Error('Managed photo refinement requires the retained NASA astronaut fixture matching its fixed prompt coordinates.');
  const status = () => page.evaluate(() => window.paintDesktop.localAiStatus());
  const initial = await status();
  check('managed profile resolves installed full U2-Net and EfficientSAM without setup', initial.ok &&
    initial.value.model.name === 'u2net' && initial.value.setup?.features?.u2net?.installed &&
    initial.value.setup?.features?.['efficientsam-ti']?.installed &&
    initial.value.features?.['efficientsam-ti']?.configured && !initial.value.settingUp && !initial.value.closing, initial);
  const environment = await main(`Object.keys(process.env).filter(key => ['SJ_PAINT_PYTHON','SJ_PAINT_U2NETP_MODEL','SJ_PAINT_EFFICIENTSAM_ENCODER','SJ_PAINT_EFFICIENTSAM_DECODER','SJ_PAINT_GENERATIVE_PYTHON','SJ_PAINT_SDXL_MODEL'].includes(key.toUpperCase()))`);
  check('managed packaged process has no runtime or model environment overrides', environment.length === 0, environment);
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  const panel = page.getByRole('dialog', { name: 'Remove background', exact: true });
  let observingSelection = false;
  try {
    await verifyLocalAiDesktop(page, check, { backgroundModel: 'u2net' });
    await verifyObjectSelectionDesktop(page, check);
    await main(`__sjPaintVerification.file = ${JSON.stringify(photoFixture)}`);
    await key('Control+o');
    await page.waitForFunction(name => document.title.includes(name.replace(/\.[^.]+$/, '')), basename(photoFixture));
    const source = await pixels();
    check('photo opens through native preload and retains a clean saved history',
      await page.locator('[data-action="undo"]').isDisabled(), { path: photoFixture, bytes: bytes.length, sha256: digest });
    const inference = await page.evaluate(async () => {
      const canvas = document.querySelector('#canvas'), blob = await new Promise(resolve => canvas.toBlob(resolve));
      const result = await window.paintDesktop.localAiRun({ id: crypto.randomUUID(), width: canvas.width, height: canvas.height,
        png: new Uint8Array(await blob.arrayBuffer()) });
      if (!result.ok) return result;
      return { ok: true, metadata: result.value.metadata, width: result.value.width, height: result.value.height };
    });
    check('photo preload operation executes full U2-Net saliency on CPU', inference.ok &&
      inference.metadata?.modelExecuted === true && inference.metadata?.matte?.method === 'model-saliency' &&
      inference.metadata?.modelSha256 === initial.value.model.sha256 && inference.metadata?.provider === 'CPUExecutionProvider', inference);
    check('photo inference alone leaves artwork and history unchanged', await pixels() === source && await page.locator('[data-action="undo"]').isDisabled());
    await page.getByRole('button', { name: 'Remove background', exact: true }).click(); await panel.waitFor();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('.background-removal-dialog');
      return !dialog || !dialog.querySelector('[type="submit"]').disabled;
    }, null, { timeout: 120_000 });
    const preview = await panel.locator('canvas').evaluate(canvas => canvas.toDataURL());
    check('real public photo preview changes the mask without committing artwork', preview !== source && await pixels() === source && await page.locator('[data-action="undo"]').isDisabled());
    await panel.getByRole('button', { name: 'Apply', exact: true }).click(); await panel.waitFor({ state: 'detached' }); await frame();
    const applied = await pixels();
    check('public photo Apply exactly commits the displayed preview', applied === preview);
    await key('Control+z');
    check('one photo Undo restores exact source and saved history', await pixels() === source && await page.locator('[data-action="undo"]').isDisabled());
    await key('Control+y'); check('photo Redo restores exact accepted result', await pixels() === applied);
    await key('Control+z');
    // Observe the unchanged production IPC handler. Keep only the latest reply;
    // candidate switching must not cause another request or alter this receipt.
    await main(`(() => {
      const q=__sjPaintVerification, channel='paint:local-ai-select-object', original=q.electron.ipcMain._invokeHandlers.get(channel);
      if(!original || globalThis.__sjSelectionObservation)throw new Error('Selection observer requires exclusive ownership.');
      const state={original,channel,last:null};
      state.handler=async(event,request)=>{
        const response=await original(event,request);
        state.last={id:request.id,request,response};return response;
      };
      q.electron.ipcMain.removeHandler(channel);q.electron.ipcMain.handle(channel,state.handler);
      globalThis.__sjSelectionObservation=state;
    })()`); observingSelection = true;
    await verifyObjectSelectionPhoto(page, check, {
      outputDirectory, capture,
      openPhoto: async () => {
        await key('Control+n');
        await main(`__sjPaintVerification.file = ${JSON.stringify(photoFixture)}`);
        await key('Control+o');
        await page.waitForFunction(name => document.title.includes(name.replace(/\.[^.]+$/, '')), basename(photoFixture));
      },
      readCandidate: async () => {
        const observed = await main(`(() => {
          const entry=globalThis.__sjSelectionObservation.last;
          if(!entry?.response.ok)throw new Error('Selection did not return a successful production reply.');
          const value=entry.response.value;
          return {id:entry.id,request:entry.request,scores:value.scores,selectedCandidate:value.selectedCandidate,
            metadata:value.metadata,candidates:value.candidates.map(mask=>Buffer.from(mask).toString('base64'))};
        })()`);
        return { ...observed, candidates: observed.candidates.map(value => Buffer.from(value, 'base64')) };
      },
    });
    const packagedSource = await main(`(() => {
      const q=__sjPaintVerification, crypto=process.mainModule.require('node:crypto'), root=q.path.dirname(q.path.dirname(process.mainModule.filename));
      const names=['electron/main.cjs','electron/local-ai.cjs','electron/local-ai-worker.py','electron/ai-controller.cjs','electron/ai-assets.json'];
      for(const name of q.fs.readdirSync(q.path.join(root,'dist/assets')))if(name.endsWith('.js'))names.push('dist/assets/'+name);
      return names.map(name=>({name,sha256:crypto.createHash('sha256').update(q.fs.readFileSync(q.path.join(root,name))).digest('hex')}));
    })()`);
    await writeFile(join(outputDirectory, 'packaged-context.json'), JSON.stringify({
      boundary: 'Public UI through unchanged packaged preload/IPC and real managed CPU workers; controlled native Open response; no host clipboard.',
      photo: { path: photoFixture, sha256: digest, bytes: bytes.length }, initial, source: packagedSource,
    }, null, 2), { flag: 'wx' });
    await key('Control+n');
  } finally {
    let observerCleanupError;
    if (observingSelection) await main(`(() => {
      const q=__sjPaintVerification,state=globalThis.__sjSelectionObservation;
      if(!state || q.electron.ipcMain._invokeHandlers.get(state.channel)!==state.handler)throw new Error('Selection observer ownership changed; refusing to overwrite another handler.');
      q.electron.ipcMain.removeHandler(state.channel);q.electron.ipcMain.handle(state.channel,state.original);delete globalThis.__sjSelectionObservation;
    })()`).catch(error => { observerCleanupError = error; });
    if (await panel.count()) {
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await panel.waitFor({ state: 'detached', timeout: 120_000 });
    }
    const released = await page.evaluate(() => window.paintDesktop.localAiRelease());
    const final = await status();
    check('managed AI check releases all operation and worker ownership', released.ok && final.ok &&
      !final.value.active && !final.value.retainedSelection && !final.value.generationSession &&
      !final.value.ownsProcess && !final.value.cleanupBlocked && !final.value.setup?.ownsProcess, { released, final });
    check('read-only photo fixture bytes remain unchanged', createHash('sha256').update(await readFile(photoFixture)).digest('hex') === digest);
    if (observerCleanupError) throw observerCleanupError;
  }
}
