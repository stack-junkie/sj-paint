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
    zoom: document.querySelector('#zoom-presets').value,
    layersOpen: !document.querySelector('#layers-panel').hidden,
    undoDisabled: document.querySelector('[data-action="undo"]').disabled,
    redoDisabled: document.querySelector('[data-action="redo"]').disabled,
  }));
  const zoomState = () => page.evaluate(() => {
    const bounds = document.querySelector('#canvas').getBoundingClientRect();
    return { zoom: Number(document.querySelector('#zoom-presets').value), width: bounds.width, height: bounds.height };
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
    if (!initial.layersOpen) await click('.layers-group [data-action="layers"]');
    const original = await layers();
    if (original.length !== 1 || !original[0].selected || !original[0].visible) {
      throw new Error('Desktop resource shortcut checks require one initial visible selected blank layer.');
    }
    pristine = true;
    const base = original[0].id;
    await click('[data-action="add-layer"]');
    const addedLayers = await layers(), added = addedLayers.find(layer => layer.id !== base)?.id;
    if (!added || addedLayers.length !== 2 || !addedLayers.find(layer => layer.id === added).selected) {
      throw new Error('Resource shortcut setup did not create and select its temporary blank layer.');
    }

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

    await click('[data-action="fit"]');
    const expectedFit = await zoomState();
    await page.locator('#zoom-presets').selectOption({ label: '200%' }); await frame();
    await press('Control+1');
    const fitted = await zoomState();
    record('desktop Ctrl+1 matches Fit to window from a different zoom', fitted.zoom === expectedFit.zoom &&
      Math.abs(fitted.width - expectedFit.width) < .02 && Math.abs(fitted.height - expectedFit.height) < .02);
    const afterZoom = await publicState();
    record('desktop zoom shortcuts preserve pixels, dimensions, layers and editing history',
      afterZoom.pixels === beforeZoom.pixels && afterZoom.width === beforeZoom.width && afterZoom.height === beforeZoom.height &&
      afterZoom.title === beforeZoom.title && afterZoom.undoDisabled === beforeZoom.undoDisabled && afterZoom.redoDisabled === beforeZoom.redoDisabled &&
      JSON.stringify(await layers()) === JSON.stringify(layersBeforeZoom));
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
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    if (await page.locator('#layers-panel').isVisible() !== initial.layersOpen) await click('.layers-group [data-action="layers"]');
    await page.locator('#overlay').focus();
  }
  const restoredLayers = await layers();
  record('desktop resource shortcut checks restore blank pixels, controls, zoom, panel state and clean history',
    restoredLayers.length === 1 && restoredLayers[0].visible && restoredLayers[0].selected &&
    JSON.stringify(await publicState()) === JSON.stringify(initial));
  for (const result of results) check(result.name, result.ok, result.detail);
}
