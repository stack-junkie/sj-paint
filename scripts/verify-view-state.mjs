// Static pinned MenuBar.xbf evidence establishes toggle presentation for Rulers,
// Gridlines and Status bar. Native persistence/focus behavior is not established.
// Operations below use public controls; canvas readback verifies SJ preservation.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Horizontal scrolling is intentional in the drawing and text toolbars. Check
// that focus reveals each control, rather than treating any scrollWidth as a bug.
async function verifyResponsiveControls(page, record, frame, capture) {
  const initial = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
    layers: !document.querySelector('#layers-panel').hidden,
    pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled }));
  const viewport = page.viewportSize(), matrix = [];
  const output = path.resolve('output', 'responsive-view-state', `${process.platform}-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const theme = async value => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#dialog [name="theme"]').selectOption(value);
    await page.locator('#dialog button[type="submit"]').click(); await frame();
  };
  const keyboardFocus = async locator => {
    const hasPrevious = await locator.evaluate(el => {
      const stops = [...document.querySelectorAll('button,input,select,textarea,a[href],[tabindex]')]
        .filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      const index = stops.indexOf(el);
      if (index > 0) stops[index - 1].focus();
      else el.focus();
      return index > 0;
    });
    if (hasPrevious) await page.keyboard.press('Tab');
    await frame();
  };
  const exposure = locator => locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const describe = node => node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.className && typeof node.className === 'string' ? `.${node.className.trim().replace(/\s+/g, '.')}` : ''}` : null;
    const clips = [];
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) clips.push({ element: describe(parent),
        x: style.overflowX, y: style.overflowY, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        scrollLeft: parent.scrollLeft, scrollTop: parent.scrollTop, clientWidth: parent.clientWidth, scrollWidth: parent.scrollWidth });
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { name: el.getAttribute('aria-label') || el.labels?.[0]?.textContent.trim() || el.textContent.trim(),
      focused: document.activeElement === el, width: rect.width, height: rect.height,
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      clip: { left, right, top, bottom }, hit: describe(hit), clips,
      exposed: rect.width > 0 && rect.height > 0 && rect.left >= left - 1 && rect.right <= right + 1 &&
        rect.top >= top - 1 && rect.bottom <= bottom + 1 && (hit === el || el.contains(hit)) };
  });
  try {
    await page.locator('[data-tool="text"]').click();
    if (!initial.layers) await page.locator('.layers-group [data-action="layers"]').click();
    for (const mode of ['light', 'dark']) {
      await theme(mode);
      for (const width of [600, 810, 864, 972, 1156]) {
        await page.setViewportSize({ width, height: 700 }); await frame();
        const controls = [];
        for (const selector of ['[data-menu="file"]', '[data-menu="edit"]', '[data-menu="view"]',
          '[data-action="settings"]', '[data-menu="selection"]', '[data-tool="pencil"]', '[data-tool="text"]',
          '[data-menu="brushes"]', '#outline', '#shape-fill', '#primary', '#secondary',
          '.color-wheel[data-action="colors"]', '.layers-group [data-action="layers"]',
          '[data-action="fit"]', '#zoom-presets', '[data-action="zoom-out"]', '#zoom-slider', '[data-action="zoom-in"]']) {
          const control = page.locator(selector); await keyboardFocus(control);
          controls.push({ selector, ...await exposure(control) });
        }
        // Actual Tab traversal catches clipped or skipped text formatting controls.
        const textControls = [];
        await keyboardFocus(page.locator('#font'));
        for (const selector of ['#font', '#font-size', '[data-action="bold"]', '[data-action="italic"]',
          '[data-action="underline"]', '[data-action="strikethrough"]', '[data-text-align="left"]',
          '[data-text-align="center"]', '[data-text-align="right"]', '#text-background', '[data-action="commit-text"]']) {
          await frame(); textControls.push({ selector, ...await exposure(page.locator(selector)) });
          await page.keyboard.press('Tab');
        }
        const layerControls = [];
        for (const selector of ['[data-action="add-layer"]', '[data-action="duplicate-layer"]', '[data-action="merge-layer"]',
          '[data-action="rename-layer"]', '[data-action="delete-layer"]', '[data-action="layer-up"]',
          '[data-action="layer-down"]', '#layer-opacity', '#layers-panel [data-action="background"]']) {
          const control = page.locator(selector); await keyboardFocus(control);
          layerControls.push({ selector, ...await exposure(control) });
        }
        // Inspect the whole panel as well: focus scrolling must not conceal an
        // overflowing action row when the next control is brought into view.
        const layerOverflow = await page.locator('#layers-panel').evaluate(el => ({
          clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, scrollLeft: el.scrollLeft }));
        const menus = [];
        for (const selector of ['[data-menu="file"]', '[data-menu="edit"]', '[data-menu="view"]',
          '[data-menu="selection"]', '[data-menu="brushes"]', '#outline', '#shape-fill',
          '[data-action="rotate-menu"]', '[data-action="flip-menu"]']) {
          const anchor = page.locator(selector); await keyboardFocus(anchor); await page.keyboard.press('Enter'); await frame();
          const menu = page.locator('#menu'), box = await menu.boundingBox();
          const ends = [];
          for (const key of ['End', 'Home']) {
            await page.keyboard.press(key); await frame();
            const focused = menu.locator('button:focus');
            ends.push({ key, ...await exposure(focused) });
          }
          menus.push({ selector, box, ends, bounded: Boolean(box && box.x >= 0 && box.y >= 0 &&
            box.x + box.width <= width + 1 && box.y + box.height <= 701) });
          await page.keyboard.press('Escape'); await frame();
        }
        await page.locator('#overlay').focus(); await page.keyboard.press('Control+e'); await frame();
        const propertiesBox = await page.getByRole('dialog', { name: 'Image properties', exact: true }).boundingBox();
        const propertiesControls = [];
        await page.locator('#dialog [name="units"][value="pixels"]').focus();
        for (const selector of ['#dialog [name="units"][value="pixels"]', '#dialog [name="width"]',
          '#dialog [name="height"]', '#properties-default', '#dialog-cancel', '#dialog button[type="submit"]']) {
          await frame(); propertiesControls.push({ selector, ...await exposure(page.locator(selector)) });
          await page.keyboard.press('Tab');
        }
        await page.mouse.move(1, 1);
        const propertiesScreenshot = path.join(output, `${process.platform}-${mode}-${width}-properties.png`);
        await capture({ path: propertiesScreenshot, animations: 'disabled' });
        await page.locator('#dialog-cancel').click(); await frame();
        const properties = { box: propertiesBox, controls: propertiesControls, screenshot: propertiesScreenshot };
        const layout = await page.evaluate(() => {
          const box = selector => { const r = document.querySelector(selector).getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          return { theme: document.documentElement.dataset.theme, viewport: { width: innerWidth, height: innerHeight },
            body: { width: document.body.clientWidth, scrollWidth: document.body.scrollWidth },
            regions: ['.menubar', '.toolbar', '.contextbar', '.workspace', '#viewport', '#layers-panel', '.statusbar'].map(selector => ({ selector, ...box(selector) })),
            fontWidth: box('#font').width,
            canvasMetric: getComputedStyle(document.querySelector('#dimensions')).display !== 'none' };
        });
        const name = `${mode} ${width}px`;
        record(`Responsive ${name} keeps named drawing and zoom controls reachable`,
          controls.every(control => control.name && control.focused && control.exposed), controls);
        record(`Responsive ${name} reveals every text control through Tab`,
          textControls.every(control => control.name && control.focused && control.exposed), textControls);
        record(`Responsive ${name} exposes every layer action through Tab without horizontal panel overflow`,
          layerControls.every(control => control.name && control.focused && control.exposed) &&
          layerOverflow.scrollWidth <= layerOverflow.clientWidth + 1, { controls: layerControls, overflow: layerOverflow });
        record(`Responsive ${name} bounds every menu and reveals its first and last keyboard item`,
          menus.every(menu => menu.bounded && menu.ends.every(control => control.name && control.focused && control.exposed)), menus);
        record(`Responsive ${name} preserves the resource-declared 496px Properties width and accessible controls`,
          propertiesBox && Math.abs(propertiesBox.width - 496) < 1 && propertiesBox.x >= 0 && propertiesBox.y >= 0 &&
          propertiesBox.x + propertiesBox.width <= width && propertiesBox.y + propertiesBox.height <= 700 &&
          propertiesControls.every(control => control.name && control.focused && control.exposed), properties);
        record(`Responsive ${name} bounds app regions and keeps a usable drawing viewport`,
          layout.theme === mode && layout.body.scrollWidth <= layout.body.width + 1 &&
          layout.regions.every(region => region.width > 0 && region.height > 0 && region.left >= -1 &&
            region.right <= width + 1 && region.top >= -1 && region.bottom <= 701) &&
          layout.regions.find(region => region.selector === '#viewport').width >= 200 &&
          layout.fontWidth === (width >= 810 ? 190 : 126) && layout.canvasMetric === (width >= 972), layout);
        await page.locator('.toolbar').evaluate(el => { el.scrollLeft = 0; });
        await keyboardFocus(page.locator('#font')); await frame();
        await page.mouse.move(1, 1);
        const screenshot = path.join(output, `${process.platform}-${mode}-${width}.png`);
        await capture({ path: screenshot, animations: 'disabled' });
        matrix.push({ mode, width, controls, textControls, layerControls, layerOverflow, menus, properties, layout, screenshot });
      }
    }
    const current = await page.evaluate(() => ({ pixels: document.querySelector('#canvas').toDataURL(),
      title: document.title, undo: document.querySelector('[data-action="undo"]').disabled,
      redo: document.querySelector('[data-action="redo"]').disabled }));
    record('Responsive theme and control matrix preserves document pixels and history',
      current.pixels === initial.pixels && current.title === initial.title && current.undo === initial.undo && current.redo === initial.redo);
    const receipt = path.join(output, `${process.platform}-matrix.json`);
    await writeFile(receipt, JSON.stringify({ capturedAt: new Date().toISOString(), matrix }, null, 2) + '\n');
    record('Responsive matrix retains ten screenshots and measured control evidence', matrix.length === 10, { receipt, screenshots: matrix.map(row => row.screenshot) });
  } finally {
    if (await page.locator('#dialog').evaluate(el => el.open)) await page.locator('#dialog-cancel').click();
    if (await page.locator('#layers-panel').isVisible() !== initial.layers) await page.locator('#layers-panel [data-action="layers"]').click();
    await theme(initial.theme);
    if (viewport) await page.setViewportSize(viewport);
    else {
      const session = await page.context().newCDPSession(page);
      try { await session.send('Emulation.clearDeviceMetricsOverride'); } finally { await session.detach(); }
    }
    await frame();
  }
}

