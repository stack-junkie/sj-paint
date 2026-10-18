// Public keyboard gestures and rendered pixels. These establish SJ Paint's
// accessible equivalent, not an observed Microsoft Paint keyboard binding.
export async function verifyCanvasResizeKeyboardDesktop(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const handle = edge => page.locator(`.resize-handle[data-handle="${edge}"]`);
  const preview = page.locator('#canvas-resize-preview');
  const snapshot = () => page.locator('#canvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, pixels: canvas.toDataURL() }));
  const same = (a, b) => a.width === b.width && a.height === b.height && a.pixels === b.pixels;
  const original = await snapshot();
  const initialZoom = await page.locator('#zoom-presets').inputValue();
  const initialTool = await page.evaluate(() => ({ tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool, label: document.querySelector('#tool-label').textContent }));
  if (await page.locator('[data-action="undo"]').isEnabled() || await page.locator('[data-action="redo"]').isEnabled()) throw new Error('Keyboard resize fixture requires a pristine document.');
  const press = async key => { await page.keyboard.press(key); await frame(); };
  const history = async command => { await page.locator(`[data-action="${command}"]`).click(); await frame(); };
  const candidate = () => page.evaluate(() => {
    const element = document.querySelector('#canvas-resize-preview'), scale = Number(document.querySelector('#zoom-presets').value);
    return Object.fromEntries(['width', 'height', 'left', 'top'].map(key => [key, parseFloat(element.style[key]) / scale]));
  });
  const cropMatches = async (baseline, offsetX, offsetY) => page.locator('#canvas').evaluate((canvas, args) => {
    // Read a copy, not the production canvas context, preserving its raster mode.
    const copy = document.createElement('canvas'); copy.width = args.baseline.width; copy.height = args.baseline.height;
    copy.getContext('2d').drawImage(canvas, -args.offsetX, -args.offsetY);
    return copy.toDataURL() === args.baseline.pixels;
  }, { baseline, offsetX, offsetY });
  try {
    await page.locator('[data-menu="file"]').click(); await page.locator('[data-command="properties"]').click();
    await page.locator('#dialog [name="width"]').fill('200'); await page.locator('#dialog [name="height"]').fill('140');
    await page.locator('#dialog button[type="submit"]').click(); await frame();
    await page.locator('#zoom-presets').selectOption('1'); await frame();
    await page.locator('[data-tool="pencil"]').click();
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x + 31, box.y + 27); await page.mouse.down();
    await page.mouse.move(box.x + 75, box.y + 48, { steps: 5 }); await page.mouse.up(); await frame();
    const baseline = await snapshot();

    await page.locator('#overlay').focus(); await press('Tab');
    check('Tab reaches a named canvas resize control with keyboard instructions', await handle('nw').evaluate(el =>
      document.activeElement === el && el.tabIndex === 0 && el.getAttribute('role') === 'button' &&
      el.getAttribute('aria-label') === 'Resize canvas top left' && el.getAttribute('aria-description').includes('Enter applies')));

    for (const [edge, keys, width, height, offsetX, offsetY] of [
      ['nw', ['ArrowLeft', 'Shift+ArrowUp'], 201, 150, 1, 10],
      ['n', ['ArrowUp'], 200, 141, 0, 1],
      ['ne', ['ArrowRight', 'ArrowUp'], 201, 141, 0, 1],
      ['w', ['Shift+ArrowLeft'], 210, 140, 10, 0],
      ['e', ['ArrowRight'], 201, 140, 0, 0],
      ['sw', ['ArrowLeft', 'ArrowDown'], 201, 141, 1, 0],
      ['s', ['Shift+ArrowDown'], 200, 150, 0, 0],
      ['se', ['ArrowRight', 'ArrowDown'], 201, 141, 0, 0],
    ]) {
      await handle(edge).focus(); for (const key of keys) await press(key);
      const held = await candidate();
      check(`Keyboard ${edge} previews the anchored edges without changing pixels`, same(await snapshot(), baseline) &&
        held.width === width && held.height === height && held.left === -offsetX && held.top === -offsetY && await preview.isVisible(), held);
      check(`Keyboard ${edge} retains focus and announces preview dimensions`, await handle(edge).evaluate(el => document.activeElement === el) &&
        (await page.locator('.canvas-resize-announcement').textContent()).includes(`${width} by ${height}`));
      await press('Enter'); const committed = await snapshot();
      check(`Keyboard ${edge} applies dimensions and translates original pixels exactly`, committed.width === width && committed.height === height &&
        await cropMatches(baseline, offsetX, offsetY) && await preview.isHidden());
      await history('undo'); check(`Keyboard ${edge} is one reversible operation`, same(await snapshot(), baseline));
      await history('redo'); check(`Keyboard ${edge} Redo restores exact pixels`, same(await snapshot(), committed));
      await history('undo');
    }

    await handle('n').focus(); await press('ArrowLeft');
    check('An unrelated axis does not start a resize or scroll the handle', await preview.isHidden() && same(await snapshot(), baseline));
    await press('Control+ArrowUp');
    check('Modified navigation does not start a canvas resize', await preview.isHidden() && same(await snapshot(), baseline));
    await handle('e').focus(); await press('ArrowRight'); await press('ArrowLeft'); await press('Enter');
    check('A keyboard no-op preserves the existing redo branch', same(await snapshot(), baseline) && await page.locator('[data-action="redo"]').isEnabled());

    for (const finish of ['Escape', 'Tab', 'Control+z', 'Control+0']) {
      await handle('nw').focus(); await press('Shift+ArrowLeft'); await press(finish);
      check(`Keyboard resize ${finish} cancels without pixels or history changes`, await preview.isHidden() && same(await snapshot(), baseline) &&
        await page.locator('[data-action="redo"]').isEnabled());
    }
    await handle('se').focus(); await press('ArrowRight');
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await frame();
    check('Window blur cancels a keyboard canvas resize', await preview.isHidden() && same(await snapshot(), baseline));

    await handle('w').focus();
    for (let count = 0; count < 21; count++) await page.keyboard.press('Shift+ArrowRight');
    await frame(); const minimum = await candidate();
    await press('ArrowLeft'); const reversed = await candidate();
    check('Keyboard resizing uses the shared minimum and reverses immediately after clamping', minimum.width === 1 && minimum.left === 199 && reversed.width === 2 && reversed.left === 198,
      { minimum, reversed });
    await press('Escape');

    await page.locator('#zoom-presets').selectOption('.5'); await frame();
    await handle('nw').focus(); await press('ArrowLeft'); await press('ArrowUp');
    const halfZoom = await candidate();
    check('Keyboard resize steps stay in document pixels at 50% zoom', halfZoom.width === 201 && halfZoom.height === 141 && halfZoom.left === -1 && halfZoom.top === -1, halfZoom);
    await press('Escape');

    // Pointer capture remains a separate owner using the same candidate/commit.
    await page.locator('#zoom-presets').selectOption('1'); await frame();
    await handle('se').scrollIntoViewIfNeeded(); const bounds = await handle('se').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 12, bounds.y + bounds.height / 2 + 8, { steps: 3 }); await frame();
    const pointer = await candidate();
    await handle('e').focus(); await press('ArrowRight');
    check('Keyboard navigation cannot steal a held pointer resize', JSON.stringify(await candidate()) === JSON.stringify(pointer) && same(await snapshot(), baseline));
    await page.mouse.up(); await frame();
    check('The original pointer still commits its shared candidate', (await snapshot()).width === pointer.width && (await snapshot()).height === pointer.height);
    await history('undo');
    const again = await handle('se').boundingBox();
    await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2); await page.mouse.down();
    await page.mouse.move(again.x + again.width / 2 + 8, again.y + again.height / 2 + 5); await frame();
    await handle('e').focus(); await press('Escape'); await page.mouse.up(); await frame();
    check('Escape from a focused handle still cancels the pointer owner', await preview.isHidden() && same(await snapshot(), baseline) &&
      await page.locator('[data-action="redo"]').isEnabled());
  } finally {
    await page.mouse.up(); await page.keyboard.press('Escape'); await frame();
    // Own only this pristine-fixture history. Return to the original saved state
    // before New so desktop runs never need a chooser or discard response.
    for (let count = 0; count < 8 && await page.locator('[data-action="undo"]').isEnabled(); count++) await history('undo');
    if (!same(await snapshot(), original)) throw new Error('Keyboard resize fixture could not restore its original document.');
    await page.keyboard.press('Control+n'); await frame();
    if (initialTool.tool) await page.locator(`[data-tool="${initialTool.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initialTool.label, exact: true }).click(); }
    await page.locator('#zoom-presets').selectOption(initialZoom); await frame();
  }
}

export async function verifyCanvasResizeKeyboard(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyCanvasResizeKeyboardDesktop(target, check);
  } finally { await context.close(); }
}
