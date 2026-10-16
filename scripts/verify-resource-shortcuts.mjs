// Exact key combinations come from decoded native accelerator resources.
// Public keyboard gestures exercise SJ Paint; this does not measure native UI timing.
export async function verifyResourceShortcuts(page, check) {
  const key = '__sjResourceShortcuts';
  const shortcuts = ['Control+h', 'Control+Shift+PageUp', 'Control+Shift+PageDown',
    'Control+Shift+Delete', 'Control+Shift+x', 'Control+1', 'Control+PageUp', 'Control+PageDown'];
  const initial = await page.evaluate(key => {
    if (window[key]) throw new Error('Resource shortcut verifier is already installed.');
    window[key] = { clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard'), writes: 0, reads: 0 };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async () => { window[key].writes++; },
      read: async () => { window[key].reads++; return []; },
    } });
    return { project: paintApp.doc.serialize(), state: { ...paintApp.state },
      controls: Object.fromEntries(['size', 'size-number', 'font', 'font-size', 'text-background'].map(id => {
        const element = document.getElementById(id); return [id, { value: element.value, checked: element.checked }];
      })) };
  }, key);
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const capture = () => page.evaluate(() => {
    const d = paintApp.doc;
    return { project: JSON.stringify(d.serialize()), active: d.activeLayerId,
      layers: d.layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible })),
      width: d.width, height: d.height, zoom: paintApp.state.zoom,
      revision: d.revision, undo: d._undo.length, redo: d._redo.length,
      pixels: d.composite().toDataURL(), selected: Boolean(d.selection), transaction: Boolean(d._transaction) };
  });
  const press = async shortcut => { await page.locator('#overlay').focus(); await page.keyboard.press(shortcut); await frame(); };
  const fixture = async () => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(() => {
      const d = paintApp.doc; d.newDocument(300, 200);
      Object.assign(paintApp.state, { transparentSelection: false, grid: false, rulers: false,
        font: 'Arial', fontSize: 24, bold: false, italic: false, underline: false, strikethrough: false,
        align: 'left', textBackground: false });
      d.setSelectionTransparency(false, '#ffffff');
      d.setLayer(d.activeLayerId, { name: 'Bottom' });
      const middle = d.addLayer('Middle'); d.begin('Middle fixture');
      const ctx = middle.canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(30, 30, 20, 20); d.commit();
      d.addLayer('Top'); d.selectLayer(middle.id); d.markSaved(); paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#overlay').width === 300 &&
      Math.abs(document.querySelector('#overlay').getBoundingClientRect().width - 300) < 0.02);
    await frame(); return capture();
  };
  try {
    const original = await fixture();
    await press('Control+h'); let result = await capture();
    check('Ctrl+H hides only the current layer', result.layers.find(layer => layer.id === original.active)?.visible === false &&
      result.layers.filter(layer => layer.id !== original.active).every(layer => layer.visible) && result.pixels !== original.pixels);
    await press('Control+h'); result = await capture();
    check('Ctrl+H restores the current layer and its unchanged artwork', result.layers.every(layer => layer.visible) && result.pixels === original.pixels);

    await press('Control+Shift+PageUp'); result = await capture();
    check('Ctrl+Shift+PageUp moves the current layer one position up without changing zoom',
      result.layers.at(-1).id === original.active && result.active === original.active && result.zoom === original.zoom);
    await press('Control+Shift+PageDown'); result = await capture();
    check('Ctrl+Shift+PageDown restores the layer order without changing zoom',
      JSON.stringify(result.layers) === JSON.stringify(original.layers) && result.active === original.active && result.zoom === original.zoom);
    const beforeDelete = result;
    await press('Control+Shift+Delete'); result = await capture();
    check('Ctrl+Shift+Delete removes the active layer rather than clearing its pixels',
      result.layers.length === 2 && !result.layers.some(layer => layer.id === original.active));
    await press('Control+z'); result = await capture();
    check('one Undo restores the shortcut-deleted layer, artwork and selection',
      result.project === beforeDelete.project && result.active === beforeDelete.active);

    const beforeZoom = await capture(); await press('Control+PageUp'); const zoomed = await capture();
    check('Ctrl+PageUp increases zoom without changing the document', zoomed.zoom > beforeZoom.zoom &&
      zoomed.project === beforeZoom.project && zoomed.undo === beforeZoom.undo);
    await press('Control+PageDown'); result = await capture();
    check('Ctrl+PageDown reduces zoom without changing the document', result.zoom < zoomed.zoom &&
      result.project === beforeZoom.project && result.undo === beforeZoom.undo);
    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await press('Control+1'); result = await capture();
    const fits = await page.evaluate(() => {
      const canvas = document.querySelector('#canvas').getBoundingClientRect(), viewport = document.querySelector('#viewport');
      return canvas.width <= viewport.clientWidth && canvas.height <= viewport.clientHeight;
    });
    check('Ctrl+1 fits the drawing within the viewport', result.zoom <= 1 && fits && result.project === beforeZoom.project);
    const fitted = result.zoom;
    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await page.locator('#overlay').dispatchEvent('keydown', { key: '1', code: 'Numpad1', location: 3, ctrlKey: true }); await frame();
    check('numeric keypad 1 uses the same Fit binding', (await capture()).zoom === fitted);
    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await page.locator('#overlay').dispatchEvent('keydown', { key: 'End', code: 'Numpad1', location: 3, ctrlKey: true }); await frame();
    check('keypad navigation End is not mistaken for numeric keypad 1', (await capture()).zoom === 2);

    const beforeCrop = await fixture(); await page.locator('[data-tool="select"]').click();
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down();
    await page.mouse.move(bounds.x + 80, bounds.y + 60, { steps: 4 }); await page.mouse.up(); await frame();
    const selected = await capture(); await press('Control+Alt+Shift+x');
    check('extra Alt cannot fall through from Crop to Cut', JSON.stringify(await capture()) === JSON.stringify(selected) &&
      await page.evaluate(key => window[key].writes === 0, key));
    await press('Control+Shift+x'); result = await capture();
    const clipboard = await page.evaluate(key => ({ writes: window[key].writes, reads: window[key].reads }), key);
    const croppedInk = await page.evaluate(() => [...paintApp.doc.activeLayer.canvas.getContext('2d').getImageData(15, 15, 1, 1).data]);
    check('Ctrl+Shift+X crops every layer and retains selected artwork without invoking Cut',
      result.width === 60 && result.height === 40 && result.layers.length === 3 && !result.selected &&
      croppedInk.join(',') === '255,0,0,255' && clipboard.writes === 0 && clipboard.reads === 0, { result, croppedInk, clipboard });
    await press('Control+z'); result = await capture();
    check('one Undo restores the full canvas after shortcut crop', result.project === beforeCrop.project && !result.selected);

    for (const surface of ['input', 'textarea', 'modal']) {
      await fixture();
      if (surface === 'textarea') {
        await page.locator('[data-tool="text"]').click(); const box = await page.locator('#overlay').boundingBox();
        await page.mouse.click(box.x + 20, box.y + 20); await page.locator('.text-editor').fill('Keep editing this draft');
      } else if (surface === 'modal') {
        await press('Control+e'); await page.locator('#dialog[open]').waitFor();
        await page.locator('#dialog [name="width"]').focus();
      } else await page.locator('#size-number').focus();
      const before = await capture();
      for (const shortcut of shortcuts) { await page.keyboard.press(shortcut); await frame(); }
      const after = await capture();
      check(`resource shortcuts preserve document commands while ${surface} owns focus`,
        JSON.stringify(after) === JSON.stringify(before) &&
        (surface !== 'textarea' || await page.locator('.text-editor').count() === 1) &&
        (surface !== 'modal' || await page.locator('#dialog').evaluate(dialog => dialog.open)), { before, after });
      if (surface === 'modal') await page.locator('#dialog-cancel').click();
      await page.keyboard.press('Escape');
    }
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async ({ initial, key }) => {
      const saved = window[key];
      if (saved.clipboard) Object.defineProperty(navigator, 'clipboard', saved.clipboard); else delete navigator.clipboard;
      delete window[key];
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      for (const [id, properties] of Object.entries(initial.controls)) Object.assign(document.getElementById(id), properties);
    }, { initial, key });
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width &&
      document.querySelector('#overlay').height === project.height, initial.project);
  }
}
