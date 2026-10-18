// Public menu and drawing controls only. The desktop caller owns a fresh profile
// and a pristine default document; no host clipboard or private editor API is used.
export async function verifySelectionMenuDesktop(page, check) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => {
    const canvas = document.querySelector('#canvas'), ctx = canvas.getContext('2d');
    return { pixels: canvas.toDataURL(), inside: [...ctx.getImageData(80, 80, 1, 1).data],
      outside: [...ctx.getImageData(260, 80, 1, 1).data],
      selection: document.querySelector('#selection-size').textContent,
      undo: !document.querySelector('[data-action="undo"]').disabled,
      redo: !document.querySelector('[data-action="redo"]').disabled };
  });
  const initial = await page.evaluate(() => ({
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent,
    size: document.querySelector('#size-number').value, zoom: document.querySelector('#zoom-presets').value,
    scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
    clean: document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152 &&
      document.querySelector('#canvas').height === 648 && document.querySelector('[data-action="undo"]').disabled &&
      document.querySelector('[data-action="redo"]').disabled && !document.querySelector('.text-editor') &&
      getComputedStyle(document.querySelector('#primary')).backgroundColor === 'rgb(0, 0, 0)' &&
      document.querySelector('#opacity').value === '100',
  }));
  if (!initial.clean) throw new Error('Selection menu checks require a pristine default document, black Color 1 and full opacity.');
  const blank = await snapshot();
  let transparencyToggles = 0;
  let brushMenuTiming = null;
  const open = async () => {
    if (!await page.locator('#menu').isHidden()) await page.keyboard.press('Escape');
    await page.locator('[data-menu="selection"]').click(); await frame();
  };
  const menuState = () => page.locator('#menu').evaluate(el => [...el.children].map(item => ({
    tag: item.tagName, name: item.querySelector('span')?.textContent, command: item.dataset.command,
    role: item.getAttribute('role'), checked: item.getAttribute('aria-checked'), disabled: item.disabled,
  })));
  const choose = async command => {
    await open(); await page.locator(`#menu [data-command="${command}"]`).click(); await frame();
  };
  const move = async (x, y) => {
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.move(box.x + x, box.y + y);
  };
  const drag = async (start, end) => {
    await move(...start); await page.mouse.down(); await move(...end); await page.mouse.up(); await frame();
  };
  const resetDocument = async () => {
    await page.keyboard.press('Escape'); await page.mouse.up();
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await frame();
    // All document history belongs to this fixture by its pristine precondition.
    for (let i = 0; i < 12 && await page.locator('[data-action="undo"]').isEnabled(); i++) {
      await page.keyboard.press('Control+z'); await frame();
    }
    if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Selection menu cleanup exceeded its owned history bound.');
    await page.keyboard.press('Control+n'); await frame();
  };
  const selectInside = async () => {
    await choose('tool:select'); await drag([30, 60], [140, 100]);
  };
  const history = async (before, after, name) => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame(); const undo = await snapshot();
    await page.keyboard.press('Control+y'); await frame(); const redo = await snapshot();
    record(`${name} restores exact pixels with Undo and Redo`, undo.pixels === before.pixels && redo.pixels === after.pixels);
  };
  try {
    await page.locator('#zoom-presets').selectOption('1'); await frame();
    await page.locator('#viewport').evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    await open(); const entries = await menuState();
    // Retained menu-controls-evidence.json: SelectionToolbar.xbf, Items scope 2949,
    // SHA-256 0fb1761c9162567fe8f925d35796571d914c4f433058d5f405aa24a9fed4329b.
    // Object select is an SJ addition here; its placement is not native-verified.
    // Exclude only this named extension, so other additions or baseline reordering fail.
    record('selection menu preserves resource-backed baseline labels, commands, order and separator',
      JSON.stringify(entries.filter(item => item.command !== 'object-select').map(item =>
        item.tag === 'HR' ? 'separator' : [item.name, item.command])) === JSON.stringify([
        ['Rectangle', 'tool:select'], ['Free-form', 'tool:lasso'], 'separator', ['Select all', 'select-all'],
        ['Invert selection', 'invert-selection'], ['Transparent selection', 'transparent-selection'], ['Delete', 'delete-selection'],
      ]), entries);
    const objectEntries = entries.filter(item => item.command === 'object-select');
    record('SJ Object select extension appears once as an enabled ordinary menu command',
      objectEntries.length === 1 && objectEntries[0].tag === 'BUTTON' && objectEntries[0].name === 'Object select' &&
      objectEntries[0].role === 'menuitem' && objectEntries[0].checked === null && objectEntries[0].disabled === false, objectEntries);
    await page.keyboard.press('Home');
    let objectReached = false;
    for (let step = 0; step < entries.length; step++) {
      if (await page.locator('#menu').evaluate(menu => menu.contains(document.activeElement) && document.activeElement.dataset.command === 'object-select')) {
        objectReached = true; break;
      }
      await page.keyboard.press('ArrowDown');
    }
    record('SJ Object select extension is reachable by keyboard without activation', objectReached);
    const deleteEntry = entries.find(item => item.command === 'delete-selection');
    record('selection menu Delete is disabled without a selection', Boolean(deleteEntry?.disabled), deleteEntry);
    await page.keyboard.press('End');
    record('keyboard menu navigation skips disabled selection Delete',
      await page.locator('#menu [data-command="transparent-selection"]').evaluate(el => document.activeElement === el));
    await page.keyboard.press('Escape');
    record('closing the selection menu leaves blank pixels and history unchanged',
      (await snapshot()).pixels === blank.pixels && !(await snapshot()).undo);

    for (const [tool, other] of [['select', 'lasso'], ['lasso', 'select']]) {
      await choose(`tool:${tool}`); await open(); const modes = await menuState();
      const selected = modes.find(item => item.command === `tool:${tool}`), unselected = modes.find(item => item.command === `tool:${other}`);
      record(`${tool} selection mode is the sole checked menu radio`, selected?.role === 'menuitemradio' &&
        selected.checked === 'true' && unselected?.role === 'menuitemradio' && unselected.checked === 'false', modes.slice(0, 2));
    }
    await page.keyboard.press('Escape'); await page.locator('[data-tool="pencil"]').click(); await open();
    record('selection mode radios clear when another tool is active', (await menuState())
      .filter(item => ['tool:select', 'tool:lasso'].includes(item.command)).every(item => item.checked === 'false'));

    for (const expected of [true, false]) {
      await choose('transparent-selection'); transparencyToggles++;
      await open(); const item = (await menuState()).find(entry => entry.command === 'transparent-selection');
      record(`transparent selection exposes checked=${expected} after reopening`, item?.role === 'menuitemcheckbox' &&
        item.checked === String(expected), item);
    }
    await page.keyboard.press('Escape');
    record('selection mode and transparency controls create no pixel history', (await snapshot()).pixels === blank.pixels && !(await snapshot()).undo);

    await page.locator('[data-tool="pencil"]').click();
    await page.locator('#size-number').fill('10'); await page.locator('#size-number').press('Tab');
    await drag([40, 80], [120, 80]); await drag([220, 80], [300, 80]);
    const drawn = await snapshot();
    if (drawn.inside[0] !== 0 || drawn.outside[0] !== 0) throw new Error('Selection menu fixture did not draw both black marks.');
    await open(); const noSelectionDelete = (await menuState()).find(item => item.command === 'delete-selection');
    record('selection menu Delete stays disabled on painted pixels without a selection', Boolean(noSelectionDelete?.disabled), noSelectionDelete);
    await page.keyboard.press('Delete'); await frame(); const ignoredDelete = await snapshot();
    record('Delete key in the selection menu cannot clear pixels without a selection', ignoredDelete.pixels === drawn.pixels);
    await page.keyboard.press('Escape');
    if (ignoredDelete.pixels !== drawn.pixels) {
      // Keep the remaining assertions independent when this guard regresses.
      await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
    }

    await selectInside(); await open(); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await frame();
    record('Escape cancels the selection without deleting painted pixels', (await snapshot()).pixels === drawn.pixels && !(await snapshot()).selection);
    await selectInside(); await open();
    const selectedDelete = (await menuState()).find(item => item.command === 'delete-selection');
    record('selection menu Delete becomes enabled for selected pixels', Boolean(selectedDelete && !selectedDelete.disabled), selectedDelete);
    // End must reach the final enabled Delete command through the public menu.
    await page.keyboard.press('End');
    record('keyboard menu navigation reaches selection Delete', await page.locator('#menu [data-command="delete-selection"]').evaluate(el => document.activeElement === el));
    await page.keyboard.press('Enter'); await frame(); const deleted = await snapshot();
    record('selection Delete removes only selected pixels', deleted.inside[0] === 255 &&
      JSON.stringify(deleted.outside) === JSON.stringify(drawn.outside) && !deleted.selection, deleted.inside);
    await history(drawn, deleted, 'Selection Delete');

    await page.keyboard.press('Control+z'); await frame(); await page.keyboard.press('Escape');
    await selectInside(); await choose('invert-selection'); await choose('delete-selection');
    const inverted = await snapshot();
    record('inverted selection Delete preserves inside pixels and deletes outside pixels',
      JSON.stringify(inverted.inside) === JSON.stringify(drawn.inside) && inverted.outside[0] === 255, { inside: inverted.inside, outside: inverted.outside });
    await history(drawn, inverted, 'Inverted selection Delete');

    await page.keyboard.press('Control+z'); await frame(); await page.keyboard.press('Escape');
    await choose('select-all'); await choose('delete-selection'); const allDeleted = await snapshot();
    record('Select all followed by selection Delete removes both marks', allDeleted.pixels === blank.pixels && !allDeleted.selection);
    await history(drawn, allDeleted, 'Select all Delete');

    await resetDocument(); const beforeBrushes = await snapshot();
    const openBrushesTimed = () => page.locator('[data-menu="brushes"]').evaluate(button => {
      const start = performance.now(); button.click(); return performance.now() - start;
    });
    const inspectBrushes = () => page.locator('#menu').evaluate(menu => [...menu.querySelectorAll('button')].map(button => {
      const canvas = button.querySelector('canvas'), rect = canvas?.getBoundingClientRect();
      const pixels = canvas?.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return { command: button.dataset.command, role: button.getAttribute('role'), checked: button.getAttribute('aria-checked'),
        width: canvas?.width, height: canvas?.height, displayWidth: rect?.width, displayHeight: rect?.height,
        ink: pixels ? pixels.some((value, index) => index % 4 === 3 && value > 0) : false,
        preview: canvas?.toDataURL() };
    }));
    const coldMs = await openBrushesTimed(), brushes = await inspectBrushes();
    record('brush menu contains the nine reference brushes without Pencil',
      JSON.stringify(brushes.map(item => item.command)) === JSON.stringify(['brush', 'calligraphy', 'calligraphy-pen',
        'airbrush', 'oil', 'crayon', 'marker', 'natural-pencil', 'watercolor'].map(tool => `tool:${tool}`)), brushes.map(item => item.command));
    record('each brush menu preview contains ink on a 120 by 40 canvas', brushes.length === 9 && brushes.every(item =>
      item.width === 120 && item.height === 40 && item.displayWidth === 120 && item.displayHeight === 40 && item.ink));
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await frame();
    record('keyboard brush selection chooses Watercolor without changing pristine pixels or history',
      await page.locator('#tool-label').textContent() === 'Watercolor brush' &&
      (await snapshot()).pixels === beforeBrushes.pixels && !(await snapshot()).undo && !(await snapshot()).redo);
    const warmMs = [];
    let repeatedPreviews = true;
    for (let i = 0; i < 5; i++) {
      warmMs.push(await openBrushesTimed()); const reopened = await inspectBrushes();
      repeatedPreviews &&= reopened.length === brushes.length && reopened.every((item, index) => item.preview === brushes[index].preview);
      if (i === 0) record('chosen brush is the sole checked brush menu radio', reopened.every(item =>
        item.role === 'menuitemradio' && item.checked === String(item.command === 'tool:watercolor')));
      await page.keyboard.press('Escape');
    }
    record('reopening the brush menu produces deterministic preview pixels', repeatedPreviews);
    const sorted = [...warmMs].sort((a, b) => a - b);
    brushMenuTiming = { measuredAt: new Date().toISOString(),
      scope: 'Synchronous public Brushes button.click duration, including nine preview renders and menu layout. Cold is the first brush-menu open in this page; warm is five later opens. Excludes subsequent paint, process startup, CPU time and memory.',
      coldMs, warmMs, warmMedianMs: sorted[Math.floor(sorted.length / 2)],
      environment: await page.evaluate(() => ({ userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], devicePixelRatio })) };
  } finally {
    if (transparencyToggles % 2) await choose('transparent-selection');
    await resetDocument();
    await page.locator('#size-number').fill(initial.size); await page.locator('#size-number').press('Tab');
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
    await page.locator('#viewport').evaluate((el, scroll) => { [el.scrollLeft, el.scrollTop] = scroll; }, initial.scroll);
  }
  const restored = await snapshot();
  record('selection menu fixture restores blank pixels and clean history', restored.pixels === blank.pixels && !restored.undo && !restored.redo);
  for (const result of results) check(result.name, result.ok, result.detail);
  return { brushMenuTiming };
}

export async function verifySelectionMenu(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    return await verifySelectionMenuDesktop(target, check);
  } finally { await context.close(); }
}
