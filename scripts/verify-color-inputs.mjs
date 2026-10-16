export async function verifyColorInputsDesktop(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const dialog = page.getByRole('dialog', { name: 'Edit colors', exact: true });
  const open = async (which = 'primary') => { await page.locator(`#${which}`).click(); await dialog.waitFor(); };
  const accept = async () => { await dialog.getByRole('button', { name: 'OK', exact: true }).click(); await frame(); };
  const snapshot = () => page.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(),
    primary: document.querySelector('#primary').style.background, secondary: document.querySelector('#secondary').style.background,
    stored: localStorage.getItem('paint-colors'), undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled,
    title: document.title, width: document.querySelector('#canvas').width, height: document.querySelector('#canvas').height }));
  const initial = await snapshot();
  if (!initial.undo || !initial.redo || initial.title !== 'Untitled - Stack Junkie Paint' || initial.width !== 1152 || initial.height !== 648 ||
      initial.primary !== 'rgb(0, 0, 0)' || initial.secondary !== 'rgb(255, 255, 255)' || await page.locator('.text-editor').count()) throw new Error('Color input checks require a pristine default document and colors.');
  try {
    await open(); await page.locator('#hex').fill(''); await accept();
    check('empty hex cannot accept a stale color', await dialog.isVisible() && JSON.stringify(await snapshot()) === JSON.stringify(initial));
    if (!await dialog.isVisible()) await open();
    check('Edit colors exposes named RGB channel inputs', await dialog.getByRole('spinbutton').count() === 3);
    const channels = ['Red', 'Green', 'Blue'].map(name => dialog.getByRole('spinbutton', { name, exact: true }));
    await page.locator('#hex').fill('#12AbEF');
    check('hex updates all RGB channels exactly', JSON.stringify(await Promise.all(channels.map(el => el.inputValue()))) === '["18","171","239"]');
    await page.locator('#hex').fill('#xyz123'); await accept();
    check('malformed hex cannot accept the previous valid color', await dialog.isVisible() && JSON.stringify(await snapshot()) === JSON.stringify(initial));
    await page.locator('#hex').fill('#12abef');
    for (const invalid of ['', '-1', '256', '1.5']) {
      await channels[0].fill(invalid); await accept();
      check(`invalid red channel ${JSON.stringify(invalid)} preserves the dialog and document`, await dialog.isVisible() && JSON.stringify(await snapshot()) === JSON.stringify(initial));
    }
    await channels[0].fill('254'); await channels[0].press('ArrowUp'); await channels[1].fill('0'); await channels[2].fill('128');
    check('RGB updates hex and spectrum from one color', await page.locator('#hex').inputValue() === '#ff0080' && await dialog.locator('[name="color"]').inputValue() === '#ff0080');
    await page.keyboard.press('Escape'); await frame();
    check('Escape discards channel edits without palette or history changes', JSON.stringify(await snapshot()) === JSON.stringify(initial));
    await open('secondary'); await page.locator('#hex').fill('#123456'); await accept();
    const applied = await snapshot();
    check('accepting a secondary color leaves primary pixels and history unchanged', applied.secondary === 'rgb(18, 52, 86)' && applied.primary === initial.primary && applied.pixels === initial.pixels && applied.undo && applied.redo);
    check('accepted color enters the existing custom palette', JSON.parse(applied.stored)[0] === '#123456');
    await open('secondary');
    check('reopening initializes channels from the selected color', JSON.stringify(await Promise.all(channels.map(el => el.inputValue()))) === '["18","52","86"]');
    await channels[0].fill('200'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await frame();
    check('Cancel discards channel edits after an earlier accepted color', JSON.stringify(await snapshot()) === JSON.stringify(applied));
    await open();
    check('Edit colors offers RGB and HSV representations', await dialog.getByRole('combobox', { name: 'Color model', exact: true }).count() === 1);
    const model = dialog.getByRole('combobox', { name: 'Color model', exact: true });
    await page.locator('#hex').fill('#123456');
    await model.selectOption('hsv');
    const hsv = ['Hue', 'Saturation', 'Value'].map(name => dialog.getByRole('spinbutton', { name, exact: true }));
    check('HSV channels display the selected RGB color', JSON.stringify(await Promise.all(hsv.map(el => el.inputValue()))) === '["210","79","34"]');
    for (let i = 0; i < 3; i++) { await model.selectOption('rgb'); await model.selectOption('hsv'); }
    check('switching models preserves exact bytes despite rounded HSV labels', await page.locator('#hex').inputValue() === '#123456');
    await hsv[0].fill('240');
    check('editing hue preserves unedited saturation and value precision', await page.locator('#hex').inputValue() === '#121256');
    for (const [hue, expected] of [[0, '#ff0000'], [60, '#ffff00'], [120, '#00ff00'], [180, '#00ffff'], [240, '#0000ff'], [300, '#ff00ff'], [359, '#ff0004']]) {
      await hsv[0].fill(String(hue)); await hsv[1].fill('100'); await hsv[2].fill('100');
      check(`HSV hue ${hue} produces its standard RGB color`, await page.locator('#hex').inputValue() === expected);
    }
    for (const [index, invalid] of [[0, '360'], [0, '-1'], [1, '101'], [2, ''], [2, '1.5']]) {
      const before = await page.locator('#hex').inputValue();
      await hsv[index].fill(invalid); await accept();
      check(`invalid HSV channel ${index} value ${JSON.stringify(invalid)} cannot commit`, await dialog.isVisible() && await page.locator('#hex').inputValue() === before);
      await hsv[index].fill(index === 0 ? '240' : '100');
    }
    await hsv[0].fill('240'); await hsv[1].fill('100'); await hsv[2].fill('0');
    await model.selectOption('rgb'); await model.selectOption('hsv');
    check('black retains hue and saturation while switching representations', await hsv[0].inputValue() === '240' && await hsv[1].inputValue() === '100' && await page.locator('#hex').inputValue() === '#000000');
    await hsv[2].fill('50');
    check('raising value from black restores the chosen hue', await page.locator('#hex').inputValue() === '#000080');
    await hsv[1].fill('0');
    check('zero saturation creates neutral gray', await page.locator('#hex').inputValue() === '#808080');
    await hsv[1].fill('100');
    check('restoring saturation retains the chosen hue', await page.locator('#hex').inputValue() === '#000080');
    await hsv[0].fill(''); await model.selectOption('rgb');
    check('changing model discards incomplete hidden input without losing the valid color', await page.locator('#dialog form').evaluate(form => form.checkValidity()) && await page.locator('#hex').inputValue() === '#000080');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await open(); await channels[0].fill('1'); await channels[1].fill('2'); await channels[2].fill('3'); await channels[2].press('Enter'); await frame();
    check('Enter accepts channel edits through the same form owner', !await dialog.isVisible() && (await snapshot()).primary === 'rgb(1, 2, 3)');
  } finally {
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Restore this owned profile's palette and rebuild its in-memory palette owner.
    await page.evaluate(stored => stored === null ? localStorage.removeItem('paint-colors') : localStorage.setItem('paint-colors', stored), initial.stored);
    await page.reload(); await page.locator('#overlay').waitFor();
  }
  check('color fixture restores the pristine document and saved palette', JSON.stringify(await snapshot()) === JSON.stringify(initial));
}

export async function verifyColorInputs(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyColorInputsDesktop(target, check);
  } finally { await context.close(); }
}
