// Public text controls and renderer observations, shared with the hidden desktop harness.
export async function verifyTextControlsDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await page.evaluate(() => ({
    pixels: document.querySelector('#canvas').toDataURL(), tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent, zoom: document.querySelector('#zoom-presets').value,
    fontSize: document.querySelector('#font-size').value,
    align: document.querySelector('[data-text-align][aria-pressed="true"]').dataset.textAlign,
    scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
    clean: document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152 &&
      document.querySelector('#canvas').height === 648 && document.querySelector('[data-action="undo"]').disabled &&
      document.querySelector('[data-action="redo"]').disabled && !document.querySelector('.text-editor'),
  }));
  if (!initial.clean) throw new Error('Text control checks require a pristine default-size Untitled document.');
  const snapshot = () => page.evaluate(() => {
    const input = document.querySelector('#font-size'), editor = document.querySelector('.text-editor');
    return { value: input.value, valid: input.validity.valid, fontSize: editor ? parseFloat(getComputedStyle(editor).fontSize) : null,
      text: editor?.value, selection: editor ? [editor.selectionStart, editor.selectionEnd, editor.selectionDirection] : null,
      focused: document.activeElement === editor, focus: document.activeElement?.dataset.action || document.activeElement?.id,
      align: editor ? getComputedStyle(editor).textAlign : null, focusedAlignment: document.activeElement?.dataset.textAlign,
      pressed: [...document.querySelectorAll('[data-text-align]')].map(el => [el.dataset.textAlign, el.getAttribute('aria-pressed')]),
      pixels: document.querySelector('#canvas').toDataURL() };
  });
  const detail = ({ pixels, ...state }) => state;
  const reset = async () => {
    await page.keyboard.press('Escape'); await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await frame();
    for (let i = 0; i < 8 && await page.locator('[data-action="undo"]').isEnabled(); i++) {
      await page.keyboard.press('Control+z'); await frame();
    }
    if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Text control cleanup exceeded its owned history bound.');
    await page.keyboard.press('Control+n'); await frame();
    await page.locator('#zoom-presets').selectOption({ label: '100%' }); await frame();
    await page.locator('#viewport').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
  };
  const draft = async () => {
    await reset(); await page.locator('[data-tool="text"]').click();
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.click(box.x + 30, box.y + 30);
    await page.keyboard.type('Draft'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await frame();
    const before = await snapshot();
    if (!before.focused || before.text !== 'Draft' || before.selection[0] !== 1 || before.selection[1] !== 3) {
      throw new Error('Text control fixture failed to select its draft.');
    }
    return before;
  };
  const roundtrip = async baseline => {
    await page.locator('[data-action="commit-text"]').click(); await frame(); const committed = await snapshot();
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
    const undone = await snapshot(), single = await page.locator('[data-action="undo"]').isDisabled();
    await page.keyboard.press('Control+y'); await frame();
    return committed.pixels !== baseline && undone.pixels === baseline && single && (await snapshot()).pixels === committed.pixels;
  };
  const chosen = (state, value) => state.pressed.length === 3 && state.pressed.every(([name, pressed]) => pressed === String(name === value));
  try {
    const before = await draft();
    for (const [entered, accepted] of [['1000', 500], ['5', 6], ['', 24], ['36', 36], ['24.5', 24.5]]) {
      await page.locator('#font-size').fill(entered); await page.locator('#font-size').press('Tab'); await frame();
      const changed = await snapshot(), label = entered === '' ? 'empty' : entered;
      record(`font size ${label} displays its accepted rendering value ${accepted}`,
        changed.value === String(accepted) && changed.fontSize === accepted && changed.valid, detail(changed));
      record(`font size ${label} preserves text selection and deliberate keyboard focus`,
        changed.text === before.text && JSON.stringify(changed.selection) === JSON.stringify(before.selection) &&
        changed.focus === 'bold' && !changed.focused && changed.pixels === before.pixels, detail(changed));
    }
    await page.locator('.text-editor').focus(); await page.keyboard.type('p'); await frame();
    record('typing after returning from font-size editing replaces the retained selection', (await snapshot()).text === 'Dpft');
    record('fractional font-size editing and continued typing remain one undoable text operation', await roundtrip(before.pixels));

    if (await page.locator('[data-text-align]').count() !== 3) throw new Error('Text alignment requires three public pressed-state buttons.');
    record('alignment controls form one named group', await page.locator('#text-align').getAttribute('role') === 'group' &&
      Boolean(await page.locator('#text-align').getAttribute('aria-label')));
    for (const value of ['left', 'center', 'right']) {
      const prior = await draft(); await page.locator(`[data-text-align="${value}"]`).click(); await frame();
      const changed = await snapshot();
      record(`pointer ${value} alignment retains text focus and selection and announces the chosen value`,
        changed.focused && changed.align === value && chosen(changed, value) && changed.text === prior.text &&
        JSON.stringify(changed.selection) === JSON.stringify(prior.selection) && changed.pixels === prior.pixels, detail(changed));
      await page.keyboard.type('p'); await frame();
      record(`pointer ${value} alignment keeps subsequent typing inside the selected draft`, (await snapshot()).text === 'Dpft');
      record(`${value} aligned text preserves one-operation Undo and Redo`, await roundtrip(prior.pixels));

      const keyboardPrior = await draft(), button = page.locator(`[data-text-align="${value}"]`);
      await button.focus(); await page.keyboard.press(value === 'center' ? 'Space' : 'Enter'); await frame();
      const keyboard = await snapshot();
      record(`keyboard ${value} alignment retains deliberate button focus and the selected draft`,
        keyboard.focusedAlignment === value && !keyboard.focused && keyboard.align === value && chosen(keyboard, value) &&
        keyboard.text === keyboardPrior.text && JSON.stringify(keyboard.selection) === JSON.stringify(keyboardPrior.selection) &&
        keyboard.pixels === keyboardPrior.pixels, detail(keyboard));
      await page.keyboard.press('Escape'); await frame();
      record(`canceling ${value} aligned draft leaves no pixels or history`, !await page.locator('.text-editor').count() &&
        (await snapshot()).pixels === keyboardPrior.pixels && await page.locator('[data-action="undo"]').isDisabled() &&
        await page.locator('[data-action="redo"]').isDisabled());
    }
  } finally {
    await reset(); await page.locator('[data-tool="text"]').click();
    await page.locator('#font-size').fill(initial.fontSize); await page.locator('#font-size').press('Tab');
    await page.locator(`[data-text-align="${initial.align}"]`).click();
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    await page.locator('#viewport').evaluate((el, scroll) => { [el.scrollLeft, el.scrollTop] = scroll; }, initial.scroll);
  }
  record('text controls fixture restores blank pixels, settings and clean history', (await snapshot()).pixels === initial.pixels &&
    await page.locator('#font-size').inputValue() === initial.fontSize &&
    (await page.locator('[data-text-align][aria-pressed="true"]').getAttribute('data-text-align')) === initial.align &&
    await page.locator('[data-action="undo"]').isDisabled() && await page.locator('[data-action="redo"]').isDisabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyTextControls(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyTextControlsDesktop(target, check);
  } finally { await context.close(); }
}
