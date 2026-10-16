// Public controls with a real mouse pan. Cancellation/blur notifications that
// need another device or desktop window are explicitly simulated on that owner.
export async function verifyTextPanFocusDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await page.evaluate(() => ({
    pixels: document.querySelector('#canvas').toDataURL(),
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent, zoom: document.querySelector('#zoom-presets').value,
    scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
    clean: document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152 &&
      document.querySelector('#canvas').height === 648 && document.querySelector('[data-action="undo"]').disabled &&
      document.querySelector('[data-action="redo"]').disabled && !document.querySelector('.text-editor'),
  }));
  if (!initial.clean) throw new Error('Text pan checks require a pristine default-size Untitled document.');
  const snapshot = () => page.evaluate(() => {
    const editor = document.querySelector('.text-editor');
    return { text: editor?.value, focused: document.activeElement === editor,
      selection: editor ? [editor.selectionStart, editor.selectionEnd, editor.selectionDirection] : null,
      active: document.activeElement?.dataset.action || document.activeElement?.id || document.activeElement?.tagName,
      tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
      pixels: document.querySelector('#canvas').toDataURL(), scroll: document.querySelector('#viewport').scrollTop };
  });
  const focusDetail = ({ pixels, ...detail }) => detail;
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.move(box.x + x, box.y + y); await frame();
  };
  const reset = async () => {
    await page.keyboard.up('Alt'); await page.keyboard.press('Escape');
    await page.mouse.up(); await page.mouse.up({ button: 'middle' });
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await frame();
    // This helper owns every history entry by its pristine-document precondition.
    for (let i = 0; i < 8 && await page.locator('[data-action="undo"]').isEnabled(); i++) {
      await page.keyboard.press('Control+z'); await frame();
    }
    if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Text pan cleanup exceeded its owned history bound.');
    await page.keyboard.press('Control+n'); await frame();
    await page.locator('#zoom-presets').selectOption({ label: '100%' }); await frame();
    await page.locator('#viewport').evaluate(el => { el.scrollTop = 0; el.scrollLeft = 0; });
  };
  const draft = async () => {
    await reset(); await page.locator('[data-tool="text"]').click();
    await move(30, 30); await page.mouse.down(); await page.mouse.up(); await page.keyboard.type('Draft');
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await frame();
    const before = await snapshot();
    if (!before.focused || before.text !== 'Draft' || before.selection[0] !== 1 || before.selection[1] !== 3) {
      throw new Error('Text pan fixture failed to create and select its draft.');
    }
    return before;
  };
  const pan = async (mode, ending) => {
    await move(500, 320);
    const box = await page.locator('#overlay').boundingBox();
    if (mode === 'Alt') await page.keyboard.down('Alt');
    await page.mouse.down({ button: mode === 'Alt' ? 'left' : 'middle' });
    await page.mouse.move(box.x + 500, box.y + 280); await frame();
    let focusEvents = null;
    if (ending === 'Escape') await page.keyboard.press('Escape');
    else if (ending === 'blur') focusEvents = await page.evaluate(() => {
      let count = 0; const onFocus = () => count++;
      document.addEventListener('focusin', onFocus);
      try { window.dispatchEvent(new Event('blur')); } finally { document.removeEventListener('focusin', onFocus); }
      return count;
    });
    else if (ending !== 'release') await page.locator('#overlay').evaluate((el, type) => {
      const pointerId = Array.from({ length: 32 }, (_, index) => index).find(id => el.hasPointerCapture(id));
      if (pointerId === undefined) throw new Error('The owned mouse pan did not capture its pointer.');
      el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, pointerType: 'mouse' }));
    }, ending);
    await page.mouse.up({ button: mode === 'Alt' ? 'left' : 'middle' });
    if (mode === 'Alt') await page.keyboard.up('Alt');
    await frame(); return focusEvents;
  };
  try {
    for (const [mode, ending] of [['middle', 'release'], ['Alt', 'release'], ['middle', 'Escape'],
      ['middle', 'pointercancel'], ['Alt', 'lostpointercapture'], ['middle', 'blur']]) {
      const before = await draft(), name = `${mode} text pan ${ending}`;
      const focusEvents = await pan(mode, ending), after = await snapshot();
      record(`${name} preserves text focus, selection and pixels while scrolling`,
        after.scroll > before.scroll && after.focused && after.text === before.text &&
        JSON.stringify(after.selection) === JSON.stringify(before.selection) && after.pixels === before.pixels, focusDetail(after));
      if (ending === 'blur') record('simulated pan blur performs no focus-changing operation', focusEvents === 0, focusEvents);
      await page.keyboard.type('p'); await frame(); const typed = await snapshot();
      record(`${name} continues typing into the selected range without choosing Pencil`,
        typed.text === 'Dpft' && typed.focused && typed.tool === 'text' && typed.pixels === before.pixels, focusDetail(typed));
      let history = false;
      if (await page.locator('.text-editor').count()) {
        await page.locator('[data-action="commit-text"]').click(); await frame(); const committed = await snapshot();
        await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
        const undone = await snapshot(), singleUndo = await page.locator('[data-action="undo"]').isDisabled();
        await page.keyboard.press('Control+y'); await frame();
        history = committed.pixels !== before.pixels && undone.pixels === before.pixels && singleUndo &&
          (await snapshot()).pixels === committed.pixels;
      }
      record(`${name} remains one text operation through Undo and Redo`, history);
    }

    const beforeToolbar = await draft();
    await page.locator('[data-action="bold"]').focus(); await page.keyboard.press('Tab');
    const intentional = await snapshot(); await pan('middle', 'release'); const afterToolbar = await snapshot();
    record('panning preserves deliberate keyboard focus on a formatting control',
      intentional.active === 'italic' && afterToolbar.active === intentional.active && !afterToolbar.focused &&
      afterToolbar.text === beforeToolbar.text && JSON.stringify(afterToolbar.selection) === JSON.stringify(beforeToolbar.selection), focusDetail(afterToolbar));
  } finally {
    await reset();
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitem', { name: initial.label, exact: true }).click(); }
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    await page.locator('#viewport').evaluate((el, scroll) => { [el.scrollLeft, el.scrollTop] = scroll; }, initial.scroll);
  }
  record('text pan fixture restores blank pixels and clean history', (await snapshot()).pixels === initial.pixels &&
    await page.locator('[data-action="undo"]').isDisabled() && await page.locator('[data-action="redo"]').isDisabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyTextPanFocus(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyTextPanFocusDesktop(target, check);
  } finally { await context.close(); }
}
