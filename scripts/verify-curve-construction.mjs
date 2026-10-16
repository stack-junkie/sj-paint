// The shared checks use only public controls and displayed canvases. They also
// run in the packaged renderer, which deliberately does not expose paintApp.
async function verifyConstruction(page, check, prefix) {
  const results = [], record = (name, ok, detail) => results.push({ name: `${prefix}${name}`, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const initial = await page.evaluate(() => {
    const color = selector => {
      const c = document.createElement('canvas').getContext('2d'); c.fillStyle = document.querySelector(selector).style.background;
      c.fillRect(0, 0, 1, 1);
      return '#' + [...c.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('');
    };
    return { tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
      label: document.querySelector('#tool-label').textContent, primary: color('#primary'), secondary: color('#secondary'),
      size: document.querySelector('#size-number').value, zoom: document.querySelector('#zoom-presets').value,
      outline: document.querySelector('#outline').value, fill: document.querySelector('#shape-fill').value,
      layers: !document.querySelector('#layers-panel').hidden,
      scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
      pixels: document.querySelector('#canvas').toDataURL(),
      clean: document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled &&
        document.title === 'Untitled - Stack Junkie Paint' && !document.querySelector('#document-state').textContent,
      width: document.querySelector('#canvas').width, height: document.querySelector('#canvas').height,
      opacity: document.querySelector('#opacity').value };
  });
  if (!initial.clean || initial.width !== 1152 || initial.height !== 648 || initial.opacity !== '100') {
    throw new Error('Curve construction checks require a pristine default-size Untitled document at full drawing opacity.');
  }
  for (const color of [initial.primary, initial.secondary]) {
    if (!await page.locator(`[data-color="${color}"]`).count()) throw new Error('Curve checks require palette-restorable colors.');
  }
  const move = async (x, y) => {
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.move(bounds.x + x, bounds.y + y); await frame();
  };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); await frame(); };
  const press = async key => { await page.locator('#overlay').focus(); await page.keyboard.press(key); await frame(); };
  const snapshot = () => page.evaluate(() => {
    const surface = document.createElement('canvas'); surface.width = 260; surface.height = 190;
    const c = surface.getContext('2d', { willReadFrequently: true });
    for (const id of ['canvas', 'overlay']) c.drawImage(document.getElementById(id), 0, 0);
    const pixels = c.getImageData(0, 0, 260, 190).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let y = 0; y < 190; y++) for (let x = 0; x < 260; x++) {
      const i = (y * 260 + x) * 4;
      if (pixels[i] < 240 && pixels[i + 1] < 240 && pixels[i + 2] < 240 && pixels[i + 3]) {
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return { pixels: surface.toDataURL(), bounds: { minX, minY, maxX, maxY },
      samples: [[120, 40], [120, 70], [210, 40], [200, 100], [60, 65], [110, 90]].map(([x, y]) => [...c.getImageData(x, y, 1, 1).data]),
      foreground: [...c.getImageData(104, 30, 10, 130).data],
      undo: !document.querySelector('[data-action="undo"]').disabled,
      redo: !document.querySelector('[data-action="redo"]').disabled };
  });
  const resetHistory = async () => {
    await press('Control+n');
    await page.locator('#zoom-presets').selectOption({ label: '100%' }); await frame();
  };
  let owned = false;
  try {
    await page.locator('#zoom-presets').selectOption({ label: '100%' });
    await page.locator('[data-tool="curve"]').click(); await page.locator('[data-color="#000000"]').click();
    await page.locator('#outline').selectOption('solid'); await page.locator('#shape-fill').selectOption('none');
    await page.locator('#size-number').fill('6'); await page.locator('#size-number').press('Tab'); await frame();
    owned = true;
    for (const shift of [false, true]) {
      const baseline = await snapshot(), name = shift ? 'Shift-constrained curve' : 'diagonal curve';
      await move(40, 40); if (shift) await page.keyboard.down('Shift');
      await page.mouse.down(); await move(200, 100); const held = await snapshot();
      await page.mouse.up(); await frame(); const released = await snapshot();
      if (shift) await page.keyboard.up('Shift');
      record(`${name} keeps its initial geometry on pointer release`, held.pixels === released.pixels,
        { held: held.bounds, released: released.bounds });
      record(`${name} begins with a straight segment at the expected endpoint`,
        released.samples[shift ? 0 : 1].slice(0, 3).every(value => value === 0) &&
        released.bounds.maxY === (shift ? 42 : 102) && released.bounds.maxX === (shift ? 213 : 202), released.bounds);
      await click(80, 140); await move(160, 20); const bent = await snapshot();
      record(`${name} remains editable through its first control`, bent.pixels !== released.pixels && bent.undo && !bent.redo);
      await page.mouse.down(); await page.mouse.up(); await frame(); const committed = await snapshot();
      record(`${name} second control accepts the visible geometry`, committed.pixels === bent.pixels);
      record(`${name} retains its endpoint through both controls`,
        committed.samples[shift ? 2 : 3].slice(0, 3).every(value => value === 0));
      await press('Control+z'); const undone = await snapshot();
      record(`${name} accepts as one undoable operation`, undone.pixels === baseline.pixels && !undone.undo && undone.redo);
      await press('Control+y');
      record(`${name} Redo restores the accepted pixels`, (await snapshot()).pixels === committed.pixels);
      await press('Control+z'); await resetHistory();
    }

    const blank = await snapshot();
    await move(40, 40); await page.keyboard.down('Shift'); await page.mouse.down(); await move(200, 100);
    await press('Escape'); await page.mouse.up(); await page.keyboard.up('Shift');
    let canceled = await snapshot();
    record('canceling a held constrained curve leaves no pixels or history', canceled.pixels === blank.pixels && !canceled.undo && !canceled.redo);
    await move(40, 40); await page.mouse.down(); await move(200, 100); await page.mouse.up(); await click(80, 140);
    await press('Escape'); canceled = await snapshot();
    record('canceling a partially bent curve leaves no pixels or history', canceled.pixels === blank.pixels && !canceled.undo && !canceled.redo);

    // Build the translucent layer and its opaque foreground using public UI.
    if (!await page.locator('#layers-panel').isVisible()) await page.locator('.layers-group [data-action="layers"]').click();
    const lower = await page.locator('#layer-list [data-layer-select]').getAttribute('data-layer-select');
    await page.locator('#layer-opacity').focus(); await page.keyboard.press('Home');
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight');
    await page.locator('[data-action="add-layer"]').click();
    await page.locator('[data-tool="rectangle"]').click(); await page.locator('#outline').selectOption('none');
    await page.locator('#shape-fill').selectOption('solid'); await page.locator('[data-color="#3f48cc"]').click({ button: 'right' });
    await move(100, 1); await page.mouse.down(); await move(120, 179); await page.mouse.up();
    await page.locator('[data-tool="curve"]').click(); await page.locator('#outline').selectOption('solid');
    await page.locator('#shape-fill').selectOption('none'); await page.locator(`[data-layer-select="${lower}"]`).click();
    const layerBaseline = await snapshot();
    await move(20, 40); await page.mouse.down(); await move(180, 140); const held = await snapshot();
    const sample = held.samples[4];
    record('held diagonal curve applies active-layer opacity once', sample[0] >= 190 && sample[0] <= 192 &&
      sample[0] === sample[1] && sample[1] === sample[2] && sample[3] === 255, sample);
    record('held diagonal curve stays behind the opaque foreground', held.foreground.every((value, index) => value === [63, 72, 204, 255][index % 4]));
    await page.mouse.up(); await frame(); const released = await snapshot();
    record('diagonal curve release preserves the layer composite', released.pixels === held.pixels);
    await press('Enter'); const accepted = await snapshot();
    record('diagonal curve acceptance preserves the layer composite', accepted.pixels === released.pixels);
    await press('Control+z');
    record('curve Undo preserves its surrounding layer fixture', (await snapshot()).pixels === layerBaseline.pixels);
  } finally {
    await page.keyboard.up('Shift'); await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    if (owned) {
      for (let i = 0; i < 64 && await page.locator('[data-action="undo"]').isEnabled(); i++) await press('Control+z');
      if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Curve fixture cleanup exceeded its owned history bound.');
      await resetHistory();
    }
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
    await page.locator(`[data-color="${initial.primary}"]`).click(); await page.locator(`[data-color="${initial.secondary}"]`).click({ button: 'right' });
    await page.locator('#size-number').fill(initial.size); await page.locator('#size-number').press('Tab');
    await page.locator('#outline').selectOption(initial.outline); await page.locator('#shape-fill').selectOption(initial.fill);
    await page.locator('#zoom-presets').selectOption(initial.zoom);
    if (await page.locator('#layers-panel').isVisible() !== initial.layers) await page.locator('.layers-group [data-action="layers"]').click();
    await frame(); await page.locator('#viewport').evaluate((element, scroll) => { [element.scrollLeft, element.scrollTop] = scroll; }, initial.scroll);
  }
  record('curve fixture restores the blank document and clean history',
    await page.locator('#canvas').evaluate((canvas, pixels) => canvas.toDataURL() === pixels, initial.pixels) &&
    !await page.locator('[data-action="undo"]').isEnabled() && !await page.locator('[data-action="redo"]').isEnabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyCurveConstruction(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyConstruction(target, check, '');
  } finally { await context.close(); }
}

export async function verifyCurveConstructionDesktop(page, check) {
  await verifyConstruction(page, check, 'desktop ');
}
