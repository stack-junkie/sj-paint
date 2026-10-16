// Renderer workflows with a private bridge, never the host filesystem or dialogs.
export async function verifySaveTargets(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 40;
    canvas.getContext('2d').fillRect(5, 5, 5, 5);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const q = window.__saveTargets = { descriptor: Object.getOwnPropertyDescriptor(window, 'paintDesktop'),
      bytes: new Uint8Array(await blob.arrayBuffer()), requests: [], openName: 'opened.png', receipt: { name: 'renamed.png', target: 'saved-png' } };
    const save = async request => { q.requests.push(request); return q.receipt; };
    Object.defineProperty(window, 'paintDesktop', { configurable: true, value: {
      setTitle() {}, confirmDiscard: async () => true,
      openImage: async () => ({ bytes: q.bytes, name: q.openName, target: 'opened-png', targetFormat: 'png' }),
      saveImage: save, savePaint: save, saveProject: save,
    } });
  });
  const shortcut = async keys => { await page.locator('#overlay').focus(); await page.keyboard.press(keys); };
  const saved = async count => {
    await page.waitForFunction(count => __saveTargets.requests.length === count, count);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
    return page.evaluate(() => ({ request: __saveTargets.requests.at(-1), name: paintApp.state.name,
      format: paintApp.state.format, dirty: paintApp.doc.dirty }));
  };
  const saveAs = async (format, name) => {
    await shortcut('Control+Shift+s');
    await page.locator('#dialog [name="name"]').fill(name);
    await page.locator('#dialog [name="format"]').selectOption(format);
    await page.locator('#dialog button[type="submit"]').click();
  };
  try {
    await shortcut('Control+o'); await page.waitForFunction(() => paintApp.state.name === 'opened');
    await shortcut('Control+s'); let result = await saved(1);
    check('Ctrl+S reuses the opened document destination', result.request.target === 'opened-png', result.request);
    check('native Save adopts the selected basename', result.name === 'renamed' && !result.dirty, result);
    await shortcut('Control+s'); result = await saved(2);
    check('next Save uses the successful native receipt destination', result.request.target === 'saved-png', result.request);

    await page.evaluate(() => { __saveTargets.receipt = false; });
    await saveAs('png', 'canceled'); result = await saved(3);
    check('Save As always requests a chooser and cancel keeps the current identity',
      !result.request.target && result.name === 'renamed' && result.format === 'png', result);
    await shortcut('Control+s'); result = await saved(4);
    check('Save after canceled Save As still targets the previous file', result.request.target === 'saved-png', result.request);

    await page.evaluate(() => { __saveTargets.receipt = { name: 'chosen.paint', target: 'saved-paint' }; });
    await saveAs('paint', 'suggested'); result = await saved(5);
    check('Save As format change adopts the chosen project name and target',
      !result.request.target && result.name === 'chosen' && result.format === 'paint', result);
    await shortcut('Control+s'); result = await saved(6);
    check('Ctrl+S preserves the native project destination', result.request.target === 'saved-paint', result.request);

    await shortcut('Control+n'); await page.waitForFunction(() => paintApp.state.name === 'Untitled');
    await page.evaluate(() => { __saveTargets.receipt = { name: 'new.png', target: 'new-png' }; });
    await shortcut('Control+s');
    await page.locator('#dialog button[type="submit"]').click(); result = await saved(7);
    check('New document cannot overwrite the previous document destination', !result.request.target && result.name === 'new', result);
    await page.evaluate(() => { __saveTargets.receipt = { name: 'Untitled.png', target: 'untitled-png' }; });
    await saveAs('png', 'Untitled'); await saved(8);
    await shortcut('Control+s'); result = await saved(9);
    check('a saved file named Untitled has an existing destination', result.request.target === 'untitled-png' && !await page.locator('#dialog').evaluate(d => d.open));
    await page.evaluate(async () => {
      const { exportTiff } = await import('/src/files.js');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
      __saveTargets.bytes = new Uint8Array(await exportTiff(canvas).arrayBuffer());
      __saveTargets.openName = 'disguised.png';
      __saveTargets.receipt = { name: 'corrected.tiff', target: 'corrected-tiff' };
    });
    await shortcut('Control+o'); await page.waitForFunction(() => paintApp.state.name === 'disguised');
    await shortcut('Control+s'); result = await saved(10);
    check('TIFF detected under a PNG filename chooses a compatible destination instead of reusing a PNG grant',
      !result.request.target && result.request.format === 'tiff' && result.name === 'corrected', result);
    await page.evaluate(() => { paintApp.doc.newDocument(240, 160); paintApp.setZoom(1); });
    await page.waitForFunction(() => document.querySelector('#overlay').width === 240);
    await page.locator('[data-tool="text"]').click();
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.click(box.x + 20, box.y + 20);
    await page.locator('.text-editor').fill('Save while typing'); await page.keyboard.press('Control+s');
    result = await saved(11);
    check('Ctrl+S while typing commits and saves the draft instead of invoking browser Save',
      await page.locator('.text-editor').count() === 0 && !result.dirty && result.request.bytes.length > 100);
  } finally {
    if (await page.locator('#dialog').evaluate(d => d.open)) await page.locator('#dialog-cancel').click();
    await page.evaluate(async initial => {
      const q = __saveTargets;
      if (q.descriptor) Object.defineProperty(window, 'paintDesktop', q.descriptor); else delete window.paintDesktop;
      delete window.__saveTargets;
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
    }, initial);
  }
}
