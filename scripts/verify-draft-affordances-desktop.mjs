// Public renderer controls only. The caller supplies a pristine default document.
export async function verifyDraftAffordancesDesktop(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(),
    title: document.title, status: document.querySelector('#document-state').textContent,
    undoDisabled: document.querySelector('[data-action="undo"]').disabled,
    redoDisabled: document.querySelector('[data-action="redo"]').disabled,
    text: document.querySelector('.text-editor')?.value }));
  const initial = await page.evaluate(() => ({ tool: document.querySelector('[data-tool].active')?.dataset.tool || 'brush',
    zoom: document.querySelector('#zoom-presets').value,
    scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop] }));
  const baseline = await snapshot();
  check('desktop draft affordance fixture starts with a pristine default document',
    baseline.undoDisabled && baseline.redoDisabled && baseline.title === 'Untitled - Stack Junkie Paint' && baseline.status === '');
  const move = async (x, y) => {
    const bounds = await page.locator('#overlay').boundingBox();
    const zoom = Number(await page.locator('#zoom-presets').inputValue());
    await page.mouse.move(bounds.x + x * zoom, bounds.y + y * zoom);
  };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); };
  const clean = value => value.pixels === baseline.pixels && value.title === baseline.title &&
    value.status === baseline.status && value.undoDisabled && value.text === undefined;
  const choose = async tool => {
    if (tool === 'brush') {
      await page.locator('[data-menu="brushes"]').click(); await page.locator('[data-command="tool:brush"]').click();
    } else await page.locator(`[data-tool="${tool}"]`).click();
  };
  try {
    for (const tool of ['curve', 'polygon']) {
      await choose(tool);
      if (tool === 'curve') {
        await move(30, 60); await page.mouse.down(); await move(170, 100); await page.mouse.up();
      } else {
        await click(30, 30); await click(170, 30); await click(100, 130);
      }
      await frame(); const draft = await snapshot();
      check(`desktop ${tool} draft is visible and exposes Undo and unsaved indicators`,
        draft.pixels !== baseline.pixels && !draft.undoDisabled && draft.title.includes(' •') &&
        draft.status === 'Unsaved changes' && draft.redoDisabled);
      if (!draft.undoDisabled) await page.locator('[data-action="undo"]').click();
      await frame(); const canceled = await snapshot();
      check(`desktop toolbar Undo cancels ${tool} without leaving pixels or history`, clean(canceled) && canceled.redoDisabled);
      await choose('pencil'); await frame(); const switched = await snapshot();
      check(`desktop switching tools cannot revive the canceled ${tool}`, clean(switched) && switched.redoDisabled);
    }
    await choose('text'); await click(30, 30);
    await page.locator('.text-editor').fill('Pending text'); await frame(); const typed = await snapshot();
    check('desktop text input immediately enables Undo and reports unsaved work',
      typed.text === 'Pending text' && !typed.undoDisabled && typed.title.includes(' •') && typed.status === 'Unsaved changes');
    await page.locator('.text-editor').press('Control+a'); await page.locator('.text-editor').press('Backspace');
    await frame(); const erased = await snapshot();
    check('desktop erasing all draft text restores clean indicators and disables Undo',
      erased.text === '' && erased.undoDisabled && erased.redoDisabled && erased.pixels === baseline.pixels &&
      erased.title === baseline.title && erased.status === baseline.status);
    await page.locator('.text-editor').fill('Undo this text'); await frame(); const typedAgain = await snapshot();
    if (!typedAgain.undoDisabled) await page.locator('[data-action="undo"]').click();
    await frame(); const undone = await snapshot();
    check('desktop toolbar Undo removes the text editor and restores clean saved pixels', clean(undone) && !undone.redoDisabled);
  } finally {
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    // Only this fixture owns history: its entry precondition is a pristine document.
    for (let attempt = 0; attempt < 8 && await page.locator('[data-action="undo"]').isEnabled(); attempt++) {
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
    }
    await page.waitForFunction(value => document.querySelector('#canvas').toDataURL() === value &&
      document.querySelector('#document-state').textContent === '', baseline.pixels, { polling: 100 });
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+n');
    await page.waitForFunction(() => document.title === 'Untitled - Stack Junkie Paint' &&
      document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled,
      null, { polling: 100 });
    await choose(initial.tool); await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    await page.locator('#viewport').evaluate((viewport, scroll) => {
      viewport.scrollLeft = scroll[0]; viewport.scrollTop = scroll[1];
    }, initial.scroll);
  }
}
