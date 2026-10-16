export async function verifyFontCatalog(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    await context.addInitScript(() => {
      window.paintDesktop = { listFonts: () => new Promise(resolve => { window.deliverFonts = resolve; }) };
    });
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await target.locator('[data-tool="text"]').click();
    const requested = await target.evaluate(() => typeof window.deliverFonts === 'function');
    check('Text requests the desktop installed-font catalog', requested);
    if (!requested) return;
    const box = await target.locator('#overlay').boundingBox(); await target.mouse.click(box.x + 30, box.y + 30);
    await target.keyboard.type('Draft'); await target.keyboard.press('Home'); await target.keyboard.press('ArrowRight');
    await target.keyboard.press('Shift+ArrowRight'); await target.keyboard.press('Shift+ArrowRight');
    await target.evaluate(() => window.deliverFonts({ ok: true, source: 'fixture', families: ['Segoe UI', 'A, B', 'A "Quote"', 'Segoe UI'] }));
    await target.waitForFunction(() => [...document.querySelector('#font').options].some(option => option.value === 'Segoe UI'));
    check('late font discovery preserves the selected font and live caret', await target.locator('#font').inputValue() === 'Arial' &&
      await target.locator('.text-editor').evaluate(el => document.activeElement === el && el.value === 'Draft' && el.selectionStart === 1 && el.selectionEnd === 3));
    check('font names stay exact and duplicate families are removed', await target.locator('#font option').evaluateAll(options =>
      options.filter(option => option.value === 'Segoe UI').length === 1 && options.some(option => option.value === 'A, B') && options.some(option => option.value === 'A "Quote"')));
    await target.locator('#font').selectOption('A, B');
    check('a comma in a font family remains one CSS family', await target.locator('.text-editor').evaluate(el => el.style.fontFamily === '"A, B"'));
    await target.locator('#font').selectOption('A "Quote"');
    check('quotes in a font family retain literal identity', await target.locator('.text-editor').evaluate(el => el.style.fontFamily.includes('\\"Quote\\"')));
    await target.locator('.text-editor').focus(); await target.keyboard.type('p');
    check('typing after a catalog update replaces the retained selection', await target.locator('.text-editor').inputValue() === 'Dpft');
    const blank = await target.locator('#canvas').evaluate(el => el.toDataURL());
    await target.locator('[data-action="commit-text"]').click();
    const painted = await target.locator('#canvas').evaluate(el => el.toDataURL());
    await target.locator('#overlay').focus(); await target.keyboard.press('Control+z');
    check('font selection and continued typing undo as one text edit', painted !== blank && await target.locator('#canvas').evaluate((el, expected) => el.toDataURL() === expected, blank));
    await target.keyboard.press('Control+y');
    check('Redo restores text using the selected family', await target.locator('#canvas').evaluate((el, expected) => el.toDataURL() === expected, painted));
    await target.keyboard.press('Control+z'); await target.keyboard.press('Control+n');
    await target.reload(); await target.locator('#overlay').waitFor(); await target.locator('[data-tool="text"]').click();
    await target.locator('#font').focus(); await target.locator('#font').selectOption('Georgia');
    await target.evaluate(() => window.deliverFonts({ ok: true, families: ['Segoe UI'] }));
    await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check('catalog delivery waits while the font picker owns keyboard focus', await target.locator('#font').evaluate(el => document.activeElement === el && el.value === 'Georgia' && ![...el.options].some(option => option.value === 'Segoe UI')));
    await target.keyboard.press('Tab');
    await target.waitForFunction(() => document.querySelector('#font').dataset.fontCatalog === 'ready');
    check('deferred catalog update preserves a newer font selection and next focus', await target.locator('#font').inputValue() === 'Georgia' && await target.locator('#font-size').evaluate(el => document.activeElement === el));
    await target.reload(); await target.locator('#overlay').waitFor(); await target.locator('[data-tool="text"]').click();
    await target.evaluate(() => window.deliverFonts({ ok: false, message: 'Installed-font fixture unavailable.' }));
    await target.waitForFunction(() => document.querySelector('#font').dataset.fontCatalog === 'unavailable');
    check('discovery failure preserves all standard font choices', await target.locator('#font option').count() === 9 && await target.locator('#font').inputValue() === 'Arial');
    await target.reload(); await target.locator('#overlay').waitFor();
    await target.evaluate(() => {
      delete window.paintDesktop; window.fontQueries = 0;
      navigator.permissions.query = async () => ({ state: 'prompt' });
      window.queryLocalFonts = async () => { window.fontQueries++; return []; };
    });
    await target.locator('[data-tool="text"]').click();
    await target.waitForFunction(() => document.querySelector('#font').dataset.fontCatalog === 'unavailable');
    check('browser Text never prompts for ungranted installed-font access', await target.evaluate(() => window.fontQueries === 0) && await target.locator('#font option').count() === 9);
  } finally { await context.close(); }
}

export async function verifyFontCatalogDesktop(page, check) {
  const initial = await page.evaluate(() => ({ font: document.querySelector('#font').value,
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool, label: document.querySelector('#tool-label').textContent }));
  if (await page.locator('[data-action="undo"]').isEnabled() || await page.locator('[data-action="redo"]').isEnabled() || await page.locator('.text-editor').count()) throw new Error('Native font checks require a pristine document.');
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    await page.locator('[data-tool="text"]').click();
    await page.waitForFunction(() => ['ready', 'unavailable'].includes(document.querySelector('#font').dataset.fontCatalog), null, { timeout: 20000 });
    check('packaged app loads the real installed-font inventory', await page.locator('#font').getAttribute('data-font-catalog') === 'ready');
    const names = await page.locator('#font option').evaluateAll(options => options.map(option => option.value));
    check('installed font families are available beyond the standard list', names.length > 9 && (names.includes('Segoe UI') || names.includes('DejaVu Sans')));
    check('native catalog keeps unique family identities and the selected font', new Set(names).size === names.length && await page.locator('#font').inputValue() === initial.font);
    const family = names.includes('Segoe UI') ? 'Segoe UI' : 'DejaVu Sans';
    await page.locator('#font').selectOption(family);
    check('native installed family can be selected through the public picker', await page.locator('#font').inputValue() === family);
    const blank = await page.locator('#canvas').evaluate(el => el.toDataURL());
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.click(box.x + 30, box.y + 30); await page.keyboard.type('Font test');
    check('native installed family reaches the live text renderer', await page.locator('.text-editor').evaluate((el, expected) => getComputedStyle(el).fontFamily.includes(expected), family));
    await page.locator('[data-action="commit-text"]').click(); await frame();
    const painted = await page.locator('#canvas').evaluate(el => el.toDataURL());
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
    check('native installed-font text draws pixels and undoes in one step', painted !== blank && await page.locator('#canvas').evaluate((el, expected) => el.toDataURL() === expected, blank) && await page.locator('[data-action="undo"]').isDisabled());
    await page.keyboard.press('Control+y'); await frame();
    check('native installed-font text redoes to exact pixels', await page.locator('#canvas').evaluate((el, expected) => el.toDataURL() === expected, painted));
    await page.keyboard.press('Control+z'); await frame(); await page.keyboard.press('Control+n'); await frame();
  } finally {
    await page.locator('#font').selectOption(initial.font);
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
  }
}
