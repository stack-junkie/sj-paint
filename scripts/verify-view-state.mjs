// Static pinned MenuBar.xbf evidence establishes toggle presentation for Rulers,
// Gridlines and Status bar. Native persistence/focus behavior is not established.
// Operations below use public controls; canvas readback verifies SJ preservation.
export async function verifyViewStateDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => ({
    pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled,
    dirty: document.querySelector('#document-state').textContent,
  }));
  const close = async () => { if (await page.locator('#menu').isVisible()) await page.keyboard.press('Escape'); };
  const open = async () => { await close(); await page.locator('[data-menu="view"]').click(); };
  const choose = async command => { await open(); await page.locator(`#menu [data-command="${command}"]`).click(); await frame(); };
  const item = command => page.locator(`#menu [data-command="${command}"]`);
  const state = command => item(command).evaluate(el => ({ role: el.getAttribute('role'), checked: el.getAttribute('aria-checked') }));
  const initial = await snapshot();
  if (!initial.undo || !initial.redo || initial.dirty || !await page.locator('.statusbar').isVisible()) {
    throw new Error('View state checks require a pristine document and visible status bar.');
  }
  const initialZoom = await page.locator('#zoom-presets').inputValue();
  let gridToggled = false, rulersToggled = false, pendingShape = false;
  try {
    for (const [command, title, shortcut] of [['grid', 'Gridlines', 'Control+g'], ['rulers', 'Rulers', 'Control+r']]) {
      await open(); const before = await state(command);
      record(`${title} is an unchecked menu checkbox initially`, before.role === 'menuitemcheckbox' && before.checked === 'false', before);
      await item(command).click(); await frame();
      if (command === 'grid') gridToggled = true; else rulersToggled = true;
      record(`${title} activation dismisses the menu and restores its opener`, await page.locator('#menu').isHidden() &&
        await page.locator('[data-menu="view"]').evaluate(el => document.activeElement === el));
      await open(); const enabled = await state(command);
      record(`${title} exposes checked state after pointer activation`, enabled.role === 'menuitemcheckbox' && enabled.checked === 'true', enabled);
      await close(); await page.keyboard.press(shortcut); await frame();
      if (command === 'grid') gridToggled = false; else rulersToggled = false;
      await open(); const disabled = await state(command);
      record(`${title} checkbox follows its existing keyboard shortcut`, disabled.role === 'menuitemcheckbox' && disabled.checked === 'false', disabled);
    }
    await open(); const status = item('status-bar');
    record('View exposes the resource-declared Status bar command', await status.count() === 1);
    if (await status.count()) {
      const initialStatus = await state('status-bar');
      record('Status bar is a checked menu checkbox initially', initialStatus.role === 'menuitemcheckbox' && initialStatus.checked === 'true', initialStatus);
      const beforeLayout = await page.locator('#viewport').boundingBox();
      const footerHeight = (await page.locator('.statusbar').boundingBox()).height;
      await status.click(); await frame();
      const hiddenLayout = await page.locator('#viewport').boundingBox();
      record('Hiding Status bar releases its height to the drawing workspace', await page.locator('.statusbar').isHidden() &&
        Math.abs(hiddenLayout.height - beforeLayout.height - footerHeight) < 2, { beforeLayout, hiddenLayout, footerHeight });
      await page.keyboard.press('Control+PageUp'); await frame();
      const zoomed = await page.locator('#zoom-presets').inputValue();
      record('Zoom shortcut remains usable with Status bar hidden', zoomed !== initialZoom, { initialZoom, zoomed });
      await choose('zoom-100');
      record('View zoom command remains usable with Status bar hidden', await page.locator('#zoom-presets').inputValue() === '1');
      await open(); const hidden = await state('status-bar');
      record('Hidden Status bar is exposed as unchecked', hidden.role === 'menuitemcheckbox' && hidden.checked === 'false', hidden);
      await status.focus(); await page.keyboard.press('Space'); await frame();
      record('Keyboard activation restores Status bar and menu focus', await page.locator('.statusbar').isVisible() &&
        await page.locator('#menu').isHidden() && await page.locator('[data-menu="view"]').evaluate(el => document.activeElement === el));
      await page.locator('#zoom-presets').selectOption(initialZoom); await frame();
      record('View presentation commands preserve drawing pixels, dirty state and history', JSON.stringify(await snapshot()) === JSON.stringify(initial));

      // A presentation-only command must not accept a pending drawing transaction.
      await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
      const box = await page.locator('#overlay').boundingBox();
      await page.mouse.move(box.x + 25, box.y + 25); await page.mouse.down();
      await page.mouse.move(box.x + 95, box.y + 75); await page.mouse.up(); await frame(); pendingShape = true;
      record('View preservation fixture creates a pending shape', (await snapshot()).pixels !== initial.pixels);
      await choose('status-bar'); await choose('status-bar');
      await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await frame(); pendingShape = false;
      record('Status bar toggles keep the pending shape cancellable without history', JSON.stringify(await snapshot()) === JSON.stringify(initial));
    }
  } finally {
    await close();
    if (pendingShape) { await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); }
    if (gridToggled) await page.keyboard.press('Control+g');
    if (rulersToggled) await page.keyboard.press('Control+r');
    if (await page.locator('.statusbar').isHidden()) await choose('status-bar');
    await page.locator('#zoom-presets').selectOption(initialZoom);
    await page.locator('[data-menu="brushes"]').click();
    await page.locator('#menu [data-command="tool:brush"]').click(); await frame();
  }
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyViewState(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url());
    await target.locator('#overlay').waitFor();
    await verifyViewStateDesktop(target, check);
  } finally { await context.close(); }
}
