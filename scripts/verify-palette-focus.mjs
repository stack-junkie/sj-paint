// Public keyboard, pointer and dialog paths. Storage restoration followed by a
// reload restores the palette owner's in-memory state as well as its persistence.
export async function verifyPaletteFocusDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await page.evaluate(() => {
    const color = selector => {
      const c = document.createElement('canvas').getContext('2d'); c.fillStyle = document.querySelector(selector).style.background;
      c.fillRect(0, 0, 1, 1);
      return '#' + [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
    };
    const active = document.activeElement, slots = [...document.querySelectorAll('#custom-colors button')];
    const focus = slots.includes(active) ? { slot: slots.indexOf(active) } : active?.id ? { id: active.id }
      : active?.dataset.action ? { action: active.dataset.action } : active?.dataset.tool ? { tool: active.dataset.tool } : null;
    return { stored: localStorage.getItem('paint-colors'), slots: slots.map(el => ({ color: el.dataset.color, action: el.dataset.action, label: el.getAttribute('aria-label'), title: el.title })),
      pixels: document.querySelector('#canvas').toDataURL(), primary: color('#primary'), secondary: color('#secondary'),
      tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool, label: document.querySelector('#tool-label').textContent,
      zoom: document.querySelector('#zoom-presets').value, size: document.querySelector('#size-number').value,
      outline: document.querySelector('#outline').value, fill: document.querySelector('#shape-fill').value,
      layers: !document.querySelector('#layers-panel').hidden,
      scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
      focus, selection: typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null,
      clean: document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152 && document.querySelector('#canvas').height === 648 &&
        document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled &&
        !document.querySelector('.text-editor') && document.querySelector('#opacity').value === '100' && document.querySelector('#tolerance').value === '0' &&
        document.querySelector('#font').value === 'Arial' && document.querySelector('#font-size').value === '24' &&
        document.querySelector('[data-text-align][aria-pressed="true"]').dataset.textAlign === 'left' && !document.querySelector('#text-background').checked &&
        ['bold', 'italic', 'underline', 'strikethrough'].every(name => !document.querySelector(`[data-action="${name}"]`).classList.contains('active')) };
  });
  if (!initial.clean) throw new Error('Palette focus checks require a pristine default document, full drawing opacity and default text settings.');
  for (const color of [initial.primary, initial.secondary]) {
    if (!await page.locator(`[data-color="${color}"]`).count()) throw new Error('Palette checks require palette-restorable initial colors.');
  }
  const slots = page.locator('#custom-colors button');
  const inspect = handle => handle.evaluate(el => ({ connected: el.isConnected, focused: document.activeElement === el,
    active: document.activeElement.tagName, color: el.dataset.color, action: el.dataset.action }));
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox(), zoom = Number(await page.locator('#zoom-presets').inputValue());
    await page.mouse.move(box.x + x * zoom, box.y + y * zoom); await frame();
  };
  const acceptColor = async value => {
    await page.locator('#dialog[open]').waitFor(); await page.locator('#hex').fill(value);
    await page.locator('#dialog button[type="submit"]').click(); await frame();
  };
  try {
    // Exercise an empty slot becoming a color without replacing its button.
    // Only this owned profile's palette key changes during fixture setup.
    await page.evaluate(() => localStorage.removeItem('paint-colors'));
    await page.reload(); await page.locator('#custom-colors button').first().waitFor();
    await slots.first().focus(); const empty = await slots.first().elementHandle();
    await page.keyboard.press('Enter'); await acceptColor('#123456');
    const populated = await inspect(empty);
    record('keyboard-created custom color keeps its slot node and returns focus to it',
      populated.connected && populated.focused && populated.color === '#123456' && populated.action === undefined, populated);

    for (const key of ['Enter', 'Space']) {
      await slots.first().focus(); const selected = await slots.first().elementHandle();
      await page.keyboard.press(key); await frame(); const result = await inspect(selected);
      record(`${key} on a custom color retains its node and keyboard focus`, result.connected && result.focused, result);
    }
    await slots.first().focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    record('Tab after custom-color activation advances to the next palette slot', await slots.nth(1).evaluate(el => document.activeElement === el));

    await page.locator('[data-tool="curve"]').click();
    await move(30, 40); await page.mouse.down(); await move(170, 100); await page.mouse.up(); await frame();
    await slots.first().focus(); const hovered = await slots.first().elementHandle();
    await move(100, 20); const passive = await inspect(hovered);
    record('passive curve preview rendering preserves focused custom-color identity', passive.connected && passive.focused, passive);
    await page.keyboard.press('Escape'); await frame();
    record('canceling the curve preserves palette focus and removes pending work',
      (await inspect(hovered)).focused && await page.locator('[data-action="undo"]').isDisabled());

    await slots.nth(1).focus(); const second = await slots.nth(1).elementHandle();
    await page.keyboard.press('Enter'); await acceptColor('#654321');
    const shifted = await inspect(second);
    record('adding a color updates the focused slot in place when earlier colors shift',
      shifted.connected && shifted.focused && shifted.color === '#123456' && shifted.action === undefined, shifted);
    record('custom slots keep stable labels and exclude conflicting actions', await slots.evaluateAll(elements =>
      elements.length === 10 && elements.every((el, index) => el.getAttribute('aria-label') === `Custom color ${index + 1}` &&
        (index < 2 ? Boolean(el.dataset.color) && !el.dataset.action : !el.dataset.color && el.dataset.action === 'colors'))));

    // Keyboard formatting announces its pressed state without taking focus.
    await page.locator('[data-tool="text"]').click();
    for (const action of ['bold', 'italic', 'underline', 'strikethrough']) {
      const button = page.locator(`[data-action="${action}"]`); await button.focus(); await page.keyboard.press('Space'); await frame();
      record(`${action} exposes its enabled pressed state and retains keyboard focus`,
        await button.getAttribute('aria-pressed') === 'true' && await button.evaluate(el => document.activeElement === el));
      await page.keyboard.press('Space'); await frame();
      record(`${action} exposes its disabled pressed state`, await button.getAttribute('aria-pressed') === 'false');
    }
  } finally {
    if (await page.locator('#dialog').evaluate(el => el.open)) await page.locator('#dialog-cancel').click();
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up(); await frame();
    await page.evaluate(stored => { if (stored === null) localStorage.removeItem('paint-colors'); else localStorage.setItem('paint-colors', stored); }, initial.stored);
    if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Palette storage was restored, but unexpected document history prevents a safe renderer reload.');
    await page.reload(); await page.locator('#custom-colors button').first().waitFor();
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
    await page.locator(`[data-color="${initial.primary}"]`).first().click(); await page.locator(`[data-color="${initial.secondary}"]`).first().click({ button: 'right' });
    await page.locator('#size-number').fill(initial.size); await page.locator('#size-number').press('Tab');
    await page.locator('#outline').selectOption(initial.outline); await page.locator('#shape-fill').selectOption(initial.fill);
    if (await page.locator('#layers-panel').isVisible() !== initial.layers) await page.locator('.layers-group [data-action="layers"]').click();
    const hasZoom = await page.locator('#zoom-presets option').evaluateAll((options, value) => options.some(option => option.value === value), initial.zoom);
    if (hasZoom) await page.locator('#zoom-presets').selectOption(initial.zoom);
    else await page.getByRole('button', { name: 'Fit to window', exact: true }).click();
    await frame(); await page.locator('#viewport').evaluate((el, scroll) => { [el.scrollLeft, el.scrollTop] = scroll; }, initial.scroll);
    if (initial.focus) {
      const focus = initial.focus, target = focus.slot !== undefined ? slots.nth(focus.slot) : focus.id ? page.locator(`[id="${focus.id}"]`)
        : focus.action ? page.locator(`[data-action="${focus.action}"]`).first() : page.locator(`[data-tool="${focus.tool}"]`);
      await target.focus();
      if (initial.selection) await target.evaluate((el, selection) => el.setSelectionRange(...selection), initial.selection);
    } else await page.evaluate(() => document.activeElement?.blur());
  }
  const restored = await page.evaluate(() => ({ stored: localStorage.getItem('paint-colors'), pixels: document.querySelector('#canvas').toDataURL(),
    slots: [...document.querySelectorAll('#custom-colors button')].map(el => ({ color: el.dataset.color, action: el.dataset.action, label: el.getAttribute('aria-label'), title: el.title })) }));
  record('palette fixture restores stored colors, slot contents and blank document history',
    restored.stored === initial.stored && JSON.stringify(restored.slots) === JSON.stringify(initial.slots) && restored.pixels === initial.pixels &&
    await page.locator('[data-action="undo"]').isDisabled() && await page.locator('[data-action="redo"]').isDisabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyPaletteFocus(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyPaletteFocusDesktop(target, check);
  } finally { await context.close(); }
}
