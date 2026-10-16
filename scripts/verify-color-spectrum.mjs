export async function verifyColorSpectrumDesktop(page, check) {
  const initial = await page.evaluate(() => ({ stored: localStorage.getItem('paint-colors'), pixels: document.querySelector('#canvas').toDataURL(),
    primary: document.querySelector('#primary').style.background }));
  if (initial.primary !== 'rgb(0, 0, 0)' || await page.locator('[data-action="undo"]').isEnabled() || await page.locator('[data-action="redo"]').isEnabled() || await page.locator('.text-editor').count()) throw new Error('Spectrum checks require a pristine default document.');
  const dialog = page.getByRole('dialog', { name: 'Edit colors', exact: true });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    await page.locator('#primary').click(); await dialog.waitFor();
    check('Edit colors exposes an inline spectrum', await dialog.locator('canvas[aria-label="Color spectrum"]').count() === 1);
    check('Edit colors exposes Basic and Custom color groups', await dialog.getByRole('group', { name: 'Basic colors', exact: true }).count() === 1 && await dialog.getByRole('group', { name: 'Custom colors', exact: true }).count() === 1);
    await page.locator('#hex').fill('#ff0000');
    const spectrum = dialog.locator('canvas[aria-label="Color spectrum"]'), box = await spectrum.boundingBox();
    await page.mouse.move(box.x + box.width / 3, box.y + 1); await page.mouse.down(); await frame();
    const held = await page.locator('#hex').inputValue();
    check('held spectrum pointer updates the dialog color without changing the document', held !== '#ff0000' && await page.locator('#primary').evaluate((el, expected) => el.style.background === expected, initial.primary));
    await page.mouse.move(box.x + box.width * 2 / 3, box.y + box.height / 2); await page.mouse.up(); await frame();
    check('release retains the last spectrum color', await page.locator('#hex').inputValue() !== held);
    for (const interruption of ['pointercancel', 'lostpointercapture']) {
      await page.locator('#hex').fill('#123456');
      await spectrum.evaluate(el => el.addEventListener('pointerdown', event => { el.dataset.observedPointerId = event.pointerId; }, { once: true }));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3); await page.mouse.down();
      const pointerId = await spectrum.evaluate(el => { const id = Number(el.dataset.observedPointerId); delete el.dataset.observedPointerId; return id; });
      await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
      if (interruption === 'pointercancel') await spectrum.dispatchEvent('pointercancel', { pointerId });
      else await spectrum.evaluate((el, id) => el.releasePointerCapture(id), pointerId);
      await page.mouse.up(); await frame();
      check(`${interruption} restores the color from before the held gesture`, await page.locator('#hex').inputValue() === '#123456');
    }
    await page.locator('#hex').fill('#00ff00'); await page.locator('[name="color-model"]').selectOption('hsv');
    await spectrum.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    check('spectrum arrow keys edit the shared HSV channels', await dialog.getByRole('spinbutton', { name: 'Hue', exact: true }).inputValue() === '122' && await dialog.getByRole('spinbutton', { name: 'Saturation', exact: true }).inputValue() === '99');
    await page.locator('#hex').fill('#ff0000');
    await dialog.getByRole('slider', { name: 'Color value', exact: true }).focus(); await page.keyboard.press('Home');
    check('value slider keyboard minimum produces black', await page.locator('#hex').inputValue() === '#000000');
    await page.keyboard.press('End');
    check('value slider restores the retained hue at maximum', await page.locator('#hex').inputValue() === '#ff0000');
    await page.locator('#hex').fill('#123456'); await dialog.getByRole('button', { name: 'Add color', exact: true }).click();
    check('Add color stages a custom swatch without closing or persisting', await dialog.isVisible() && await dialog.getByRole('group', { name: 'Custom colors', exact: true }).getByRole('button', { name: '#123456', exact: true }).count() === 1 && await page.evaluate(() => localStorage.getItem('paint-colors')) === initial.stored);
    await dialog.getByRole('group', { name: 'Basic colors', exact: true }).getByRole('button', { name: '#ed1c24', exact: true }).click();
    check('basic swatches update the dialog-local color', await page.locator('#hex').inputValue() === '#ed1c24');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await frame();
    check('Cancel discards spectrum and staged custom colors', await page.evaluate(before => localStorage.getItem('paint-colors') === before.stored && document.querySelector('#primary').style.background === before.primary && document.querySelector('#canvas').toDataURL() === before.pixels, initial));
    await page.locator('#primary').click(); await dialog.waitFor();
    const add = dialog.getByRole('button', { name: 'Add color', exact: true });
    await page.locator('#hex').fill(''); await add.click();
    check('Add color rejects incomplete input without changing persistence', await dialog.isVisible() && await page.evaluate(() => localStorage.getItem('paint-colors')) === initial.stored);
    for (const color of ['#123456', '#654321']) { await page.locator('#hex').fill(color); await add.click(); }
    const button = await add.elementHandle();
    await add.focus(); await page.keyboard.press('Space');
    check('adding a duplicate retains Add focus and one custom swatch', await button.evaluate(el => document.activeElement === el) && await dialog.getByRole('group', { name: 'Custom colors', exact: true }).getByRole('button', { name: '#654321', exact: true }).count() === 1);
    await dialog.getByRole('group', { name: 'Custom colors', exact: true }).getByRole('button', { name: '#123456', exact: true }).click();
    check('custom swatches select their saved dialog color', await page.locator('#hex').inputValue() === '#123456');
    await dialog.getByRole('button', { name: 'OK', exact: true }).click(); await frame();
    check('OK applies the selected color and all staged custom entries', await page.evaluate(() => document.querySelector('#primary').style.background === 'rgb(18, 52, 86)' && JSON.parse(localStorage.getItem('paint-colors')).slice(0, 2).join(',') === '#123456,#654321'));
    check('accepting palette edits preserves canvas pixels and history', await page.locator('#canvas').evaluate((el, expected) => el.toDataURL() === expected, initial.pixels) && await page.locator('[data-action="undo"]').isDisabled());
    await page.locator('#primary').click(); await dialog.waitFor(); await page.locator('#hex').fill('#ff0000');
    const nextBox = await spectrum.boundingBox(); await page.mouse.move(nextBox.x + 60, nextBox.y + 60); await page.mouse.down();
    await page.keyboard.press('Escape'); await page.mouse.up(); await frame();
    check('Escape during a held spectrum gesture closes without accepting its color', !await dialog.isVisible() && await page.locator('#primary').evaluate(el => el.style.background === 'rgb(18, 52, 86)'));
  } finally {
    await page.mouse.up();
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(stored => stored === null ? localStorage.removeItem('paint-colors') : localStorage.setItem('paint-colors', stored), initial.stored);
    await page.reload(); await page.locator('#overlay').waitFor();
  }
  check('spectrum fixture restores the original palette and blank canvas', await page.evaluate(before => localStorage.getItem('paint-colors') === before.stored && document.querySelector('#primary').style.background === before.primary && document.querySelector('#canvas').toDataURL() === before.pixels, initial));
}

export async function verifyColorSpectrum(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyColorSpectrumDesktop(target, check);
    await target.setViewportSize({ width: 500, height: 360 });
    await target.locator('#primary').click();
    const dialog = target.getByRole('dialog', { name: 'Edit colors', exact: true });
    const bounds = await dialog.boundingBox();
    check('color dialog stays inside a small viewport', bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 500 && bounds.y + bounds.height <= 360);
    await target.locator('#hex').fill('#abcdef'); await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    check('small-window scrolling keeps color acceptance reachable', !await dialog.isVisible() && await target.locator('#primary').evaluate(el => el.style.background === 'rgb(171, 205, 239)'));
  } finally { await context.close(); }
}
