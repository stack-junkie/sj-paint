// Public controls and rendered canvas pixels only; usable in the packaged app.
export async function verifyTextDesktop(page, check) {
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value,
    expected, { polling: 100 });
  const blank = await pixels();
  const initial = await page.evaluate(() => ({ width: document.querySelector('#canvas').width,
    height: document.querySelector('#canvas').height,
    font: document.querySelector('#font').value, fontSize: document.querySelector('#font-size').value,
    align: document.querySelector('#text-align').value, background: document.querySelector('#text-background').checked,
    styles: Object.fromEntries(['bold', 'italic', 'underline'].map(action =>
      [action, document.querySelector(`[data-action="${action}"]`).classList.contains('active')])) }));
  check('desktop text fixture starts with a blank history', await page.locator('[data-action="undo"]').isDisabled());
  const type = async text => {
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.click(box.x + 20, box.y + 20);
    await page.locator('.text-editor').pressSequentially(text);
  };
  const ink = () => page.locator('#canvas').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let bands = 0, previous = false, minX = canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      let row = false;
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i + 3] && data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) { row = true; minX = Math.min(minX, x); }
      }
      if (row && !previous) bands++; previous = row;
    }
    return { bands, minX };
  });
  try {
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+e');
    await page.locator('#dialog [name="width"]').fill('240'); await page.locator('#dialog [name="height"]').fill('220');
    await page.locator('#dialog button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#canvas').width === 240 && document.querySelector('#canvas').height === 220,
      null, { polling: 100 });
    await page.locator('#zoom-presets').selectOption({ label: '100%' });
    await page.waitForFunction(() => Math.abs(document.querySelector('#canvas').getBoundingClientRect().width - 240) < 0.01,
      null, { polling: 100 });
    await page.locator('[data-tool="text"]').click(); await page.locator('[data-color="#000000"]').click();
    await page.locator('#font').selectOption('Arial'); await page.locator('#font-size').fill('24'); await page.locator('#font-size').press('Tab');
    await page.locator('#text-align').selectOption('left'); await page.locator('#text-background').uncheck();
    for (const action of ['bold', 'italic', 'underline']) if (await page.locator(`[data-action="${action}"]`).evaluate(el => el.classList.contains('active')))
      await page.locator(`[data-action="${action}"]`).click();
    const smallBlank = await pixels();
    await type('W'.repeat(40)); await page.locator('[data-action="commit-text"]').click();
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, smallBlank, { polling: 100 });
    const wrapped = await pixels(), rows = await ink();
    check('desktop Apply text paints all five wrapped rows of an unbroken word', rows.bands === 5, rows);
    await page.keyboard.press('Control+z'); await waitPixels(smallBlank);
    await page.keyboard.press('Control+y'); await waitPixels(wrapped);
    check('desktop wrapped text is restored by one Undo and Redo', await pixels() === wrapped);
    await page.keyboard.press('Control+z'); await waitPixels(smallBlank);
    await type('indented'); await page.locator('[data-action="commit-text"]').click();
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, smallBlank, { polling: 100 });
    const plain = await ink(); await page.keyboard.press('Control+z'); await waitPixels(smallBlank);
    await type('    indented'); await page.locator('[data-action="commit-text"]').click();
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, smallBlank, { polling: 100 });
    const indented = await ink();
    const expectedSpaces = await page.evaluate(() => {
      const c = document.createElement('canvas').getContext('2d');
      c.font = `${document.querySelector('#font-size').value}px "${document.querySelector('#font').value}"`;
      return c.measureText('    ').width;
    });
    check('desktop Apply text preserves four leading spaces', Math.abs(indented.minX - plain.minX - expectedSpaces) <= 1,
      { plain, indented, expectedSpaces });
    await page.keyboard.press('Control+z'); await waitPixels(smallBlank);

    await type('Draft'); await page.locator('[data-action="bold"]').click(); await page.keyboard.press('Control+y');
    check('desktop redo from Bold retains the live text draft without restoring old pixels',
      await page.locator('.text-editor').inputValue() === 'Draft' && await pixels() === smallBlank &&
      await page.locator('[data-action="redo"]').isEnabled());
    await page.getByRole('button', { name: 'Edit colors', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#dialog').open, null, { polling: 100 });
    const retainedWhileOpen = await page.locator('.text-editor').inputValue() === 'Draft';
    await page.locator('#dialog-cancel').click();
    check('desktop Edit colors cancel retains the draft and original canvas pixels',
      retainedWhileOpen && await page.locator('.text-editor').inputValue() === 'Draft' && await pixels() === smallBlank);
  } finally {
    if (await page.locator('#dialog').evaluate(dialog => dialog.open)) await page.locator('#dialog-cancel').click();
    await page.keyboard.press('Escape');
    // The fixture begins with no history, so every remaining undo belongs to it.
    for (let attempts = 0; attempts < 8 && await page.locator('[data-action="undo"]').isEnabled(); attempts++) {
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+z');
      await page.waitForTimeout(100);
    }
    await waitPixels(blank);
    await page.locator('[data-tool="text"]').click();
    await page.locator('#font').selectOption(initial.font); await page.locator('#font-size').fill(initial.fontSize); await page.locator('#font-size').press('Tab');
    await page.locator('#text-align').selectOption(initial.align); await page.locator('#text-background').setChecked(initial.background);
    for (const [action, active] of Object.entries(initial.styles)) if (await page.locator(`[data-action="${action}"]`).evaluate(el => el.classList.contains('active')) !== active)
      await page.locator(`[data-action="${action}"]`).click();
    await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click();
    // Undo restores pixels but leaves redo entries. New resets the fixture's
    // history and document identity through the same public path as the user.
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(initial => document.title === 'Untitled - Stack Junkie Paint' &&
      document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled &&
      document.querySelector('#canvas').width === initial.width && document.querySelector('#canvas').height === initial.height,
      initial, { polling: 100 });
    await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#overlay'), rect = canvas.getBoundingClientRect(), zoom = Number(document.querySelector('#zoom-presets').value);
      return Math.abs(rect.width - canvas.width * zoom) < 0.01 && Math.abs(rect.height - canvas.height * zoom) < 0.01;
    }, null, { polling: 100 });
  }
  check('desktop text fixture restores a clean blank canvas with no undo or redo history', await pixels() === blank &&
    await page.title() === 'Untitled - Stack Junkie Paint' && await page.locator('[data-action="undo"]').isDisabled() &&
    await page.locator('[data-action="redo"]').isDisabled() && await page.locator('#canvas').evaluate((canvas, initial) =>
      canvas.width === initial.width && canvas.height === initial.height, initial));
}
