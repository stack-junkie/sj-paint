// Public-only SJ Paint robustness checks. No native-parity claim or dev API.
export async function verifyDrawingAdmissionDesktop(page, check) {
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const waitPixels = expected => page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value,
    expected, { polling: 100 });
  const blank = await pixels(), layersShown = await page.locator('#layers-panel').isVisible();
  check('desktop drawing admission fixture starts with no undo history', await page.locator('[data-action="undo"]').isDisabled());
  const tool = async name => {
    if (name === 'brush') { await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click(); }
    else await page.locator(`[data-tool="${name}"]`).click();
  };
  const move = async (x, y) => { const box = await page.locator('#overlay').boundingBox(); await page.mouse.move(box.x + x, box.y + y); };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); };
  try {
    await page.locator('#zoom-presets').selectOption({ label: '100%' });
    await page.waitForFunction(() => { const c = document.querySelector('#overlay'); return Math.abs(c.getBoundingClientRect().width - c.width) < 0.01; },
      null, { polling: 100 });
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = 0; viewport.scrollLeft = 0; });
    await tool('text'); await click(20, 20); await page.locator('.text-editor').pressSequentially('Preserved draft');
    await move(600, 300); await page.mouse.down({ button: 'middle' }); await move(600, 260);
    await page.keyboard.press('Escape'); await page.mouse.up({ button: 'middle' });
    check('desktop canceling a middle-button pan retains the text draft', await page.locator('.text-editor').inputValue() === 'Preserved draft');
    await page.locator('[data-action="commit-text"]').click();
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() !== value, blank, { polling: 100 });
    await page.keyboard.press('Control+z'); await waitPixels(blank);
    check('desktop text remains one undoable edit after canceled pan', await page.locator('[data-action="undo"]').isDisabled());

    if (!await page.locator('#layers-panel').isVisible()) await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = 0; viewport.scrollLeft = 0; });
    await page.locator('#layer-list [data-visible]').first().click();
    for (const name of ['brush', 'fill', 'text', 'polygon']) {
      await tool(name); await move(30, 30); await page.mouse.down(); await move(100, 70); await page.mouse.up();
      if (name === 'polygon') { await click(130, 30); await click(80, 100); }
      check(`desktop hidden-layer admission rejects ${name}`, await page.locator('.text-editor').count() === 0 &&
        await page.locator('#toast').textContent() === 'Show the active layer before drawing.');
    }
    await tool('brush'); await page.locator('#layer-list [data-visible]').first().click(); await waitPixels(blank);
    check('desktop rejected hidden-layer drawing leaves no concealed pixels', await pixels() === blank);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('#layer-list [data-visible]').getAttribute('aria-pressed') === 'false', null, { polling: 100 });
    await page.keyboard.press('Control+z'); await waitPixels(blank);
    await page.waitForFunction(() => document.querySelector('[data-action="undo"]').disabled, null, { polling: 100 });
    check('desktop rejected drawing creates no history beyond hide and show', await page.locator('[data-action="undo"]').isDisabled());
  } finally {
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.mouse.up({ button: 'middle' }); await page.keyboard.press('Escape');
    // A blank initial history means any remaining edits belong to this fixture.
    for (let attempts = 0; attempts < 10 && await page.locator('[data-action="undo"]').isEnabled(); attempts++) {
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await page.waitForTimeout(100);
    }
    await waitPixels(blank);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.title === 'Untitled - Stack Junkie Paint' &&
      document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled,
      null, { polling: 100 });
    await tool('brush');
    if (await page.locator('#layers-panel').isVisible() !== layersShown) await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#overlay'), zoom = Number(document.querySelector('#zoom-presets').value);
      const bounds = canvas.getBoundingClientRect();
      return Math.abs(bounds.width - canvas.width * zoom) < 0.1 && Math.abs(bounds.height - canvas.height * zoom) < 0.1;
    }, null, { polling: 100 });
  }
}
