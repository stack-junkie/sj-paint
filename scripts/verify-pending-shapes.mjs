import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Public UI gestures edit the draft. Development state is used only to inspect
// document/history boundaries and establish independent, disposable fixtures.
export async function verifyPendingShapes(page, check) {
  const initial = await page.evaluate(() => ({ width: paintApp.doc.width, height: paintApp.doc.height, state: { ...paintApp.state } }));
  const snapshot = () => page.evaluate(() => ({ png: paintApp.doc.activeLayer.canvas.toDataURL(),
    dirty: paintApp.doc.dirty, revision: paintApp.doc.revision, undo: paintApp.doc._undo.length,
    redo: paintApp.doc._redo.length, layers: paintApp.doc.layers.length }));
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x + x, box.y + y, { steps: 4 });
  };
  const drag = async (x1, y1, x2, y2) => {
    await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up();
  };
  const command = async (menu, action) => {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await page.locator(`[data-command="${action}"]`).click();
  };
  const waitPixel = async (id, x, y, rgba) => {
    await page.waitForFunction(({ id, x, y, rgba }) => {
      const pixel = document.querySelector(id).getContext('2d').getImageData(x, y, 1, 1).data;
      return rgba.every((value, index) => value === null || pixel[index] === value);
    }, { id, x, y, rgba }, { polling: 100 });
  };
  const reset = async () => {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(() => {
      paintApp.doc.newDocument(300, 240);
      Object.assign(paintApp.state, { name: 'Untitled', project: false, format: 'png' });
      paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#canvas').width === 300 && document.querySelector('#canvas').height === 240,
      null, { polling: 100 });
    await page.locator('[data-tool="rectangle"]').click();
    await page.locator('[data-color="#000000"]').click();
    await page.locator('[data-color="#ffffff"]').click({ button: 'right' });
    await page.locator('#outline').selectOption('solid');
    await page.locator('#shape-fill').selectOption('none');
    await page.locator('#size-number').fill('5');
    await page.locator('#size-number').press('Tab');
  };
  const create = async () => {
    await drag(40, 60, 160, 140);
    await page.waitForFunction(() => {
      const pixels = document.querySelector('#overlay').getContext('2d').getImageData(0, 0, 300, 240).data;
      return pixels.some((value, index) => index % 4 === 3 && value);
    }, null, { polling: 100 });
  };
  const isPending = () => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
  const undoTo = async before => {
    await page.locator('#overlay').focus();
    await page.keyboard.press('Control+z');
    await page.waitForFunction(expected => paintApp.doc.activeLayer.canvas.toDataURL() === expected, before.png, { polling: 100 });
    const after = await snapshot();
    return after.png === before.png && after.undo === before.undo;
  };

  await reset();
  const blank = await snapshot();
  await create();
  const pending = await snapshot();
  check('rectangle remains editable after pointer release without changing layer pixels or history',
    pending.png === blank.png && pending.revision === blank.revision && !pending.dirty && pending.undo === blank.undo && await isPending());
  await waitPixel('#canvas', 80, 60, [0, 0, 0, 255]);
  await page.locator('[data-color="#ed1c24"]').click();
  await waitPixel('#canvas', 80, 60, [237, 28, 36, 255]);
  check('primary palette changes update the pending outline', (await snapshot()).png === blank.png);
  await page.locator('[data-color="#fff200"]').click({ button: 'right' });
  await page.locator('#shape-fill').selectOption('solid');
  await waitPixel('#canvas', 100, 100, [255, 242, 0, 255]);
  check('secondary palette and fill changes update pending interior pixels', (await snapshot()).png === blank.png);
  await page.locator('#size-number').fill('13');
  await page.locator('#size-number').press('Tab');
  await waitPixel('#canvas', 100, 65, [237, 28, 36, 255]);
  check('line size changes update the pending shape thickness', (await snapshot()).png === blank.png);
  await page.locator('#outline').selectOption('none');
  await waitPixel('#canvas', 100, 65, [255, 242, 0, 255]);
  check('outline changes preserve editable fill without stamping a layer', (await snapshot()).png === blank.png);
  await page.keyboard.press('Escape');
  const canceled = await snapshot();
  check('Escape cancels the complete edited draft without adding history', canceled.png === blank.png &&
    canceled.revision === blank.revision && !canceled.dirty && canceled.undo === blank.undo && !await isPending());

  await reset();
  const transformBefore = await snapshot();
  await page.locator('[data-color="#fff200"]').click({ button: 'right' });
  await page.locator('#shape-fill').selectOption('solid');
  await create();
  await drag(100, 100, 120, 110);
  await waitPixel('#canvas', 80, 100, [255, 242, 0, 255]);
  await waitPixel('#canvas', 40, 100, [255, 255, 255, 255]);
  check('pending shape interior drag moves its preview without stamping pixels', (await snapshot()).png === transformBefore.png);
  await drag(180, 150, 210, 170);
  await waitPixel('#canvas', 200, 160, [255, 242, 0, 255]);
  check('pending southeast handle resizes the preview without stamping pixels', (await snapshot()).png === transformBefore.png);
  // After moving and resizing, the box is (60,70)-(210,170). Its rotation
  // handle is 24 CSS pixels above top center (135,46), centered on (135,120).
  await drag(135, 46, 209, 120);
  await waitPixel('#canvas', 120, 50, [255, 242, 0, 255]);
  await waitPixel('#canvas', 200, 160, [255, 255, 255, 255]);
  check('pending rotation handle rotates the preview without stamping pixels', (await snapshot()).png === transformBefore.png);
  await page.keyboard.press('Enter');
  const afterEnter = await snapshot();
  check('Enter retains the transformed draft without changing layer pixels or history',
    afterEnter.png === transformBefore.png && afterEnter.undo === transformBefore.undo && !afterEnter.dirty && await isPending());
  await page.screenshot({ path: fileURLToPath(new URL('../output/pending-shape-preview.png', import.meta.url)) });
  await page.locator('[data-tool="pencil"]').click();
  const transformed = await snapshot();
  check('tool switching commits the transformed draft as one drawing', transformed.png !== transformBefore.png && transformed.dirty && transformed.undo === transformBefore.undo + 1);
  check('one undo removes the entire moved, resized, and rotated drawing', await undoTo(transformBefore));

  for (const settlement of ['tool switch', 'outside click']) {
    await reset(); const before = await snapshot(); await create();
    if (settlement === 'tool switch') await page.locator('[data-tool="pencil"]').click();
    else { await move(250, 200); await page.mouse.down(); await page.mouse.up(); }
    const committed = await snapshot();
    check(`${settlement} commits the pending drawing once`, committed.png !== before.png && committed.dirty && committed.undo === before.undo + 1);
    check(`${settlement} leaves one undoable drawing`, await undoTo(before));
  }

  await reset(); const beforeLayer = await snapshot(); await create();
  if (!await page.locator('#layers-panel').isVisible()) await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await page.getByRole('button', { name: 'Add layer', exact: true }).click();
  const layerResult = await page.evaluate(() => ({ count: paintApp.doc.layers.length,
    original: paintApp.doc.layers[0].canvas.toDataURL(), active: paintApp.doc.activeLayerId, first: paintApp.doc.layers[0].id }));
  check('adding a layer settles the draft onto its original layer before changing ownership',
    layerResult.count === 2 && layerResult.original !== beforeLayer.png && layerResult.active !== layerResult.first);
  await page.locator('#overlay').focus(); await page.keyboard.press('Control+z');
  check('layer creation remains a separate undo step after draft settlement', await page.evaluate(() => paintApp.doc.layers.length === 1));
  check('the settled original-layer shape has its own undo step', await undoTo(beforeLayer));

  await reset(); await create();
  if (!await page.locator('#layers-panel').isVisible()) await page.getByRole('button', { name: 'Layers', exact: true }).click();
  await move(100, 100); await page.mouse.down(); await move(120, 110);
  // The real mouse still owns the transform. A second input activates the
  // public layer command; only that separate activation is synthetic.
  await page.getByRole('button', { name: 'Add layer', exact: true }).dispatchEvent('click', { button: 0 });
  await page.waitForFunction(() => paintApp.doc.layers.length === 2, null, { polling: 100 });
  const settledWhileHeld = await snapshot();
  await move(150, 130); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#canvas').toDataURL() === paintApp.doc.composite().toDataURL(), null, { polling: 100 });
  const afterLateRelease = await snapshot();
  check('settling a held transform releases ownership and cannot recreate an untracked draft',
    settledWhileHeld.undo === 2 && JSON.stringify(afterLateRelease) === JSON.stringify(settledWhileHeld));

  await reset(); const beforeSave = await snapshot(); await create();
  const downloadPromise = page.waitForEvent('download');
  await command('File', 'save-project');
  const download = await downloadPromise;
  const project = JSON.parse(await readFile(await download.path(), 'utf8'));
  check('saving a layered project settles and exports pending shape pixels',
    project.format === 'sj-paint' && project.layers.length === 1 && project.layers[0].png !== beforeSave.png &&
    (await snapshot()).undo === beforeSave.undo + 1);
  await download.delete();

  // Exercise clipboard and print dispatch without touching the system clipboard
  // or opening a native print window. Their actual platform behavior is covered
  // separately; these checks establish which pixels reach each adapter.
  await page.evaluate(() => {
    const state = { clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'), open: window.open, copied: null, printed: null, printFrame: null };
    window.__sjPendingShapeIo = state;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => {
      const image = await createImageBitmap(await items[0].getType('image/png'));
      try {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0); state.copied = canvas.toDataURL();
      } finally { image.close(); }
    } } });
    window.open = () => {
      // A connected hidden iframe supplies an active document so image.decode()
      // exercises the production print path without opening a browser window.
      const frame = window.document.createElement('iframe'); frame.hidden = true;
      window.document.body.append(frame); state.printFrame = frame;
      const document = frame.contentDocument;
      return { document, opener: null, addEventListener() {}, close() {}, print() { state.printed = document.querySelector('img').src; } };
    };
  });
  try {
    for (const operation of ['copy', 'print']) {
      await reset(); const before = await snapshot(); await create();
      await command(operation === 'copy' ? 'Edit' : 'File', operation);
      await page.waitForFunction(kind => !!window.__sjPendingShapeIo[kind], operation === 'copy' ? 'copied' : 'printed', { polling: 100 });
      const result = await page.evaluate(kind => ({ captured: window.__sjPendingShapeIo[kind],
        expected: paintApp.doc.composite(kind === 'copied' ? { onlyActive: true } : {}).toDataURL(),
        undo: paintApp.doc._undo.length, transaction: !!paintApp.doc._transaction }), operation === 'copy' ? 'copied' : 'printed');
      check(`${operation} settles pending pixels before calling its output adapter`,
        result.captured === result.expected && result.undo === before.undo + 1 && !result.transaction);
    }
  } finally {
    await page.evaluate(() => {
      const state = window.__sjPendingShapeIo;
      if (state.clipboard) Object.defineProperty(navigator, 'clipboard', state.clipboard);
      else delete navigator.clipboard;
      window.open = state.open;
      state.printFrame?.remove();
      delete window.__sjPendingShapeIo;
    });
  }

  await page.keyboard.press('Escape'); await page.mouse.up();
  await page.evaluate(saved => {
    paintApp.doc.newDocument(saved.width, saved.height);
    Object.assign(paintApp.state, saved.state);
    document.querySelector('#layers-panel').hidden = !saved.state.layers;
    paintApp.setZoom(saved.state.zoom);
  }, initial);
  await page.waitForFunction(saved => document.querySelector('#canvas').width === saved.width &&
    document.querySelector('#canvas').height === saved.height && document.querySelector('[data-action="undo"]').disabled,
  initial, { polling: 100 });
}
