import { readPaint, writePaint } from '../src/paint-format.js';

// Canvas premultiplication can change RGB by one unit at partial alpha. Opaque
// pixels, alpha, layer metadata and the separate background must remain exact.
export function comparePaintProject(actual, expected) {
  const result = { dimensions: actual.width === expected.width && actual.height === expected.height,
    background: JSON.stringify(actual.background) === JSON.stringify(expected.background),
    metadata: actual.layers.length === expected.layers.length, opaqueErrors: 0, alphaErrors: 0,
    partialAlphaErrors: 0, maxPartialRgbDifference: 0 };
  for (let index = 0; index < expected.layers.length; index++) {
    const a = actual.layers[index], b = expected.layers[index];
    if (!a) continue;
    result.metadata &&= a.name === b.name && a.visible === b.visible && a.opacity === b.opacity && a.rgba.length === b.rgba.length;
    for (let p = 0; p < b.rgba.length; p += 4) {
      if (a.rgba[p + 3] !== b.rgba[p + 3]) result.alphaErrors++;
      for (let channel = 0; channel < 3; channel++) {
        const difference = Math.abs(a.rgba[p + channel] - b.rgba[p + channel]);
        if (b.rgba[p + 3] === 255 && difference) result.opaqueErrors++;
        if (b.rgba[p + 3] > 0 && b.rgba[p + 3] < 255) {
          result.maxPartialRgbDifference = Math.max(result.maxPartialRgbDifference, difference);
          if (difference > 1) result.partialAlphaErrors++;
        }
      }
    }
  }
  result.ok = result.dimensions && result.background && result.metadata && !result.opaqueErrors && !result.alphaErrors && !result.partialAlphaErrors;
  return result;
}

export function paintProjectFixture() {
  const width = 64, height = 48, lower = new Uint8Array(width * height * 4), upper = new Uint8Array(lower.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4;
    if (x < 40 && y < 35) lower.set([20, 80, 190, 255], p);
    if (x >= 25 && x < 55 && y >= 15 && y < 40) upper.set([179, 79, 39, 128], p);
    if (x >= 8 && x < 15 && y >= 25 && y < 40) upper.set([255, 0, 0, 255], p);
  }
  return { width, height, background: [18, 52, 86, 128], layers: [
    { name: 'Lower layer', visible: true, opacity: 1, rgba: lower },
    { name: 'Upper snowman \u2603', visible: true, opacity: 1, rgba: upper },
  ] };
}

export function unsupportedPaint(bytes) {
  const result = Buffer.from(bytes), offset = result.indexOf(Buffer.from('defl'));
  if (offset < 0) throw new Error('The generated fixture has no compression property.');
  result.write('zzzz', offset, 'ascii'); return result;
}

