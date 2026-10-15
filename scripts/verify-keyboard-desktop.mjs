// Public renderer controls only. The caller supplies a fresh blank desktop
// document; this module neither launches an application nor accesses paintApp.
// These are keyboard robustness checks, not native Paint parity observations.
export async function verifyKeyboardDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const press = async (selector, key) => { await page.locator(selector).focus(); await page.keyboard.press(key); await frame(); };
  const focused = selector => page.locator(selector).evaluate(element => document.activeElement === element);
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
  const initial = await publicState();
  // New clears history during cleanup. Refuse an existing editing session rather
  // than claiming to preserve history that public UI cannot reconstruct.
  if (!initial.undoDisabled || !initial.redoDisabled || initial.width !== 1152 || initial.height !== 648 || !initial.title.startsWith('Untitled - ')) {
    throw new Error('Desktop keyboard checks require a fresh, default-size Untitled document without Undo or Redo history.');
  }
  let undoCount = 0, initialLayers, pristine = false;
  try {
    if (!initial.layersOpen) await press('.layers-group [data-action="layers"]','Space');
    initialLayers = await page.locator('#layer-list > [data-layer]').evaluateAll(rows => rows.map(row => ({
      id: row.dataset.layer, selected: row.querySelector('.layer-select').getAttribute('aria-pressed'),
      visible: row.querySelector('.layer-eye').getAttribute('aria-pressed'),
    })));
    if (initialLayers.length !== 1 || initialLayers[0].selected !== 'true' || initialLayers[0].visible !== 'true') throw new Error('Desktop keyboard checks require one initial visible selected blank layer.');
    pristine = true;

    await page.locator('#zoom-presets').selectOption({ label: '50%' }); await frame();
    await press('[data-menu="view"]','Enter');
    record('desktop Enter opens the focused menu and focuses its first command', await page.locator('#menu').isVisible() && await focused('#menu button:first-child'));
    if (!await page.locator('#menu').isVisible()) await press('[data-menu="view"]','Space');
    await press('#menu [data-command="zoom-100"]','Enter');
    record('desktop Enter invokes a menu command and closes the menu', !await page.locator('#menu').isVisible() && Number(await page.locator('#zoom-presets').inputValue()) === 1);
    if (await page.locator('#menu').isVisible()) await page.keyboard.press('Escape');
    await press('[data-menu="view"]','Space'); await page.keyboard.press('Escape'); await frame();
    record('desktop Escape closes the menu and returns focus to its opener', !await page.locator('#menu').isVisible() && await focused('[data-menu="view"]'));
    await press('[data-menu="view"]','Space'); await page.keyboard.press('Shift+Tab'); await frame();
    record('desktop Tab leaving a menu closes it without stealing focus', !await page.locator('#menu').isVisible() && await focused('[data-action="zoom-in"]'));
    await page.keyboard.press('Shift+Tab');
    const sliderFocused = await focused('#zoom-slider');
    await page.keyboard.press('Home'); await frame();
    record('desktop Home retains native slider behavior after leaving a menu', sliderFocused && await focused('#zoom-slider') && Number(await page.locator('#zoom-slider').inputValue()) === -3);
    if (await page.locator('#menu').isVisible()) await page.keyboard.press('Escape');

    await press('[data-action="add-layer"]','Space');
    const ids = await page.locator('#layer-list > [data-layer]').evaluateAll(rows => rows.map(row => row.dataset.layer));
    const added = ids.find(id => id !== initialLayers[0].id);
    if (!added) throw new Error('Keyboard add-layer setup did not create its temporary blank layer.');
    undoCount++;
    const selection = id => `[data-layer-select="${id}"]`;
    await press(selection(initialLayers[0].id),'Enter');
    record('desktop Enter selects the intended layer', await page.locator(selection(initialLayers[0].id)).getAttribute('aria-pressed') === 'true');
    await press(selection(added),'Space');
    record('desktop Space selects the intended layer', await page.locator(selection(added)).getAttribute('aria-pressed') === 'true');
    const eye = `[data-visible="${added}"]`;
    for (const key of ['Enter','Space']) {
      const before = await page.locator(eye).getAttribute('aria-pressed');
      await press(eye,key);
      const changed = await page.locator(eye).getAttribute('aria-pressed') !== before;
      if (changed) undoCount++;
      record(`desktop ${key} toggles layer visibility and retains eye-button focus`, changed && await focused(eye));
    }
    await press('[data-action="layer-down"]','Space');
    const reordered = await page.locator('#layer-list > [data-layer]').first().getAttribute('data-layer') !== added;
    if (reordered) undoCount++;
    await page.locator(selection(added)).focus();
    if (reordered) { await page.keyboard.press('Control+z'); undoCount--; await frame(); }
    record('desktop Undo reordering preserves focus on the surviving layer button', reordered && await focused(selection(added)) &&
      await page.locator('#layer-list > [data-layer]').first().getAttribute('data-layer') === added);
  } finally {
    if (await page.locator('#menu').isVisible()) await page.keyboard.press('Escape');
    await page.locator('#overlay').focus();
    while (undoCount > 0) { await page.keyboard.press('Control+z'); undoCount--; await frame(); }
    // Undo restores the saved blank document. New removes only this verifier's
    // redo entries, with no unsaved-content confirmation or file picker.
    if (pristine) { await page.keyboard.press('Control+n'); await frame(); }
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    if (await page.locator('#layers-panel').isVisible() !== initial.layersOpen) await press('.layers-group [data-action="layers"]','Space');
    await page.locator('#overlay').focus();
  }
  const restored = await publicState();
  const layerRestored = await page.locator('#layer-list > [data-layer]').evaluateAll(rows => rows.length === 1 &&
    rows[0].querySelector('.layer-eye').getAttribute('aria-pressed') === 'true' &&
    rows[0].querySelector('.layer-select').getAttribute('aria-pressed') === 'true');
  record('desktop keyboard checks restore blank pixels, tool, colors, zoom, panel state and clean history',
    layerRestored && JSON.stringify(restored) === JSON.stringify(initial));
  for (const result of results) check(result.name,result.ok,result.detail);
}
