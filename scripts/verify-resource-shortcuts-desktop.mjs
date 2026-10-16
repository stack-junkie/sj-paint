// Public renderer controls only, on a fresh blank desktop document. These
// bindings come from decoded Paint resources; this is not a live native probe.
// The caller owns the application. No clipboard shortcuts are exercised here.
export async function verifyResourceShortcutsDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const press = async key => { await page.locator('#overlay').focus(); await page.keyboard.press(key); await frame(); };
  const click = async selector => { await page.locator(selector).click(); await frame(); };
  const layers = () => page.locator('#layer-list > [data-layer]').evaluateAll(rows => rows.map(row => ({
    id: row.dataset.layer,
    selected: row.querySelector('.layer-select').getAttribute('aria-pressed') === 'true',
    visible: row.querySelector('.layer-eye').getAttribute('aria-pressed') === 'true',
  })));
  const publicState = () => page.evaluate(() => ({
    title: document.title,
    pixels: document.querySelector('#canvas').toDataURL(),
    width: document.querySelector('#canvas').width,
    height: document.querySelector('#canvas').height,
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool || document.querySelector('#tool-label').textContent,
    primary: document.querySelector('#primary').style.background,
    secondary: document.querySelector('#secondary').style.background,
    size: document.querySelector('#size-number').value,
    collapsed: document.body.classList.contains('collapsed'),
    zoom: document.querySelector('#zoom-presets').value,
    layersOpen: !document.querySelector('#layers-panel').hidden,
    undoDisabled: document.querySelector('[data-action="undo"]').disabled,
    redoDisabled: document.querySelector('[data-action="redo"]').disabled,
  }));
  const zoomState = () => page.evaluate(() => {
    const bounds = document.querySelector('#canvas').getBoundingClientRect();
    return { zoom: Number(document.querySelector('#zoom-presets').value), width: bounds.width, height: bounds.height };
  });
  const overlayPixels = () => page.locator('#overlay').evaluate(canvas => canvas.toDataURL());
  const fitBounds = () => page.evaluate(() => {
    const viewport = document.querySelector('#viewport'), outer = viewport.getBoundingClientRect();
    const canvas = document.querySelector('#canvas').getBoundingClientRect();
    return { clientWidth: viewport.clientWidth, clientHeight: viewport.clientHeight,
      scrollWidth: viewport.scrollWidth, scrollHeight: viewport.scrollHeight,
      left: canvas.left - outer.left - viewport.clientLeft, top: canvas.top - outer.top - viewport.clientTop,
      right: canvas.right - outer.left - viewport.clientLeft, bottom: canvas.bottom - outer.top - viewport.clientTop };
  });
  const initial = await publicState();
  if (!initial.undoDisabled || !initial.redoDisabled || initial.width !== 1152 || initial.height !== 648 || !initial.title.startsWith('Untitled - ')) {
    throw new Error('Desktop resource shortcut checks require a fresh, default-size Untitled document without Undo or Redo history.');
  }
  if (await page.locator('#dialog').evaluate(element => element.open) || await page.locator('#menu').isVisible()) {
    throw new Error('Desktop resource shortcut checks require no open dialog or menu.');
  }
  let pristine = false;
  try {
    if (initial.collapsed) await click('[data-action="collapse"]');
    if (!initial.layersOpen) await click('.layers-group [data-action="layers"]');
    const original = await layers();
    if (original.length !== 1 || !original[0].selected || !original[0].visible) {
      throw new Error('Desktop resource shortcut checks require one initial visible selected blank layer.');
    }
    pristine = true;
    const base = original[0].id;
    await press('Control+Shift+n');
    const addedLayers = await layers(), added = addedLayers.find(layer => layer.id !== base)?.id;
    if (!added || addedLayers.length !== 2 || !addedLayers.find(layer => layer.id === added).selected) {
      throw new Error('Resource shortcut setup did not create and select its temporary blank layer.');
    }
    record('desktop Ctrl+Shift+N adds above the active layer without replacing the document',
      addedLayers[0].id === added && addedLayers[1].id === base &&
      (await publicState()).pixels === initial.pixels && !await page.locator('#dialog').evaluate(dialog => dialog.open));

    await press('Control+h');
    const hidden = await layers();
    record('desktop Ctrl+H hides only the active layer', hidden.length === 2 &&
      hidden.find(layer => layer.id === added)?.visible === false && hidden.find(layer => layer.id === added)?.selected === true &&
      hidden.find(layer => layer.id === base)?.visible === true && hidden.find(layer => layer.id === base)?.selected === false);
    await press('Control+h');
    record('desktop Ctrl+H restores active layer visibility', JSON.stringify(await layers()) === JSON.stringify(addedLayers));

    await press('Control+Shift+PageDown');
    const down = await layers();
    record('desktop Ctrl+Shift+PageDown moves the active layer below its neighbor', down.length === 2 &&
      down[0].id === base && !down[0].selected && down[1].id === added && down[1].selected && down.every(layer => layer.visible));
    await press('Control+Shift+PageUp');
    const up = await layers();
    record('desktop Ctrl+Shift+PageUp moves the active layer above its neighbor', up.length === 2 &&
      up[0].id === added && up[0].selected && up[1].id === base && !up[1].selected && up.every(layer => layer.visible));
    await press('Control+Shift+Delete');
    const deleted = await layers();
    record('desktop Ctrl+Shift+Delete deletes the active layer and selects its survivor', deleted.length === 1 &&
      deleted[0].id === base && deleted[0].selected && deleted[0].visible);

    const beforeZoom = await publicState(), layersBeforeZoom = await layers();
    await page.locator('#zoom-presets').selectOption({ label: '50%' }); await frame();
    await press('Control+PageUp');
    const zoomedIn = await zoomState();
    record('desktop Ctrl+PageUp increases zoom from 50% to 62.5%', zoomedIn.zoom === .625);
    await press('Control+PageDown');
    const zoomedOut = await zoomState();
    record('desktop Ctrl+PageDown reverses one zoom increment', zoomedOut.zoom === .5 &&
      Math.abs(zoomedIn.width / zoomedOut.width - 1.25) < .001 && Math.abs(zoomedIn.height / zoomedOut.height - 1.25) < .001);

    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await press('Control+0');
    record('desktop Ctrl+0 restores 100% zoom', (await zoomState()).zoom === 1);

    // The public Layers control changes available width without resizing or
    // showing the native window, giving two real viewport layouts.
    const fitViewportWidths = [];
    for (const panelOpen of [true, false]) {
      if (await page.locator('#layers-panel').isVisible() !== panelOpen) await click('.layers-group [data-action="layers"]');
      await page.locator('#zoom-presets').selectOption({ label: '50%' }); await frame();
      await click('[data-action="fit"]');
      const expectedFit = await zoomState();
      fitViewportWidths.push((await fitBounds()).clientWidth);
      for (const startingZoom of ['50%', '200%']) {
        await page.locator('#zoom-presets').selectOption({ label: startingZoom }); await frame();
        await press('Control+1');
        const fitted = await zoomState(), bounds = await fitBounds();
        record(`desktop Ctrl+1 matches Fit from ${startingZoom} with Layers ${panelOpen ? 'open' : 'closed'}`,
          fitted.zoom === expectedFit.zoom && Math.abs(fitted.width - expectedFit.width) < .02 &&
          Math.abs(fitted.height - expectedFit.height) < .02, { expectedFit, fitted, bounds });
        record(`desktop Fit leaves no viewport overflow from ${startingZoom} with Layers ${panelOpen ? 'open' : 'closed'}`,
          bounds.scrollWidth <= bounds.clientWidth + 1 && bounds.scrollHeight <= bounds.clientHeight + 1 &&
          bounds.left >= -.02 && bounds.top >= -.02 && bounds.right <= bounds.clientWidth + .02 && bounds.bottom <= bounds.clientHeight + .02,
          bounds);
      }
    }
    record('desktop Fit is checked at two viewport widths without resizing the native window',
      fitViewportWidths[0] !== fitViewportWidths[1], { fitViewportWidths });
    await click('.layers-group [data-action="layers"]');
    const afterZoom = await publicState();
    record('desktop zoom shortcuts preserve pixels, dimensions, layers and editing history',
      afterZoom.pixels === beforeZoom.pixels && afterZoom.width === beforeZoom.width && afterZoom.height === beforeZoom.height &&
      afterZoom.title === beforeZoom.title && afterZoom.undoDisabled === beforeZoom.undoDisabled && afterZoom.redoDisabled === beforeZoom.redoDisabled &&
      JSON.stringify(await layers()) === JSON.stringify(layersBeforeZoom));

    for (const [shortcut, zoom] of [['Control+r', '100%'], ['Control+g', '400%']]) {
      await page.locator('#zoom-presets').selectOption({ label: zoom }); await frame();
      const beforeOverlay = await overlayPixels(), before = await publicState();
      await press(shortcut);
      const toggled = await overlayPixels();
      record(`desktop ${shortcut} changes the view overlay without editing pixels or history`, toggled !== beforeOverlay &&
        JSON.stringify(await publicState()) === JSON.stringify(before));
      await press(shortcut);
      record(`desktop ${shortcut} restores the view overlay on a second press`, await overlayPixels() === beforeOverlay);
    }
    const beforeCollapse = await publicState();
    const beforeHeight = await page.locator('#viewport').evaluate(viewport => viewport.clientHeight);
    await press('Control+t');
    const collapsed = await publicState(), collapsedHeight = await page.locator('#viewport').evaluate(viewport => viewport.clientHeight);
    record('desktop Ctrl+T toggles the toolbar and changes available drawing height',
      collapsed.collapsed !== beforeCollapse.collapsed && collapsedHeight !== beforeHeight &&
      collapsed.pixels === beforeCollapse.pixels && collapsed.undoDisabled === beforeCollapse.undoDisabled && collapsed.redoDisabled === beforeCollapse.redoDisabled);
    await press('Control+t');
    record('desktop Ctrl+T restores the toolbar and viewport height', JSON.stringify(await publicState()) === JSON.stringify(beforeCollapse) &&
      await page.locator('#viewport').evaluate(viewport => viewport.clientHeight) === beforeHeight);

    const beforeTools = await publicState();
    for (const [key, tool] of [['b', 'fill'], ['t', 'text'], ['i', 'picker'], ['z', 'zoom'], ['p', 'pencil'], ['e', 'eraser'], ['s', 'select']]) {
      await press(key); const selected = await publicState();
      record(`desktop ${key.toUpperCase()} selects ${tool} without changing drawing or history`, selected.tool === tool &&
        await page.locator(`[data-tool="${tool}"]`).getAttribute('aria-pressed') === 'true' && selected.pixels === beforeTools.pixels &&
        selected.undoDisabled === beforeTools.undoDisabled && selected.redoDisabled === beforeTools.redoDisabled);
    }
  } finally {
    // Only our mutations can exist after the initial no-history precondition.
    // Undo all of them even when a shortcut assertion fails or does nothing.
    if (pristine) {
      let remaining = 16;
      while (!await page.locator('[data-action="undo"]').isDisabled() && remaining-- > 0) await press('Control+z');
      const undone = await publicState(), remainingLayers = await layers();
      if (!undone.undoDisabled || undone.pixels !== initial.pixels || remainingLayers.length !== 1 ||
          !remainingLayers[0].visible || !remainingLayers[0].selected) {
        throw new Error('Resource shortcut cleanup could not restore the starting document through Undo.');
      }
      // Clear only this verifier's redo history after restoring saved pixels.
      await press('Control+n');
    }
    if (await page.locator('body').evaluate(body => body.classList.contains('collapsed'))) await click('[data-action="collapse"]');
    // Brush tools have their public commands inside the Brushes menu.
    if (await page.locator(`[data-tool="${initial.tool}"]`).count()) await click(`[data-tool="${initial.tool}"]`);
    else {
      await click('[data-menu="brushes"]');
      await page.getByRole('menuitem', { name: initial.tool, exact: true }).click(); await frame();
    }
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    if (await page.locator('#layers-panel').isVisible() !== initial.layersOpen) await click('.layers-group [data-action="layers"]');
    if (initial.collapsed) await click('[data-action="collapse"]');
    await page.locator('#overlay').focus();
  }
  const restoredLayers = await layers();
  record('desktop resource shortcut checks restore blank pixels, controls, zoom, panel state and clean history',
    restoredLayers.length === 1 && restoredLayers[0].visible && restoredLayers[0].selected &&
    JSON.stringify(await publicState()) === JSON.stringify(initial));
  for (const result of results) check(result.name, result.ok, result.detail);
}
