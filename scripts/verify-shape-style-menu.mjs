import { chooseShapeStyle } from './shape-style-controls.mjs';

export async function verifyShapeStyleMenuDesktop(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    undo: !document.querySelector('[data-action="undo"]').disabled, redo: !document.querySelector('[data-action="redo"]').disabled }));
  const initial = await page.evaluate(() => ({ zoom: document.querySelector('#zoom-presets').value,
    outline: document.querySelector('#outline').value, fill: document.querySelector('#shape-fill').value,
    tool: document.querySelector('#tool-label').textContent }));
  const blank = await snapshot();
  const menu = page.locator('#menu');
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  check('Shape outline exposes an accessible menu button', await page.getByRole('button', { name: 'Shape outline', exact: true }).count() === 1);
  const timings = {};
  try {
    for (const [kind, id, title] of [['outline', 'outline', 'outline'], ['fillStyle', 'shape-fill', 'fill']]) {
      const button = page.locator(`#${id}`), before = await snapshot();
      const times = [];
      let images;
      for (let iteration = 0; iteration < 3; iteration++) {
        times.push(await button.evaluate(b => { const start = performance.now(); b.click(); return performance.now() - start; }));
        const rows = await menu.evaluate(m => [...m.querySelectorAll('button')].map(b => ({
          title: b.textContent.trim(), checked: b.getAttribute('aria-checked'), role: b.getAttribute('role'),
          preview: b.querySelector('canvas')?.toDataURL(), command: b.dataset.command,
        })));
        if (iteration === 0) {
          check(`${title} menu uses resource-backed labels and order`, JSON.stringify(rows.map(r => r.title)) === JSON.stringify([
            `No ${title}`, `Solid ${title}`, 'Crayon', 'Marker', 'Oil brush', 'Natural pencil', 'Watercolor brush']), rows);
          check(`${title} styles have independent previews and one selected radio`, rows.every(r => r.role === 'menuitemradio' && r.preview) &&
            rows.filter(r => r.checked === 'true').length === 1 && new Set(rows.map(r => r.preview)).size === 7);
          images = rows.map(r => r.preview);
        } else check(`${title} preview pixels repeat exactly on opening ${iteration + 1}`, JSON.stringify(images) === JSON.stringify(rows.map(r => r.preview)));
        await page.keyboard.press('End');
        check(`${title} keyboard End reaches the last style`, await page.locator(`#menu [data-command="${kind}:watercolor"]`).evaluate(b => b === document.activeElement));
        await page.keyboard.press('Escape');
        check(`${title} Escape returns focus to its button`, await button.evaluate(b => b === document.activeElement));
      }
      timings[kind] = { firstOpenMs: times[0], repeatOpenMs: times.slice(1) };
      check(`${title} inspection leaves document and history untouched`, JSON.stringify(before) === JSON.stringify(await snapshot()));
      await button.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await frame();
      check(`${title} keyboard activation selects the style and closes the menu`, await menu.isHidden() && await button.evaluate(b => b.value) === 'watercolor');
      await chooseShapeStyle(page, kind, kind === 'outline' ? initial.outline : initial.fill);
    }
    await page.locator('#zoom-presets').selectOption('.5'); await frame();
    await page.locator('[data-tool="rectangle"]').click();
    await page.locator('[data-color="#ed1c24"]').click({ button:'right' });
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.move(bounds.x + 40, bounds.y + 40); await page.mouse.down();
    await page.mouse.move(bounds.x + 120, bounds.y + 100); await page.mouse.up(); await frame();
    const draft = await snapshot();
    await chooseShapeStyle(page, 'fillStyle', 'crayon'); await frame();
    const filled = await snapshot();
    check('Changing fill style updates the pending shape preview', filled.pixels !== draft.pixels);
    await page.locator('#shape-fill').click();
    check('Chosen fill is the sole checked style', await page.locator('#menu [aria-checked="true"]').getAttribute('data-command') === 'fillStyle:crayon');
    await page.keyboard.press('Escape');
    check('Dismissing the style menu retains the pending shape', (await snapshot()).pixels === filled.pixels);
    await chooseShapeStyle(page, 'outline', 'marker'); await frame();
    await key('Escape');
    check('Shape Escape cancels all pending style changes without history', (await snapshot()).pixels === blank.pixels && !(await snapshot()).undo);
    await page.mouse.move(bounds.x + 40, bounds.y + 40); await page.mouse.down();
    await page.mouse.move(bounds.x + 120, bounds.y + 100); await page.mouse.up(); await frame();
    await chooseShapeStyle(page, 'fillStyle', 'oil'); await chooseShapeStyle(page, 'outline', 'watercolor'); await frame();
    const preview = await snapshot();
    await page.locator('[data-tool="pencil"]').click(); await frame();
    check('Tool switching commits the selected styles without changing preview pixels', (await snapshot()).pixels === preview.pixels);
    await key('Control+z');
    check('One Undo removes the styled shape', (await snapshot()).pixels === blank.pixels && !(await snapshot()).undo);
    await key('Control+y');
    check('One Redo restores the exact styled shape', (await snapshot()).pixels === preview.pixels);
    await key('Control+z'); await key('Control+n');
  } finally {
    await page.mouse.up(); await key('Escape');
    await chooseShapeStyle(page, 'outline', initial.outline); await chooseShapeStyle(page, 'fillStyle', initial.fill);
    await page.locator('#zoom-presets').selectOption(initial.zoom);
    await page.locator('[data-color="#ffffff"]').click({ button:'right' });
    await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.tool, exact: true }).click();
  }
  check('Shape style fixture restores original pixels and clean history', (await snapshot()).pixels === blank.pixels && !(await snapshot()).undo && !(await snapshot()).redo);
  return { timings, scope: 'Synchronous menu creation/layout with seven previews. No CPU or process-memory measurement; shared host and warm OS cache.' };
}

export async function verifyShapeStyleMenu(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    context.setDefaultTimeout(10000);
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    const result = await verifyShapeStyleMenuDesktop(target, check);
    await target.setViewportSize({width:800,height:360});
    await target.locator('#outline').click();
    const geometry = await target.locator('#menu').evaluate(m => { const r=m.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}; });
    check('Style menu stays inside a short viewport', geometry.left>=0&&geometry.top>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.height,geometry);
    await target.keyboard.press('End');
    check('Last style remains keyboard reachable in a short viewport', await target.locator('#menu [data-command="outline:watercolor"]').evaluate(b => b===document.activeElement));
    await target.keyboard.press('Escape');
    return result;
  } finally { await context.close(); }
}

