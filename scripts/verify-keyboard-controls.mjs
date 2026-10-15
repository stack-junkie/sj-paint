// Keyboard robustness checks, not claims about observed native Paint behavior.
// An isolated page keeps the caller's document, history, focus and menus intact.
export async function verifyKeyboardControls(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  const target = await context.newPage();
  const results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const press = async (selector, key) => { await target.locator(selector).focus(); await target.keyboard.press(key); await frame(); };
  const focused = selector => target.locator(selector).evaluate(element => element === document.activeElement);
  const menuOpen = () => target.locator('#menu').isVisible();
  const openView = async () => {
    if (await menuOpen()) { await target.keyboard.press('Escape'); await frame(); }
    await press('[data-menu="view"]', 'Space');
  };
  try {
    await target.goto(page.url()); await target.waitForFunction(() => window.paintApp);
    await target.evaluate(() => { paintApp.doc.newDocument(64,48); paintApp.setZoom(1); }); await frame();

    await press('[data-tool="pencil"]', 'Enter');
    record('Enter activates a focused toolbar tool button', await target.locator('[data-tool="pencil"]').getAttribute('aria-pressed') === 'true');
    await press('[data-tool="eraser"]', 'Space');
    record('Space activates a focused toolbar tool button', await target.locator('[data-tool="eraser"]').getAttribute('aria-pressed') === 'true');

    await press('[data-menu="view"]', 'Enter');
    record('Enter opens a focused menu button', await menuOpen());
    if (!await menuOpen()) await press('[data-menu="view"]', 'Space');
    record('opening a menu places focus on its first command', await focused('#menu button:first-child'));
    await target.keyboard.press('ArrowDown');
    record('Arrow Down moves menu focus to the next command', await focused('#menu [data-command="zoom-out"]'));
    await target.keyboard.press('End');
    record('End moves menu focus to its final command', await focused('#menu button:last-child'));
    await target.keyboard.press('Home'); await target.keyboard.press('ArrowUp');
    record('Arrow Up wraps menu focus from first to last command', await focused('#menu button:last-child'));
    await target.keyboard.press('Escape'); await frame();
    record('Escape closes the menu and restores focus to its opener', !await menuOpen() && await focused('[data-menu="view"]'));

    const gridBefore = await target.evaluate(() => paintApp.state.grid);
    await openView(); await press('#menu [data-command="grid"]', 'Enter');
    record('Enter invokes a focused menu command and closes the menu', !await menuOpen() && await target.evaluate(value => paintApp.state.grid !== value, gridBefore));
    await openView();
    const gridBeforeSpace = await target.evaluate(() => paintApp.state.grid);
    await press('#menu [data-command="grid"]', 'Space');
    record('Space invokes a focused menu command and closes the menu', !await menuOpen() && await target.evaluate(value => paintApp.state.grid !== value, gridBeforeSpace));
    record('a presentation menu command returns focus to an available control', await focused('[data-menu="view"]') || await focused('#overlay'));

    await openView(); await target.keyboard.press('Shift+Tab'); await frame();
    record('Tab leaving a menu dismisses it without taking focus back', !await menuOpen() && await target.evaluate(() => !document.activeElement.closest('#menu') && document.activeElement !== document.body));
    await target.keyboard.press('Shift+Tab');
    const sliderFocused = await focused('#zoom-slider');
    await target.keyboard.press('Home'); await frame();
    record('Home on the zoom slider after leaving a menu retains native slider behavior', sliderFocused && await focused('#zoom-slider') && Number(await target.locator('#zoom-slider').inputValue()) === -3);
    if (await menuOpen()) { await target.keyboard.press('Escape'); await frame(); }
    await target.locator('#zoom-presets').selectOption({label:'100%'}); await frame();

    await target.locator('#overlay').focus(); await target.keyboard.press('Control+a'); await target.keyboard.press('ArrowRight'); await frame();
    const pendingSelection = await target.evaluate(() => JSON.stringify({ transform: paintApp.doc.selection?.transform, session: paintApp.doc.hasSelectionSession, dirty: paintApp.doc.dirty }));
    await openView(); await target.keyboard.press('Escape'); await frame();
    record('Escape dismisses an open menu without cancelling the pending canvas selection', !await menuOpen() &&
      await target.evaluate(expected => JSON.stringify({ transform: paintApp.doc.selection?.transform, session: paintApp.doc.hasSelectionSession, dirty: paintApp.doc.dirty }) === expected, pendingSelection));
    await target.locator('#overlay').focus(); await target.keyboard.press('Escape'); await target.keyboard.press('Escape'); await frame();

    await press('[data-tool="rectangle"]','Space');
    const bounds = await target.locator('#overlay').boundingBox();
    const zoom = await target.evaluate(() => paintApp.state.zoom);
    await target.mouse.move(bounds.x+10*zoom,bounds.y+10*zoom); await target.mouse.down();
    await target.mouse.move(bounds.x+40*zoom,bounds.y+30*zoom); await target.mouse.up(); await frame();
    const pendingShape = await target.locator('#canvas').evaluate(canvas => canvas.toDataURL());
    await openView(); await target.keyboard.press('Escape'); await frame();
    record('Escape dismisses an open menu without cancelling the editable shape', !await menuOpen() &&
      await target.locator('#canvas').evaluate((canvas,expected) => canvas.toDataURL() === expected,pendingShape));
    await target.locator('#overlay').focus(); await target.keyboard.press('Escape'); await target.keyboard.press('Escape'); await frame();

    await press('.layers-group [data-action="layers"]', 'Space');
    if (!await target.locator('#layers-panel').isVisible()) await press('.layers-group [data-action="layers"]', 'Space');
    await press('[data-action="add-layer"]', 'Space');
    const layers = await target.evaluate(() => paintApp.doc.layers.map(layer => ({ id: layer.id, visible: layer.visible })));
    record('Space activates the add-layer control', layers.length === 2);
    const lowerEye = `#layer-list [data-visible="${layers[0].id}"]`;
    await press(lowerEye, 'Enter');
    record('Enter activates a layer visibility button', await target.evaluate(id => !paintApp.doc.layers.find(layer => layer.id === id).visible, layers[0].id));
    const visibleBefore = await target.evaluate(id => paintApp.doc.layers.find(layer => layer.id === id).visible, layers[0].id);
    await press(lowerEye, 'Space');
    record('Space activates a layer visibility button', await target.evaluate(({id,before}) => paintApp.doc.layers.find(layer => layer.id === id).visible !== before, {id:layers[0].id,before:visibleBefore}));
    record('toggling a layer keeps keyboard focus on the same visibility control', await focused(lowerEye));

    // Reach the layer selection affordance using Tab, without assigning tabindex
    // or synthesizing a click on the otherwise mouse-only row.
    const tabToLayer = async id => {
      await target.locator('#layers-panel [data-action="layers"]').focus();
      const visited = [];
      for (let i=0;i<40;i++) {
        await target.keyboard.press('Tab');
        const position = await target.evaluate(id => {
          const active = document.activeElement;
          return { inPanel: Boolean(active.closest('#layers-panel')),
            selectable: active.closest('[data-layer]')?.dataset.layer === id && !active.closest('[data-visible]'),
            label: active.getAttribute('aria-label') || active.getAttribute('title') || active.tagName };
        },id);
        visited.push(position.label);
        if (position.selectable) return { reached: true, visited };
        if (!position.inPanel) break;
      }
      return { reached: false, visited };
    };
    const reachable = await tabToLayer(layers[0].id);
    record('Tab can reach a control that selects a different layer', reachable.reached, reachable.visited);
    for (const [key,id] of [['Enter',layers[0].id],['Space',layers[1].id]]) {
      const { reached } = await tabToLayer(id);
      if (reached) { await target.keyboard.press(key); await frame(); }
      record(`${key} selects the intended layer through a Tab-reachable control`, reached && await target.evaluate(id => paintApp.doc.activeLayerId === id,id), reached ? undefined : 'No keyboard-reachable layer selection control');
    }
    await press('[data-action="layer-down"]','Space');
    const reorderedSelection = `#layer-list [data-layer="${layers[1].id}"] .layer-select`;
    await target.locator(reorderedSelection).focus(); await target.keyboard.press('Control+z'); await frame();
    record('Undo reordering a layer preserves focus on that surviving layer control', await focused(reorderedSelection) &&
      await target.locator('#layer-list > [data-layer]').first().getAttribute('data-layer') === layers[1].id);

    await target.locator('#overlay').focus(); await target.keyboard.press('Control+e');
    await target.locator('#dialog[open]').waitFor();
    record('opening a dialog moves focus into the modal', await target.evaluate(() => Boolean(document.activeElement.closest('#dialog'))));
    await target.locator('#dialog [name="width"]').fill('80'); await target.keyboard.press('Enter'); await frame();
    record('Enter in a dialog field submits its valid form', !await target.locator('#dialog').evaluate(dialog => dialog.open) && await target.evaluate(() => paintApp.doc.width === 80));

    for (const key of ['Enter','Space']) {
      await target.locator('#overlay').focus(); await target.keyboard.press('Control+e'); await target.locator('#dialog[open]').waitFor();
      await target.locator('#dialog [name="width"]').fill('90');
      await press('#dialog-cancel',key);
      record(`${key} activates dialog Cancel without applying entered dimensions`, !await target.locator('#dialog').evaluate(dialog => dialog.open) && await target.evaluate(() => paintApp.doc.width === 80));
    }
    await press('[data-action="resize"]','Space'); await target.locator('#dialog[open]').waitFor();
    await target.keyboard.press('Escape'); await frame();
    record('Escape closes a dialog and restores its opener focus', !await target.locator('#dialog').evaluate(dialog => dialog.open) && await focused('[data-action="resize"]'));
  } finally { await context.close(); }
  for (const result of results) check(result.name,result.ok,result.detail);
}
