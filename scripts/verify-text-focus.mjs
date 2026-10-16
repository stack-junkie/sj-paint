// Public controls only, shared by the browser and owned packaged-app checks.
// These establish draft focus and history ownership, not native Paint parity.
export async function verifyTextFocusDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const editor = page.locator('.text-editor');
  const initial = await page.evaluate(() => {
    const color = selector => {
      const c = document.createElement('canvas').getContext('2d');c.fillStyle = document.querySelector(selector).style.background;c.fillRect(0,0,1,1);
      return '#' + [...c.getImageData(0,0,1,1).data].slice(0,3).map(value=>value.toString(16).padStart(2,'0')).join('');
    };
    return {
    pixels: document.querySelector('#canvas').toDataURL(),
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent,
    zoom: document.querySelector('#zoom-presets').value,
    primary: color('#primary'), secondary: color('#secondary'),
    styles: Object.fromEntries(['bold', 'italic', 'underline', 'strikethrough'].map(name =>
      [name, document.querySelector(`[data-action="${name}"]`).classList.contains('active')])),
    opaque: document.querySelector('#text-background').checked,
    clean: document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled,
  }; });
  if (!initial.clean) throw new Error('Text focus checks require a fresh document with no history.');
  for (const color of [initial.primary, initial.secondary]) {
    if (!await page.locator(`[data-color="${color}"]`).count()) throw new Error('Text focus checks require palette-restorable colors.');
  }
  const snapshot = () => page.evaluate(() => {
    const el = document.querySelector('.text-editor');
    return { value: el?.value, start: el?.selectionStart, end: el?.selectionEnd,
      focused: el === document.activeElement,
      tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
      active: document.activeElement?.dataset.action || document.activeElement?.id,
      pixels: document.querySelector('#canvas').toDataURL() };
  });
  const draft = async () => {
    await page.keyboard.press('Escape');
    await page.locator('[data-tool="text"]').click();
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x + 24, bounds.y + 24);
    if (!await editor.evaluate(el => el === document.activeElement)) throw new Error('Creating text must focus its editor before typing.');
    await page.keyboard.type('Draft');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await frame();
  };
  // Failed pre-fix cases may have committed text by invoking a tool shortcut.
  const reset = async () => {
    if (await page.locator('#dialog').evaluate(el => el.open)) await page.locator('#dialog-cancel').click();
    await page.keyboard.press('Escape');
    await page.locator('#overlay').focus();
    for (let i = 0; i < 8 && await page.locator('[data-action="undo"]').isEnabled(); i++) {
      await page.keyboard.press('Control+z'); await frame();
    }
    await page.keyboard.press('Control+n'); await frame();
    if (await page.locator('#dialog').evaluate(el => el.open)) throw new Error('Owned text fixture did not return to a clean document.');
  };
  try {
    for (const action of ['bold', 'italic', 'underline', 'strikethrough']) {
      await draft(); const before = await snapshot();
      await page.locator(`[data-action="${action}"]`).click();
      const styled = await snapshot();
      record(`pointer ${action} restores draft focus and the selected text`,
        styled.focused && styled.start === 1 && styled.end === 3 && styled.value === before.value, styled);
      await page.keyboard.type('p'); await frame(); const typed = await snapshot();
      record(`typing after ${action} replaces the selection without selecting Pencil`,
        typed.value === 'Dpft' && typed.tool === 'text' && typed.pixels === before.pixels, typed);
      await reset();
    }

    for (const button of ['left', 'right']) {
      await draft();
      await page.locator('[data-color="#ed1c24"]').click({ button });
      await page.keyboard.type('t'); await frame(); const typed = await snapshot();
      record(`${button} palette activation retains text selection and typing`,
        typed.value === 'Dtft' && typed.focused && typed.tool === 'text', typed);
      await reset();
    }

    await draft(); await page.locator('#text-background').click();
    await page.keyboard.type('b'); await frame(); const opaque = await snapshot();
    record('pointer opaque-background toggle retains typing in the selected draft text',
      opaque.value === 'Dbft' && opaque.focused && opaque.tool === 'text', opaque);
    await reset();

    for (const accept of [false, true]) {
      await draft(); await page.getByRole('button', { name: 'Edit colors', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#dialog').open);
      if (accept) { await page.locator('#hex').fill('#123456'); await page.locator('#dialog button[type="submit"]').click(); }
      else await page.locator('#dialog-cancel').click();
      await page.keyboard.type('s'); await frame(); const typed = await snapshot();
      record(`${accept ? 'accepting' : 'canceling'} pointer-opened colors restores draft selection and typing`,
        typed.value === 'Dsft' && typed.focused && typed.tool === 'text', typed);
      await reset();
    }

    await draft();
    // The public Tab sequence deliberately moves keyboard focus to formatting.
    await page.locator('[data-action="bold"]').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const keyboard = await snapshot();
    record('keyboard formatting keeps deliberate toolbar focus and the live draft',
      keyboard.active === 'italic' && !keyboard.focused && keyboard.value === 'Draft', keyboard);
    await page.keyboard.press('Control+y');
    record('Redo from a keyboard-focused formatting button retains the text draft',
      (await snapshot()).value === 'Draft');
    await reset();

    await draft(); const blank = (await snapshot()).pixels;
    await page.locator('[data-action="bold"]').click(); await page.keyboard.type('p');
    if (await editor.count()) {
      await page.locator('[data-action="commit-text"]').click(); await frame();
      const committed = (await snapshot()).pixels;
      record('formatting and continued typing commit visible text once', committed !== blank && !await editor.count());
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
      record('one Undo removes the complete formatted text session', (await snapshot()).pixels === blank);
      await page.keyboard.press('Control+y'); await frame();
      record('Redo restores the formatted text session pixels', (await snapshot()).pixels === committed);
    } else record('formatting and continued typing commit visible text once', false, 'Draft was committed by a tool shortcut.');
  } finally {
    await reset();
    await page.locator('[data-tool="text"]').click();
    for (const [action, enabled] of Object.entries(initial.styles)) {
      if (await page.locator(`[data-action="${action}"]`).evaluate(el => el.classList.contains('active')) !== enabled)
        await page.locator(`[data-action="${action}"]`).click();
    }
    if (await page.locator('#text-background').isChecked() !== initial.opaque) {
      await page.locator('[data-tool="text"]').click(); await page.locator('#text-background').click();
    }
    await page.locator(`[data-color="${initial.primary}"]`).click();
    await page.locator(`[data-color="${initial.secondary}"]`).click({ button: 'right' });
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitem', { name: initial.label, exact: true }).click(); }
    await page.locator('#zoom-presets').selectOption(initial.zoom);
    await frame();
  }
  record('text focus fixture restores blank pixels and clean history',
    (await snapshot()).pixels === initial.pixels && !await page.locator('[data-action="undo"]').isEnabled() && !await page.locator('[data-action="redo"]').isEnabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyTextFocus(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url());
    await target.waitForFunction(() => document.querySelector('#overlay')?.width === 1152);
    await verifyTextFocusDesktop(target, check);
  } finally { await context.close(); }
}
