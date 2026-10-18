import { writeImageResolution } from '../src/image-metadata.js';
import { readTiff } from '../src/tiff.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Chooser responses are controlled; preload, codecs, atomic writes and returned
// file receipts are real. This does not establish native chooser interaction.
export async function verifyFileInformationDesktop(page, check, { main, waitForFile }) {
  const originalFile = await main('__sjPaintVerification.file');
  const zoom = await page.locator('#zoom-presets').inputValue();
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  const snapshot = () => page.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    fileSize: document.querySelector('#file-size').textContent, undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled }));
  const blank = await snapshot();
  if (!blank.title.startsWith('Untitled -') || !blank.undo || !blank.redo) throw new Error('Desktop file information requires a pristine document.');
  const png = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 96, height: 144 });
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#237ac1'; ctx.fillRect(12, 20, 30, 40);
    return canvas.toDataURL().split(',')[1];
  });
  const bytes = writeImageResolution(Buffer.from(png, 'base64'), 'png', { xDpi: 96, yDpi: 144 });
  const resolution = { xDpi: 3780 * .0254, yDpi: 5669 * .0254 };
  const fixture = (name, contents) => main(`(() => { const q=__sjPaintVerification; q.file=q.path.join(q.directory,${JSON.stringify(name)});
    ${contents ? `q.fs.writeFileSync(q.file,Buffer.from(${JSON.stringify(Buffer.from(contents).toString('base64'))},'base64'));` : ''} return q.file; })()`);
  const read = async () => Buffer.from(await main('__sjPaintVerification.fs.readFileSync(__sjPaintVerification.file).toString("base64")'), 'base64');
  const waitTitle = stem => page.waitForFunction(stem => document.title.startsWith(stem + ' -'), stem);
  const expectedSize = size => `${(size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })}KB`;
  const sizeMatches = async size => (await page.locator('#file-size').textContent()).includes(expectedSize(size));
  const properties = async size => {
    await key('Control+e');
    const info = await page.locator('.image-information').textContent();
    check('packaged Properties displays rounded horizontal DPI', info.includes('96 DPI'), info);
    check('packaged Properties formats actual filesystem byte count', info.includes(expectedSize(size)), { size, info });
    await page.locator('[name="units"][value="inches"]').check();
    const values = await page.locator('#dialog').evaluate(dialog => ({ width: Number(dialog.querySelector('[name="width"]').value), height: Number(dialog.querySelector('[name="height"]').value) }));
    check('packaged physical units use the retained native rounded inch presentation', values.width === 1 && values.height === 1.5, values);
    await page.locator('#dialog-cancel').click(); await frame();
  };
  const saveAs = async name => {
    await key('Control+Shift+s'); await page.locator('#dialog [name="name"]').fill(name);
    await page.locator('#dialog [name="format"]').selectOption('tiff');
    await page.locator('#dialog button[type="submit"]').click();
  };
  try {
    await fixture('desktop-density.png', bytes); await key('Control+o'); await waitTitle('desktop-density');
    check('packaged Open formats the actual encoded PNG byte count', await sizeMatches(bytes.length), bytes.length);
    await properties(bytes.length);
    const source = (await snapshot()).pixels;
    const display = await page.evaluate(() => window.paintDesktop.primaryDisplayMetrics());
    check('packaged display IPC returns positive primary dimensions with its platform provenance',
      Number.isSafeInteger(display.width) && display.width > 0 && Number.isSafeInteger(display.height) && display.height > 0 &&
      ['windows-primary-pixels', 'electron-primary-display'].includes(display.source), display);
    await key('Control+e'); await page.locator('[name="units"][value="pixels"]').check();
    await page.locator('#properties-default').click();
    await page.waitForFunction(() => !document.querySelector('#properties-default').disabled);
    const defaults = await page.locator('#dialog').evaluate(dialog => ({ width: Number(dialog.querySelector('[name="width"]').value), height: Number(dialog.querySelector('[name="height"]').value) }));
    check('packaged Default uses the actual primary display and leaves pixels pending',
      defaults.width === Math.trunc(Math.fround(Math.fround(display.width) * Math.fround(.6))) &&
      defaults.height === Math.trunc(Math.fround(Math.fround(display.height) * Math.fround(.6))) && (await snapshot()).pixels === source, { display, defaults });
    await page.locator('#dialog button[type="submit"]').click(); await frame();
    const resized = await page.locator('#canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
    check('packaged Default applies the displayed dimensions through the document owner', resized.width === defaults.width && resized.height === defaults.height, resized);
    await key('Control+z');
    check('packaged Undo after Default restores exact imported pixels', (await snapshot()).pixels === source);
    await fixture('desktop-density-saved.tiff'); await saveAs('desktop-density-saved'); await waitForFile(); await waitTitle('desktop-density-saved');
    const saved = await read(), tiff = await readTiff(saved);
    check('Save As assigns overwrite confirmation to one platform owner',
      await main('process.platform === "linux" ? __sjPaintVerification.lastSaveOptions.properties.length === 0 : __sjPaintVerification.lastSaveOptions.properties.includes("showOverwriteConfirmation")'));
    check('packaged Save As writes anisotropic TIFF resolution to actual bytes', Math.abs(tiff.resolution.xDpi - resolution.xDpi) < 1e-8 && Math.abs(tiff.resolution.yDpi - resolution.yDpi) < 1e-8, tiff.resolution);
    check('successful native Save replaces file-size receipt with actual TIFF length', await sizeMatches(saved.length), { png: bytes.length, tiff: saved.length });
    await key('Control+n'); await key('Control+o'); await waitTitle('desktop-density-saved');
    check('native TIFF reopen preserves exact original pixels', (await snapshot()).pixels === source);
    await properties(saved.length);
    await fixture('desktop-density-project.sjpaint');
    await page.getByRole('button', { name: 'File', exact: true }).click(); await page.locator('[data-command="save-project"]').click();
    await waitForFile(); await waitTitle('desktop-density-project');
    const projectBytes = await read(), project = JSON.parse(projectBytes.toString());
    // TIFF rational decoding is now the document's density owner. JSON must
    // preserve those exact doubles, not the prior PNG multiplication's residue.
    check('native project stores the exact reopened TIFF resolution', JSON.stringify(project.resolution) === JSON.stringify(tiff.resolution), { actual: project.resolution, expected: tiff.resolution });
    check('native project size label formats actual serialized UTF-8 bytes', await sizeMatches(projectBytes.length), projectBytes.length);
    await key('Control+n'); await key('Control+o'); await waitTitle('desktop-density-project'); await properties(projectBytes.length);
    const before = await snapshot();
    await main(`(() => { const q=__sjPaintVerification; q.metadataSave=q.electron.dialog.showSaveDialog;
      q.electron.dialog.showSaveDialog=async()=>({canceled:true}); })()`);
    await saveAs('canceled-density'); await frame();
    check('native chooser cancellation preserves exact pixels, identity, history and size receipt', JSON.stringify(await snapshot()) === JSON.stringify(before));
    await main('(()=>{ const q=__sjPaintVerification; q.electron.dialog.showSaveDialog=q.metadataSave; delete q.metadataSave; })()');
    await fixture('unwritable-density.tiff'); await main('__sjPaintVerification.fs.mkdirSync(__sjPaintVerification.file)');
    await saveAs('unwritable-density');
    await page.locator('#toast').filter({ hasText: /EISDIR|EPERM|EACCES|directory|denied|operation not permitted/i }).waitFor();
    check('real atomic-write failure preserves pixels, identity, history and saved size receipt', JSON.stringify(await snapshot()) === JSON.stringify(before));
    const intact = await main(`__sjPaintVerification.fs.readFileSync(__sjPaintVerification.path.join(__sjPaintVerification.directory,'desktop-density-project.sjpaint')).toString('base64')`);
    check('failed Save As leaves the prior saved project bytes intact', Buffer.from(intact, 'base64').equals(projectBytes));
  } finally {
    // Retain the original saved bytes and the deliberate directory destination
    // as evidence before the caller removes its owned temporary fixture root.
    const retained = await main(`(() => { const q=__sjPaintVerification; return ['desktop-density.png','desktop-density-saved.tiff','desktop-density-project.sjpaint','unwritable-density.tiff'].flatMap(name=>{
      const filename=q.path.join(q.directory,name); if(!q.fs.existsSync(filename))return[];
      return [{name,directory:q.fs.statSync(filename).isDirectory(),bytes:q.fs.statSync(filename).isDirectory()?null:q.fs.readFileSync(filename).toString('base64')}]; }); })()`);
    const evidence = await mkdtemp(fileURLToPath(new URL('../output/desktop-file-fixtures-', import.meta.url)));
    const manifest = [];
    for (const item of retained) {
      if (item.directory) { await mkdir(join(evidence, item.name)); manifest.push({ name: item.name, directory: true }); }
      else {
        const contents = Buffer.from(item.bytes, 'base64');
        await writeFile(join(evidence, item.name), contents, { flag: 'wx' });
        manifest.push({ name: item.name, bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
      }
    }
    await writeFile(join(evidence, 'manifest.json'), JSON.stringify({ timestamp: new Date().toISOString(),
      boundary: 'Owned native-filesystem fixtures; chooser responses were injected. The directory named unwritable-density.tiff deliberately causes atomic replacement failure.', files: manifest }, null, 2), { flag: 'wx' });
    check('desktop metadata save-failure fixtures retained before temporary cleanup', true, { evidence });
    await main(`(() => { const q=__sjPaintVerification; if(q.metadataSave){q.electron.dialog.showSaveDialog=q.metadataSave;delete q.metadataSave;} q.file=${JSON.stringify(originalFile)}; })()`);
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await key('Control+n'); await page.locator('#zoom-presets').selectOption(zoom); await frame();
  }
  const restored = await snapshot();
  check('desktop metadata fixture restores a clean blank document', restored.pixels === blank.pixels && restored.undo && restored.redo && restored.fileSize === blank.fileSize);
}