async function downloadBytes(download) {
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function verifyPaintProject(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  const expected = paintProjectFixture(), encoded = Buffer.from(await writePaint(expected));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc;
    return { project: JSON.stringify(d.serialize()), revision: d.revision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, name: paintApp.state.name, format: paintApp.state.format };
  });
  const documentData = () => page.evaluate(() => {
    const d = paintApp.doc, swatch = document.createElement('canvas'); swatch.width = swatch.height = 1;
    const c = swatch.getContext('2d'); if (d.background) { c.fillStyle = d.background; c.fillRect(0, 0, 1, 1); }
    return { width: d.width, height: d.height, background: [...c.getImageData(0, 0, 1, 1).data],
      layers: d.layers.map(layer => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity,
        rgba: [...layer.canvas.getContext('2d').getImageData(0, 0, d.width, d.height).data] })) };
  });
  const command = async name => {
    await page.getByRole('button', { name: 'File', exact: true }).click();
    await page.locator(`[data-command="${name}"]`).click();
  };
  const choose = async (name, bytes, route = 'open') => {
    const chosen = page.waitForEvent('filechooser');
    if (route === 'open') { await page.locator('#overlay').focus(); await page.keyboard.press('Control+o'); }
    else await command('open-project');
    const chooser = await chosen;
    check(`browser ${route} picker advertises .paint`, (await chooser.element().getAttribute('accept')).includes('.paint'));
    await chooser.setFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  };
  const waitLoaded = name => page.waitForFunction(stem => paintApp.state.name === stem && !paintApp.doc.dirty,
    name.replace(/\.paint$/, ''), { polling: 100 });
  const openSaveAs = async (name, format = 'paint') => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+Shift+s');
    await page.locator('#dialog [name="name"]').fill(name);
    await page.locator('#dialog [name="format"]').selectOption(format);
  };
  const saveAs = async (name, format = 'paint') => {
    await openSaveAs(name, format); const pending = page.waitForEvent('download');
    await page.locator('#dialog button[type="submit"]').click();
    if (format !== 'paint') { await page.getByRole('heading', { name: 'Save as flattened image?' }).waitFor(); await page.locator('#dialog button[type="submit"]').click(); }
    return pending;
  };
  const errorEvent = () => page.waitForEvent('console', { predicate: event => event.type() === 'error' && /paint|layer|opacity|compress/i.test(event.text()) });
  try {
    await page.evaluate(() => paintApp.doc.markSaved());
    await choose('native-open.paint', encoded); await waitLoaded('native-open.paint');
    let comparison = comparePaintProject(await documentData(), expected);
    check('browser Ctrl+O imports .paint layers, names, background and RGBA (partial RGB tolerance 1)', comparison.ok, comparison);
    const imported = await documentData();
    const exported = await saveAs('native-export');
    comparison = comparePaintProject(await readPaint(await downloadBytes(exported)), imported);
    check('browser Save as .paint preserves editable layers instead of flattening', exported.suggestedFilename() === 'native-export.paint' && comparison.ok, comparison);
    await page.waitForFunction(() => !paintApp.doc.dirty, null, { polling: 100 });
    check('successful .paint save keeps the native format and marks the layered document saved',
      await page.evaluate(() => paintApp.state.format === 'paint' && paintApp.state.name === 'native-export' && !paintApp.doc.dirty));
    await page.locator('[data-tool="pencil"]').click();
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x + 5, bounds.y + 5);
    await page.waitForFunction(() => paintApp.doc.dirty, null, { polling: 100 });
    const savePending = page.waitForEvent('download'); await page.keyboard.press('Control+s'); const saved = await savePending;
    check('Ctrl+S after a native project edit keeps .paint and both layers', saved.suggestedFilename() === 'native-export.paint' &&
      (await readPaint(await downloadBytes(saved))).layers.length === 2);
    await page.waitForFunction(() => !paintApp.doc.dirty, null, { polling: 100 });

    await choose('native-project.paint', encoded, 'open-project'); await waitLoaded('native-project.paint');
    comparison = comparePaintProject(await documentData(), expected);
    check('browser Open project accepts the same native layer data', comparison.ok, comparison);
    const transfer = await page.evaluateHandle(bytes => {
      const value = new DataTransfer(); value.items.add(new File([Uint8Array.from(bytes)], 'native-drop.paint', { type: 'application/octet-stream' })); return value;
    }, [...encoded]);
    try { await page.dispatchEvent('#viewport', 'drop', { dataTransfer: transfer }); }
    finally { await transfer.dispose(); }
    await waitLoaded('native-drop.paint'); comparison = comparePaintProject(await documentData(), expected);
    check('browser dropping .paint imports layers and separate background', comparison.ok, comparison);

    for (const [name, bytes] of [['truncated.paint', encoded.subarray(0, encoded.length - 7)], ['unsupported.paint', unsupportedPaint(encoded)]]) {
      const before = await snapshot(), failed = errorEvent(); await choose(name, bytes); await failed;
      check(`${name} is rejected without replacing the document or history`, JSON.stringify(before) === JSON.stringify(await snapshot()));
    }
    for (const [name, changes] of [['hidden layer', { visible: false }], ['layer opacity', { opacity: 0.5 }]]) {
      await page.evaluate(changes => paintApp.doc.setLayer(paintApp.doc.activeLayerId, changes), changes);
      const before = await snapshot(), downloads = []; const record = value => downloads.push(value); page.on('download', record);
      try {
        await openSaveAs('unsupported-export'); const failed = errorEvent();
        await page.locator('#dialog button[type="submit"]').click(); await failed;
        check(`.paint export rejects ${name} without download or document changes`, downloads.length === 0 &&
          JSON.stringify(before) === JSON.stringify(await snapshot()));
      } finally { page.off('download', record); }
      await page.evaluate(() => { paintApp.doc.setLayer(paintApp.doc.activeLayerId, { visible: true, opacity: 1 }); paintApp.doc.markSaved(); });
    }
    const transparent = paintProjectFixture(); transparent.background = [0, 0, 0, 0];
    await choose('transparent.paint', await writePaint(transparent)); await waitLoaded('transparent.paint');
    comparison = comparePaintProject(await documentData(), transparent);
    check('native .paint import preserves a transparent background', comparison.ok, comparison);
    for (const background of [[180, 80, 40, 0], [180, 80, 40, 128]]) {
      const precise = paintProjectFixture(); precise.background = background;
      const name = `background-${background[3]}`;
      await choose(`${name}.paint`, await writePaint(precise)); await waitLoaded(`${name}.paint`);
      const download = await saveAs(`${name}-export`);
      const decoded = await readPaint(await downloadBytes(download));
      check(`.paint keeps exact separate background RGBA bytes at alpha ${background[3]}`,
        JSON.stringify(decoded.background) === JSON.stringify(background), { expected: background, actual: decoded.background });
    }
    await page.locator('[data-tool="pencil"]').click();
    const pngBounds = await page.locator('#overlay').boundingBox(); await page.mouse.click(pngBounds.x + 5, pngBounds.y + 5);
    await page.waitForFunction(() => paintApp.doc.dirty, null, { polling: 100 });
    const beforePng = await snapshot();
    const pngExport = await saveAs('native-to-png', 'png'), pngBytes = await downloadBytes(pngExport);
    check('Save as PNG after .paint keeps layers and dirty protection while adopting raster format',
      pngExport.suggestedFilename() === 'native-to-png.png' && pngBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      await page.evaluate(() => paintApp.state.format === 'png' && !paintApp.state.project && paintApp.doc.layers.length === 2 && paintApp.doc.dirty) &&
      (await snapshot()).project === beforePng.project);
    const pngSavePending = page.waitForEvent('download');
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+s');
    await page.getByRole('heading', { name: 'Save as flattened image?' }).waitFor(); await page.locator('#dialog button[type="submit"]').click();
    const pngSave = await pngSavePending;
    const pngSaveBytes = await downloadBytes(pngSave);
    check('Ctrl+S after .paint to PNG export stays PNG without flattening the working document',
      pngSave.suggestedFilename() === 'native-to-png.png' && pngSaveBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      await page.evaluate(() => paintApp.doc.layers.length === 2 && paintApp.doc.dirty) && (await snapshot()).project === beforePng.project);
    const sjDownload = page.waitForEvent('download'); await command('save-project'); const sj = await sjDownload;
    const sjData = JSON.parse((await downloadBytes(sj)).toString('utf8'));
    check('explicit Save as project still writes editable .sjpaint', sj.suggestedFilename().endsWith('.sjpaint') && sjData.format === 'sj-paint' && sjData.layers.length === 2);
    await verifyDeferredFileOperations(page, check, encoded);
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async saved => {
      await paintApp.doc.load(saved.project); Object.assign(paintApp.state, saved.state);
      document.querySelector('#layers-panel').hidden = !saved.state.layers; paintApp.setZoom(saved.state.zoom);
    }, initial);
    await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.project.width &&
      document.querySelector('#canvas').height === saved.project.height && document.querySelector('[data-action="undo"]').disabled,
    initial, { polling: 100 });
  }
}