export async function verifyViewStateDesktop(page, check, { capture = options => page.screenshot(options) } = {}) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => ({
    pixels: document.querySelector('#canvas').toDataURL(), title: document.title,
    undo: document.querySelector('[data-action="undo"]').disabled,
    redo: document.querySelector('[data-action="redo"]').disabled,
    dirty: document.querySelector('#document-state').textContent,
  }));
  const close = async () => { if (await page.locator('#menu').isVisible()) await page.keyboard.press('Escape'); };
  const open = async () => { await close(); await page.locator('[data-menu="view"]').click(); };
  const choose = async command => { await open(); await page.locator(`#menu [data-command="${command}"]`).click(); await frame(); };
  const item = command => page.locator(`#menu [data-command="${command}"]`);
  const state = command => item(command).evaluate(el => ({ role: el.getAttribute('role'), checked: el.getAttribute('aria-checked') }));
  const initial = await snapshot();
  if (!initial.undo || !initial.redo || initial.dirty || !await page.locator('.statusbar').isVisible()) {
    throw new Error('View state checks require a pristine document and visible status bar.');
  }
  const initialZoom = await page.locator('#zoom-presets').inputValue();
  const initialViewport = page.viewportSize();
  let gridToggled = false, rulersToggled = false, pendingShape = false;
  try {
    for (const [command, title, shortcut] of [['grid', 'Gridlines', 'Control+g'], ['rulers', 'Rulers', 'Control+r']]) {
      await open(); const before = await state(command);
      record(`${title} is an unchecked menu checkbox initially`, before.role === 'menuitemcheckbox' && before.checked === 'false', before);
      await item(command).click(); await frame();
      if (command === 'grid') gridToggled = true; else rulersToggled = true;
      record(`${title} activation dismisses the menu and restores its opener`, await page.locator('#menu').isHidden() &&
        await page.locator('[data-menu="view"]').evaluate(el => document.activeElement === el));
      await open(); const enabled = await state(command);
      record(`${title} exposes checked state after pointer activation`, enabled.role === 'menuitemcheckbox' && enabled.checked === 'true', enabled);
      await close(); await page.keyboard.press(shortcut); await frame();
      if (command === 'grid') gridToggled = false; else rulersToggled = false;
      await open(); const disabled = await state(command);
      record(`${title} checkbox follows its existing keyboard shortcut`, disabled.role === 'menuitemcheckbox' && disabled.checked === 'false', disabled);
    }
    await open(); const status = item('status-bar');
    record('View exposes the resource-declared Status bar command', await status.count() === 1);
    if (await status.count()) {
      const initialStatus = await state('status-bar');
      record('Status bar is a checked menu checkbox initially', initialStatus.role === 'menuitemcheckbox' && initialStatus.checked === 'true', initialStatus);
      const beforeLayout = await page.locator('#viewport').boundingBox();
      const footerHeight = (await page.locator('.statusbar').boundingBox()).height;
      await status.click(); await frame();
      const hiddenLayout = await page.locator('#viewport').boundingBox();
      record('Hiding Status bar releases its height to the drawing workspace', await page.locator('.statusbar').isHidden() &&
        Math.abs(hiddenLayout.height - beforeLayout.height - footerHeight) < 2, { beforeLayout, hiddenLayout, footerHeight });
      await page.keyboard.press('Control+PageUp'); await frame();
      const zoomed = await page.locator('#zoom-presets').inputValue();
      record('Zoom shortcut remains usable with Status bar hidden', zoomed !== initialZoom, { initialZoom, zoomed });
      await choose('zoom-100');
      record('View zoom command remains usable with Status bar hidden', await page.locator('#zoom-presets').inputValue() === '1');
      await open(); const hidden = await state('status-bar');
      record('Hidden Status bar is exposed as unchecked', hidden.role === 'menuitemcheckbox' && hidden.checked === 'false', hidden);
      await status.focus(); await page.keyboard.press('Space'); await frame();
      record('Keyboard activation restores Status bar and menu focus', await page.locator('.statusbar').isVisible() &&
        await page.locator('#menu').isHidden() && await page.locator('[data-menu="view"]').evaluate(el => document.activeElement === el));
      await page.locator('#zoom-presets').selectOption(initialZoom); await frame();
      record('View presentation commands preserve drawing pixels, dirty state and history', JSON.stringify(await snapshot()) === JSON.stringify(initial));

      // A presentation-only command must not accept a pending drawing transaction.
      await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
      const box = await page.locator('#overlay').boundingBox();
      await page.mouse.move(box.x + 25, box.y + 25); await page.mouse.down();
      await page.mouse.move(box.x + 95, box.y + 75); await page.mouse.up(); await frame(); pendingShape = true;
      record('View preservation fixture creates a pending shape', (await snapshot()).pixels !== initial.pixels);
      const pending = await snapshot();
      const pendingSize = await page.locator('#selection-size').textContent();
      try {
        for (const width of [1156, 972, 971, 864, 863, 600, 1300]) {
          await page.setViewportSize({ width, height: 700 }); await frame();
          const visibility = {
            selection: await page.locator('#selection-size').isVisible(),
            canvas: await page.locator('#dimensions').isVisible(),
          };
          record(`Status metrics follow resource thresholds at ${width}px`,
            visibility.selection === (width >= 864) && visibility.canvas === (width >= 972), visibility);
          record(`Status layout at ${width}px preserves pending geometry and pixels`,
            await page.locator('#selection-size').textContent() === pendingSize &&
            JSON.stringify(await snapshot()) === JSON.stringify(pending));
        }
      } finally {
        if (initialViewport) await page.setViewportSize(initialViewport);
        else {
          const session = await page.context().newCDPSession(page);
          try { await session.send('Emulation.clearDeviceMetricsOverride'); } finally { await session.detach(); }
        }
        await frame();
      }
      await choose('status-bar'); await choose('status-bar');
      await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await frame(); pendingShape = false;
      record('Status bar toggles keep the pending shape cancellable without history', JSON.stringify(await snapshot()) === JSON.stringify(initial));
    }
    await verifyResponsiveControls(page, record, frame, capture);
  } finally {
    await close();
    if (pendingShape) { await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); }
    if (gridToggled) await page.keyboard.press('Control+g');
    if (rulersToggled) await page.keyboard.press('Control+r');
    if (await page.locator('.statusbar').isHidden()) await choose('status-bar');
    await page.locator('#zoom-presets').selectOption(initialZoom);
    await page.locator('[data-menu="brushes"]').click();
    await page.locator('#menu [data-command="tool:brush"]').click(); await frame();
  }
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyViewState(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url());
    await target.locator('#overlay').waitFor();
    await verifyViewStateDesktop(target, check);
  } finally { await context.close(); }
}
