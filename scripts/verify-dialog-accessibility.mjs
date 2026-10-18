// Isolated browser workflows exercise the shared HTML dialog producer. The
// packaged app's native unsaved-change prompt is a separate platform boundary.
export async function verifyDialogAccessibility(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
    const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const snapshot = () => target.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(),
      width: document.querySelector('#canvas').width, height: document.querySelector('#canvas').height,
      primary: getComputedStyle(document.querySelector('#primary')).backgroundColor, title: document.title,
      undo: !document.querySelector('[data-action="undo"]').disabled, redo: !document.querySelector('[data-action="redo"]').disabled }));
    const initial = await snapshot(), dialog = target.locator('#dialog'), shared = await dialog.elementHandle();
    const named = async title => {
      await target.locator('#dialog[open]').waitFor();
      const ownership = await dialog.evaluate(el => {
        const id = el.getAttribute('aria-labelledby'), matches = id ? [...document.querySelectorAll('[id]')].filter(node => node.id === id) : [];
        return { labelledby: id, uniqueTitle: matches.length === 1 && el.contains(matches[0]),
          title: matches[0]?.textContent, heading: el.querySelector('h2')?.textContent };
      });
      record(`${title} dialog exposes its current heading as its unique accessible name`,
        await target.getByRole('dialog', { name: title, exact: true }).count() === 1 &&
        ownership.uniqueTitle && ownership.title === title && ownership.heading === title, ownership);
    };
    const properties = async () => { await target.locator('#overlay').focus(); await target.keyboard.press('Control+e'); await named('Image properties'); };
    const closed = async () => { await target.locator('#dialog[open]').waitFor({ state: 'detached' }); await frame(); };

    await properties(); await target.keyboard.press('Escape'); await closed();
    record('Escape from named Properties leaves dimensions, pixels and history unchanged', JSON.stringify(await snapshot()) === JSON.stringify(initial));

    await target.getByRole('button', { name: 'Resize and skew', exact: true }).click(); await named('Resize and skew');
    await target.locator('#resize-width').fill('123');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await closed();
    record('Cancel from named Resize discards pending dimensions without history', JSON.stringify(await snapshot()) === JSON.stringify(initial));

    await target.getByRole('button', { name: 'Edit colors', exact: true }).click(); await named('Edit colors');
    await target.locator('#hex').fill('#ed1c24');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await closed();
    record('Cancel from named Edit colors preserves the selected color and document', JSON.stringify(await snapshot()) === JSON.stringify(initial));

    await properties();
    record('sequential dialogs reuse the producer node with the new title', await shared.evaluate(el => el === document.querySelector('#dialog')));
    await dialog.getByRole('spinbutton', { name: 'Width', exact: true }).focus();
    await target.keyboard.press('Enter'); await closed();
    record('Enter accepts unchanged named Properties without creating history', JSON.stringify(await snapshot()) === JSON.stringify(initial));

    await target.locator('[data-tool="pencil"]').click();
    const box = await target.locator('#overlay').boundingBox();
    await target.mouse.move(box.x + 20, box.y + 20); await target.mouse.down();
    await target.mouse.move(box.x + 60, box.y + 20); await target.mouse.up(); await frame();
    const painted = await snapshot();
    if (painted.pixels === initial.pixels || !painted.undo) throw new Error('Dialog accessibility fixture did not create a drawing.');
    await target.keyboard.press('Control+n'); await named('Unsaved changes');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await closed();
    record('Cancel from named Unsaved changes preserves the drawing and its history', JSON.stringify(await snapshot()) === JSON.stringify(painted));

    await properties(); await target.keyboard.press('Escape'); await closed();
    record('Properties after Unsaved changes retains its own title and cancellation behavior', JSON.stringify(await snapshot()) === JSON.stringify(painted));
    await target.locator('#overlay').focus(); await target.keyboard.press('Control+z'); await frame();
    await target.keyboard.press('Control+n'); await frame();
    const restored = await snapshot();
    record('dialog accessibility fixture restores blank pixels and clean history', restored.pixels === initial.pixels && !restored.undo && !restored.redo);
    await shared.dispose();
    for (const result of results) check(result.name, result.ok, result.detail);
  } finally { await context.close(); }
}