// Private bridge/decoder promises model completion order without any native
// chooser, disk write, or operating-system clipboard interaction.
async function verifyDeferredFileOperations(page, check, encoded) {
  const key = '__sjPaintDeferredFiles';
  await page.evaluate(async ({ key, bytes }) => {
    if (window[key]) throw new Error('Deferred file fixture is already installed.');
    const bitmap = window.createImageBitmap.bind(window);
    const c = document.createElement('canvas'); c.width = 5; c.height = 4;
    c.getContext('2d').fillStyle = '#ff00ff'; c.getContext('2d').fillRect(0, 0, 5, 4);
    const png = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
    const control = { bridgeDescriptor: Object.getOwnPropertyDescriptor(window, 'paintDesktop'),
      bitmapDescriptor: Object.getOwnPropertyDescriptor(window, 'createImageBitmap'),
      toast: { text: document.querySelector('#toast').textContent, hidden: document.querySelector('#toast').hidden },
      jobs: [], mode: 'picker', paint: { bytes: Uint8Array.from(bytes), name: 'late-project.paint' },
      raster: { bytes: new Uint8Array(await png.arrayBuffer()), name: 'late-raster.png' } };
    control.defer = (kind, value) => new Promise(resolve => {
      const job = { kind, value, settled: false, release(result = value) { if (!job.settled) { job.settled = true; resolve(result); } } };
      control.jobs.push(job);
    });
    control.job = kind => control.jobs.find(job => job.kind === kind && !job.settled);
    control.fixture = () => {
      const { doc: d, state } = paintApp; d.newDocument(64, 48);
      d.begin('File ownership fixture'); const c = d.activeLayer.canvas.getContext('2d');
      c.fillStyle = '#0088ff'; c.fillRect(20, 20, 10, 10); d.commit(); d.markSaved();
      Object.assign(state, { name: 'Owned drawing', format: 'png', project: false }); paintApp.setZoom(1);
      document.querySelector('#toast').textContent = ''; document.querySelector('#toast').hidden = true;
    };
    Object.defineProperty(window, 'paintDesktop', { configurable: true, value: {
      setTitle() {}, confirmSaveChanges: async () => 'discard',
      openImage: () => control.mode === 'decode' ? Promise.resolve(control.raster) : control.defer('picker', control.paint),
      savePaint: request => control.defer('save', true),
      saveProject: request => control.defer('save', true),
      saveImage: request => control.defer('save', true),
    } });
    window.createImageBitmap = async (...args) => {
      const image = await bitmap(...args);
      return control.mode === 'decode' ? control.defer('decode', image) : image;
    };
    window[key] = control;
  }, { key, bytes: [...encoded] });
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc;
    return JSON.stringify({ project: d.serialize(), revision: d.revision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, name: paintApp.state.name,
      format: paintApp.state.format, projectMode: paintApp.state.project });
  });
  const fixture = async mode => {
    await page.evaluate(({ key, mode }) => { window[key].mode = mode; window[key].fixture(); }, { key, mode });
    await page.waitForFunction(() => document.querySelector('#canvas').width === 64, null, { polling: 100 });
    await page.locator('[data-tool="pencil"]').click();
  };
  const draw = async () => {
    const bounds = await page.locator('#overlay').boundingBox();
    const zoom = Number(await page.locator('#zoom-presets').inputValue());
    await page.mouse.click(bounds.x + 8 * zoom, bounds.y + 8 * zoom);
    await page.waitForFunction(() => paintApp.doc.dirty, null, { polling: 100 });
  };
  const release = async kind => {
    await page.evaluate(({ key, kind }) => window[key].job(kind).release(), { key, kind });
  };
  try {
    for (const mode of ['picker', 'decode']) {
      await fixture(mode); await page.locator('#overlay').focus(); await page.keyboard.press('Control+o');
      await page.waitForFunction(({ key, mode }) => Boolean(window[key].job(mode)), { key, mode }, { polling: 100 });
      await draw(); const expected = await snapshot(); await release(mode);
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Open canceled'), null, { polling: 100 });
      check(`delayed ${mode} Open cannot replace intervening drawing edits`, await snapshot() === expected);
    }

    await fixture('picker'); await page.locator('#overlay').focus(); await page.keyboard.press('Control+o');
    await page.waitForFunction(key => Boolean(window[key].job('picker')), key, { polling: 100 });
    await page.locator('[data-tool="text"]').click();
    const bounds = await page.locator('#overlay').boundingBox(); await page.mouse.click(bounds.x + 8, bounds.y + 8);
    await page.getByRole('textbox', { name: 'Text on canvas' }).fill('New draft while opening');
    const beforeTextCompletion = await snapshot(); await release('picker');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Open canceled'), null, { polling: 100 });
    check('delayed Open preserves a new uncommitted text draft and its document',
      await snapshot() === beforeTextCompletion && await page.getByRole('textbox', { name: 'Text on canvas' }).inputValue() === 'New draft while opening');
    await page.keyboard.press('Escape');

    await fixture('save'); await draw();
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+Shift+s');
    await page.locator('#dialog [name="name"]').fill('Stale save name');
    await page.locator('#dialog [name="format"]').selectOption('paint');
    await page.locator('#dialog button[type="submit"]').click();
    await page.waitForFunction(key => Boolean(window[key].job('save')), key, { polling: 100 });
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(() => paintApp.state.name === 'Untitled' && paintApp.doc.width === 1152, null, { polling: 100 });
    await page.locator('[data-tool="pencil"]').click(); await draw(); const replacement = await snapshot();
    await release('save');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('late native save completion preserves replacement document name, format, dirty state and pixels', await snapshot() === replacement);
  } finally {
    await page.evaluate(async key => {
      const control = window[key];
      for (const job of control.jobs) if (!job.settled) job.release(job.kind === 'decode' ? job.value : null);
      await new Promise(resolve => setTimeout(resolve, 0));
      if (control.bridgeDescriptor) Object.defineProperty(window, 'paintDesktop', control.bridgeDescriptor); else delete window.paintDesktop;
      Object.defineProperty(window, 'createImageBitmap', control.bitmapDescriptor);
      document.querySelector('#toast').textContent = control.toast.text; document.querySelector('#toast').hidden = control.toast.hidden;
      delete window[key];
    }, key);
  }
}
