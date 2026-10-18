// Public keyboard journeys, including the distinction between focused and active
// layer. No synthetic engine mutation or native Paint behavior claim.
export async function verifyLayerKeyboardDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await page.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(),
    layers: !document.querySelector('#layers-panel').hidden, zoom: document.querySelector('#zoom-presets').value,
    clean: document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('[data-action="undo"]').disabled &&
      document.querySelector('[data-action="redo"]').disabled && !document.querySelector('.text-editor') }));
  if (!initial.clean) throw new Error('Layer keyboard checks require a pristine Untitled document.');
  const invoke = async (selector, key = 'Enter') => { await page.locator(selector).focus(); await page.keyboard.press(key); await frame(); };
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const history = async key => { await page.keyboard.press(key); await frame(); };
  try {
    if (!initial.layers) await invoke('.layers-group [data-action="layers"]', 'Space');
    const id = await page.locator('#layer-list [data-layer-select]').getAttribute('data-layer-select');
    const layer = `[data-layer-select="${id}"]`, name = `${layer} span`;
    const originalName = await page.locator(name).textContent();
    await invoke('[data-action="rename-layer"]');
    record('keyboard Rename toolbar action opens a named dialog for the active layer',
      await page.getByRole('dialog', { name: 'Rename layer', exact: true }).count() === 1 &&
      await page.locator('#dialog [name="name"]').inputValue() === originalName);
    await page.locator('#dialog [name="name"]').fill('Keyboard drawing'); await page.keyboard.press('Enter'); await frame();
    record('Rename updates the visible and accessible layer name and returns focus',
      await page.locator(name).textContent() === 'Keyboard drawing' &&
      await page.locator(layer).getAttribute('aria-label') === 'Select layer Keyboard drawing' &&
      await page.locator(layer).evaluate(el => document.activeElement === el));
    record('renaming marks the document dirty without changing drawing pixels',
      await page.locator('#document-state').textContent() === 'Unsaved changes' && await pixels() === initial.pixels);
    await history('Control+z');
    record('one Undo restores the original layer name and clean history', await page.locator(name).textContent() === originalName &&
      await page.locator('[data-action="undo"]').isDisabled() && !await page.locator('#document-state').textContent());
    await history('Control+y'); record('Redo restores the renamed layer', await page.locator(name).textContent() === 'Keyboard drawing');
    await history('Control+z'); await invoke(layer, 'F2');
    await page.locator('#dialog [name="name"]').fill('Canceled name'); await page.keyboard.press('Escape'); await frame();
    record('F2 cancel preserves name, redo history and focused layer control', await page.locator(name).textContent() === originalName &&
      await page.locator('[data-action="undo"]').isDisabled() && await page.locator('[data-action="redo"]').isEnabled() &&
      await page.locator(layer).evaluate(el => document.activeElement === el) && await pixels() === initial.pixels);
    await invoke('[data-action="add-layer"]', 'Space');
    const active = await page.locator('#layer-list [data-layer-select][aria-pressed="true"]').getAttribute('data-layer-select');
    await invoke(layer, 'F2'); await page.locator('#dialog [name="name"]').fill('Focused lower layer');
    await page.keyboard.press('Enter'); await frame();
    record('F2 renames the focused layer without switching the active drawing layer', await page.locator(name).textContent() === 'Focused lower layer' &&
      await page.locator('#layer-list [data-layer-select][aria-pressed="true"]').getAttribute('data-layer-select') === active &&
      await page.locator(layer).evaluate(el => document.activeElement === el));
    await history('Control+z');
    record('Undo of focused-layer rename preserves both layers and drawing pixels', await page.locator(name).textContent() === originalName &&
      await page.locator('#layer-list [data-layer-select]').count() === 2 && await pixels() === initial.pixels);
  } finally {
    if (await page.locator('#dialog').evaluate(el => el.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus();
    for (let i = 0; i < 8 && await page.locator('[data-action="undo"]').isEnabled(); i++) { await page.keyboard.press('Control+z'); await frame(); }
    if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Layer-keyboard cleanup exceeded its owned history bound.');
    await page.keyboard.press('Control+n'); await frame();
    if (await page.locator('#layers-panel').isVisible() !== initial.layers) await invoke('.layers-group [data-action="layers"]', 'Space');
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
  }
  record('layer keyboard fixture restores blank pixels and pristine history', await pixels() === initial.pixels &&
    await page.locator('[data-action="undo"]').isDisabled() && await page.locator('[data-action="redo"]').isDisabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyLayerKeyboard(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyLayerKeyboardDesktop(target, check);
  } finally { await context.close(); }
}
