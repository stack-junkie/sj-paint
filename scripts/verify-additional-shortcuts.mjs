// Static resource bindings exercised through public browser controls. paintApp
// is used only to prepare/restore fixtures and inspect their resulting state.
export async function verifyAdditionalShortcuts(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const press = async shortcut => { await page.locator('#overlay').focus(); await page.keyboard.press(shortcut); await frame(); };
  const toolKeys = [['b', 'fill'], ['t', 'text'], ['i', 'picker'], ['z', 'zoom'], ['p', 'pencil'], ['e', 'eraser'], ['s', 'select']];
  const commands = ['Control+Shift+n', 'Control+r', 'Control+g', 'Control+t', 'Control+0'];
  const initial = await page.evaluate(() => ({
    project: paintApp.doc.serialize(), state: { ...paintApp.state }, collapsed: document.body.classList.contains('collapsed'),
    controls: Object.fromEntries(['size', 'size-number', 'font', 'font-size', 'text-align', 'text-background'].map(id => {
      const element = document.getElementById(id); return [id, { value: element.value, checked: element.checked }];
    })),
  }));
  const capture = () => page.evaluate(() => {
    const d = paintApp.doc, s = paintApp.state;
    return { project: JSON.stringify(d.serialize()), pixels: d.composite().toDataURL(),
      layers: d.layers.map(layer => ({ id: layer.id, png: layer.canvas.toDataURL() })), active: d.activeLayerId,
      revision: d.revision, undo: d._undo.length, redo: d._redo.length, selected: Boolean(d.selection), transaction: Boolean(d._transaction),
      tool: s.tool, zoom: s.zoom, rulers: s.rulers, grid: s.grid, collapsed: document.body.classList.contains('collapsed') };
  });
  const fixture = async () => {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(() => {
      const d = paintApp.doc; d.newDocument(300, 200);
      Object.assign(paintApp.state, { grid: false, rulers: false, transparentSelection: false,
        font: 'Arial', fontSize: 24, bold: false, italic: false, underline: false, strikethrough: false, align: 'left', textBackground: false });
      d.setSelectionTransparency(false, '#ffffff');
      d.setLayer(d.activeLayerId, { name: 'Bottom' });
      d.begin('Bottom fixture'); let ctx = d.activeLayer.canvas.getContext('2d'); ctx.fillStyle = '#0000ff'; ctx.fillRect(90, 30, 20, 20); d.commit();
      const middle = d.addLayer('Middle'); d.begin('Middle fixture'); ctx = middle.canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(30, 30, 20, 20); d.commit();
      d.addLayer('Top'); d.selectLayer(middle.id); d.markSaved(); paintApp.setZoom(1);
    });
    if (await page.locator('body').evaluate(body => body.classList.contains('collapsed'))) await page.locator('[data-action="collapse"]').click();
    await page.locator('[data-tool="pencil"]').click();
    await page.waitForFunction(() => document.querySelector('#overlay').width === 300 &&
      Math.abs(document.querySelector('#overlay').getBoundingClientRect().width - 300) < .02);
    await frame(); return capture();
  };
  try {
    const beforeAdd = await fixture();
    await press('Control+Shift+n');
    const added = await capture(), oldIndex = beforeAdd.layers.findIndex(layer => layer.id === beforeAdd.active);
    const newLayer = added.layers.find(layer => !beforeAdd.layers.some(old => old.id === layer.id));
    check('Ctrl+Shift+N adds one layer immediately above active and preserves the existing drawing',
      added.layers.length === beforeAdd.layers.length + 1 && newLayer && added.active === newLayer.id &&
      added.layers[oldIndex + 1].id === newLayer.id && added.pixels === beforeAdd.pixels && added.undo === beforeAdd.undo + 1 &&
      beforeAdd.layers.every(old => added.layers.some(layer => layer.id === old.id && layer.png === old.png)) &&
      !await page.locator('#dialog').evaluate(dialog => dialog.open));
    await press('Control+z');
    const undone = await capture();
    check('one Undo removes only the shortcut-added layer and restores the active layer',
      undone.project === beforeAdd.project && undone.active === beforeAdd.active && undone.pixels === beforeAdd.pixels);

    for (const [shortcut, property] of [['Control+r', 'rulers'], ['Control+g', 'grid'], ['Control+t', 'collapsed']]) {
      const before = await capture(); await press(shortcut); const toggled = await capture();
      const otherControls = ['rulers', 'grid', 'collapsed'].filter(name => name !== property);
      check(`${shortcut} toggles its view control without editing the drawing`, toggled[property] === !before[property] &&
        otherControls.every(name => toggled[name] === before[name]) && toggled.project === before.project &&
        toggled.undo === before.undo && toggled.redo === before.redo && toggled.tool === before.tool);
      await press(shortcut);
      check(`${shortcut} restores its view control on a second press`, JSON.stringify(await capture()) === JSON.stringify(before));
    }

    const beforeZoom = await capture();
    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await press('Control+0');
    const resetZoom = await capture();
    check('Ctrl+0 restores 100% zoom without changing drawing or history', resetZoom.zoom === 1 &&
      resetZoom.project === beforeZoom.project && resetZoom.undo === beforeZoom.undo && resetZoom.redo === beforeZoom.redo);
    await page.locator('#zoom-presets').selectOption({ label: '50%' }); await frame();
    await page.locator('#overlay').dispatchEvent('keydown', { key: '0', code: 'Numpad0', location: 3, ctrlKey: true }); await frame();
    check('numeric keypad Ctrl+0 restores 100% zoom', (await capture()).zoom === 1);
    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await page.locator('#overlay').dispatchEvent('keydown', { key: 'Insert', code: 'Numpad0', location: 3, ctrlKey: true }); await frame();
    check('keypad navigation Insert is not treated as numeric keypad 0', (await capture()).zoom === 2);

    const beforeTools = await capture();
    for (const [key, tool] of toolKeys) {
      await press(key); const selected = await capture();
      check(`unmodified ${key.toUpperCase()} selects ${tool} without editing the drawing`, selected.tool === tool &&
        await page.locator(`[data-tool="${tool}"]`).getAttribute('aria-pressed') === 'true' &&
        selected.project === beforeTools.project && selected.undo === beforeTools.undo && selected.redo === beforeTools.redo && selected.zoom === beforeTools.zoom);
    }

    for (const shortcut of [
      ...toolKeys.flatMap(([key]) => [`Shift+${key}`, `Alt+${key}`]),
      'Control+Alt+Shift+n', 'Control+Alt+r', 'Control+Alt+g', 'Control+Alt+t', 'Control+Alt+0',
      'Control+Shift+r', 'Control+Shift+g', 'Control+Shift+t', 'Control+Shift+0',
    ]) {
      // Each letter guard starts on a different tool, including the final S.
      // Otherwise a wrongly accepted shortcut could reselect the current tool.
      if (!shortcut.startsWith('Control+')) {
        const guardedKey = shortcut.split('+').at(-1);
        await page.locator(`[data-tool="${guardedKey === 'p' ? 'fill' : 'pencil'}"]`).click(); await frame();
      }
      const before = await capture(); await press(shortcut);
      check(`${shortcut} does not fall through to an unmodified reference binding`,
        JSON.stringify(await capture()) === JSON.stringify(before) && !await page.locator('#dialog').evaluate(dialog => dialog.open));
    }

    for (const surface of ['input', 'textarea', 'modal']) {
      await fixture();
      if (surface === 'textarea') {
        await page.locator('[data-tool="text"]').click(); const bounds = await page.locator('#overlay').boundingBox();
        await page.mouse.click(bounds.x + 20, bounds.y + 20); await page.locator('.text-editor').fill('Keep this draft');
      } else if (surface === 'modal') {
        await press('Control+e'); await page.locator('#dialog[open]').waitFor(); await page.locator('#dialog [name="width"]').focus();
      } else await page.locator('#size-number').focus();
      const before = await capture();
      for (const shortcut of [...commands, ...toolKeys.map(([key]) => key)]) { await page.keyboard.press(shortcut); await frame(); }
      const after = await capture();
      const ownsFocus = await page.evaluate(surface => surface === 'textarea'
        ? document.activeElement?.matches('.text-editor')
        : surface === 'modal' ? document.querySelector('#dialog').open && document.querySelector('#dialog').contains(document.activeElement)
          : document.activeElement === document.querySelector('#size-number'), surface);
      check(`additional shortcuts preserve document, view and tool while ${surface} owns focus`,
        JSON.stringify(after) === JSON.stringify(before) && ownsFocus, { before, after });
      if (surface === 'textarea') check('tool letters remain text input rather than committing or switching the text tool',
        await page.locator('.text-editor').inputValue() === 'Keep this draftbtizpes');
      if (surface === 'modal') await page.locator('#dialog-cancel').click();
      await page.keyboard.press('Escape');
    }
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    const collapsed = await page.locator('body').evaluate(body => body.classList.contains('collapsed'));
    if (collapsed !== initial.collapsed) await page.locator('[data-action="collapse"]').click();
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      for (const [id, properties] of Object.entries(initial.controls)) Object.assign(document.getElementById(id), properties);
    }, initial);
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width &&
      document.querySelector('#overlay').height === project.height, initial.project);
  }
}
