import { chooseShapeStyle } from './shape-style-controls.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Public input, displayed pixels and history controls. The interruption itself
// is synthetic because taking focus from the owner's desktop is not allowed.
export async function verifyTextSessionDesktop(page, check, { capture = options => page.screenshot(options) } = {}) {
  const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const initial = await page.evaluate(() => ({
    pixels: document.querySelector('#canvas').toDataURL(),
    zoom: document.querySelector('#zoom-presets').value,
    font: document.querySelector('#font').value, size: document.querySelector('#font-size').value,
    background: document.querySelector('#text-background').checked,
    align: document.querySelector('[data-text-align][aria-pressed="true"]').dataset.textAlign,
    styles: Object.fromEntries(['bold', 'italic', 'underline', 'strikethrough'].map(name =>
      [name, document.querySelector(`[data-action="${name}"]`).classList.contains('active')])),
    layers: !document.querySelector('#layers-panel').hidden,
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent,
    outline: document.querySelector('#outline').value, fill: document.querySelector('#shape-fill').value,
    colors: ['primary', 'secondary'].map(id => document.getElementById(id).style.background),
    clean: document.title === 'Untitled - Stack Junkie Paint' &&
      document.querySelector('#canvas').width === 1152 && document.querySelector('#canvas').height === 648 &&
      document.querySelector('[data-action="undo"]').disabled && document.querySelector('[data-action="redo"]').disabled &&
      !document.querySelector('.text-editor'),
  }));
  if (!initial.clean) throw new Error('Text-session checks require a pristine default-size Untitled document.');
  const restoreColor = async (value, button) => {
    const selector = await page.evaluate(value => [...document.querySelectorAll('[data-color]')]
      .find(el => { const probe = document.createElement('span'); probe.style.background = el.dataset.color; return probe.style.background === value; })?.dataset.color, value);
    if (!selector) throw new Error('Text-session fixture requires palette-restorable colors.');
    await page.locator(`[data-color="${selector}"]`).click({ button });
  };
  // Reject an unrestorable fixture before changing the document.
  for (const color of initial.colors) {
    const found = await page.evaluate(value => [...document.querySelectorAll('[data-color]')].some(el => {
      const probe = document.createElement('span'); probe.style.background = el.dataset.color; return probe.style.background === value;
    }), color);
    if (!found) throw new Error('Text-session fixture requires palette-restorable colors.');
  }
  const reset = async () => {
    await page.mouse.up();
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await frame();
    for (let count = 0; count < 96 && await page.locator('[data-action="undo"]').isEnabled(); count++) {
      await page.keyboard.press('Control+z'); await frame();
    }
    if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Text-session cleanup exceeded its owned history bound.');
    await page.keyboard.press('Control+n'); await frame();
    await page.locator('#zoom-presets').selectOption('1'); await frame();
  };
  const configure = async (zoom = 1, background = false, resize = true) => {
    await reset();
    if (resize) {
      await page.keyboard.press('Control+e');
      await page.locator('#dialog [name="width"]').fill('440'); await page.locator('#dialog [name="height"]').fill('300');
      await page.locator('#dialog button[type="submit"]').click(); await frame();
    }
    await page.locator('#zoom-presets').selectOption({ label: `${zoom * 100}%` }); await frame();
    await page.locator('[data-tool="text"]').click();
    await page.locator('[data-color="#000000"]').click(); await page.locator('[data-color="#fff200"]').click({ button: 'right' });
    await page.locator('#font').selectOption('Arial'); await page.locator('#font-size').fill('24'); await page.locator('#font-size').press('Tab');
    await page.locator('[data-text-align="left"]').click(); await page.locator('#text-background').setChecked(background);
    for (const name of Object.keys(initial.styles)) {
      if (await page.locator(`[data-action="${name}"]`).evaluate(el => el.classList.contains('active'))) await page.locator(`[data-action="${name}"]`).click();
    }
    await frame();
  };
  const start = async ({ x = 20, y = 20, hold = false } = {}) => {
    const zoom = Number(await page.locator('#zoom-presets').inputValue());
    await page.locator('#viewport').evaluate((el, { x, y, zoom }) => {
      const canvas = document.querySelector('#overlay').getBoundingClientRect(), view = el.getBoundingClientRect();
      const px = canvas.left + x * zoom, py = canvas.top + y * zoom;
      if (px > view.right - 10) el.scrollLeft += px - view.right + 10;
      else if (px < view.left + 10) el.scrollLeft += px - view.left - 10;
      if (py > view.bottom - 10) el.scrollTop += py - view.bottom + 10;
      else if (py < view.top + 10) el.scrollTop += py - view.top - 10;
    }, { x, y, zoom }); await frame();
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x + x * zoom, box.y + y * zoom); await page.mouse.down();
    if (!hold) await page.mouse.up();
    await frame();
  };
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  const interruptCreation = async ending => {
    await page.locator('#overlay').evaluate((overlay, ending) => {
      if (ending === 'blur') { window.dispatchEvent(new Event('blur')); return; }
      const pointerId = Array.from({ length: 32 }, (_, index) => index).find(id => overlay.hasPointerCapture(id));
      // Text may already have released its creation pointer's capture.
      overlay.dispatchEvent(new PointerEvent(ending, { bubbles: true, pointerId: pointerId ?? 1, pointerType: 'mouse' }));
    }, ending);
    await page.mouse.up(); await frame();
  };
  // Ignore input chrome only, never glyphs, backgrounds, clipping or layers.
  const screenshot = async () => {
    await page.locator('#font-size').focus(); await frame();
    const title = await page.locator('.titlebar').boundingBox(); await page.mouse.move(title.x + 5, title.y + 5);
    const box = await page.locator('#canvas').boundingBox();
    const viewport = await page.locator('#viewport').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(innerWidth, rect.left + el.clientWidth), bottom: Math.min(innerHeight, rect.top + el.clientHeight) };
    });
    const x = Math.max(viewport.left, box.x), y = Math.max(viewport.top, box.y);
    const clip = { x, y, width: Math.min(box.x + box.width, viewport.right) - x,
      height: Math.min(box.y + box.height, viewport.bottom) - y };
    const bytes = await capture({ clip, animations: 'disabled',
      style: '.text-editor{border-color:transparent!important;caret-color:transparent!important}.text-editor::-webkit-resizer{visibility:hidden}' });
    return { data: bytes.toString('base64'), clip };
  };
  const compareShots = (before, after) => page.evaluate(async ({ before, after }) => {
    if (JSON.stringify(before.clip) !== JSON.stringify(after.clip)) return { equal: false, reason: 'Drawing viewport moved.' };
    const decode = async data => {
      const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width };
    };
    const a = await decode(before.data), b = await decode(after.data); let different = 0;
    const bounds = { left: Infinity, top: Infinity, right: -1, bottom: -1 }, samples = [];
    for (let i = 0; i < a.data.length; i += 4) {
      let changed = false;
      for (let channel = 0; channel < 4; channel++) if (a.data[i + channel] !== b.data[i + channel]) { different++; changed = true; }
      if (!changed) continue;
      const x = (i / 4) % a.width, y = Math.floor(i / 4 / a.width);
      bounds.left = Math.min(bounds.left, x); bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x); bounds.bottom = Math.max(bounds.bottom, y);
      if (samples.length < 8) samples.push({ x, y, before: [...a.data.slice(i, i + 4)], after: [...b.data.slice(i, i + 4)] });
    }
    return { equal: a.data.length === b.data.length && different === 0, differentChannels: different,
      bounds: different ? bounds : null, samples };
  }, { before, after });
  const comparePreview = async (name, before, after, canonicalEqual) => {
    const comparison = { ...await compareShots(before, after), canonicalEqual };
    if (!comparison.equal) {
      const directory = path.resolve('output'); await mkdir(directory, { recursive: true });
      const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      comparison.beforeImage = path.join(directory, `text-session-${slug}-before.png`);
      comparison.afterImage = path.join(directory, `text-session-${slug}-after.png`);
      await writeFile(comparison.beforeImage, Buffer.from(before.data, 'base64'));
      await writeFile(comparison.afterImage, Buffer.from(after.data, 'base64'));
    }
    return comparison;
  };
  try {
    for (const ending of ['pointercancel', 'lostpointercapture', 'blur']) {
      await configure(1, false, false); const baseline = await pixels(); await start({ hold: true });
      await interruptCreation(ending);
      record(`${ending} during text creation leaves a usable text session`, await page.locator('.text-editor').count() === 1);
      if (!await page.locator('.text-editor').count()) continue;
      await page.locator('.text-editor').fill('Continued after interruption');
      await page.locator('[data-action="commit-text"]').click(); await frame(); const committed = await pixels();
      record(`Apply after text-creation ${ending} paints and marks the document unsaved`, committed !== baseline &&
        await page.locator('#document-state').textContent() === 'Unsaved changes');
      await key('Control+z');
      record(`one Undo after text-creation ${ending} removes the complete text edit`, await pixels() === baseline);
      await key('Control+y');
      record(`one Redo after text-creation ${ending} restores its pixels`, await pixels() === committed);
      await configure(1, false, false); const clean = await pixels(); await start({ hold: true });
      await interruptCreation(ending); await page.locator('.text-editor').fill('Cancel this interrupted draft');
      await page.keyboard.press('Escape'); await frame();
      record(`Escape after text-creation ${ending} leaves no pixels, draft or history`, await pixels() === clean &&
        !await page.locator('.text-editor').count() && await page.locator('[data-action="undo"]').isDisabled() &&
        await page.locator('[data-action="redo"]').isDisabled() && !await page.locator('#document-state').textContent());
    }
    await configure(1, false, false); const compositionBaseline = await pixels(); await start();
    await page.locator('.text-editor').fill('Keep the composing draft');
    // Synthetic event routing only. This does not exercise an installed OS IME.
    await page.locator('.text-editor').evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', isComposing: true }));
    }); await frame();
    const composingDraft = await page.locator('.text-editor').count() === 1 &&
      await page.locator('.text-editor').inputValue() === 'Keep the composing draft';
    record('synthetic composing Escape stays with the text input instead of discarding its session', composingDraft);
    if (await page.locator('.text-editor').count()) {
      await page.locator('.text-editor').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
      await page.keyboard.press('Escape'); await frame();
    }
    record('ordinary Escape after composition cancels the draft without pixels or history', await pixels() === compositionBaseline &&
      !await page.locator('.text-editor').count() && await page.locator('[data-action="undo"]').isDisabled() &&
      await page.locator('[data-action="redo"]').isDisabled() && !await page.locator('#document-state').textContent());
    const cases = [
      { name: 'opaque one-line', text: 'Short line', opaque: true },
      { name: 'opaque multiline', text: 'First line\n\nThird line\n', opaque: true },
      { name: 'long text after attempted internal scrolling', text: Array.from({ length: 10 }, (_, i) => `Line ${i + 1}: complete text`).join('\n'), scroll: true },
      { name: 'document-edge clipped', text: 'Text extends beyond the document edge\nand below it', opaque: true, x: 380, y: 250 },
    ];
    for (const zoom of [0.5, 1, 2]) for (const test of cases) {
      await configure(zoom, test.opaque); const baseline = await pixels(); await start(test);
      await page.locator('.text-editor').fill(test.text); await frame();
      if (test.scroll) {
        await page.locator('.text-editor').evaluate(el => { el.scrollTop = 70; el.scrollLeft = 20; el.dispatchEvent(new Event('scroll')); }); await frame();
        const scroll = await page.locator('.text-editor').evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft, text: el.value }));
        record(`text at ${zoom * 100}% keeps complete source and aligned editing after internal scroll`, scroll.top === 0 && scroll.left === 0 && scroll.text === test.text, scroll);
      }
      const preview = await screenshot(), previewPixels = await pixels();
      await page.locator('[data-action="commit-text"]').click(); await frame(); const committed = await pixels();
      const comparison = await comparePreview(`${test.name}-${zoom * 100}`, preview, await screenshot(), previewPixels === committed);
      record(`${test.name} at ${zoom * 100}% looks identical before and after Apply`, comparison.equal, comparison);
      record(`${test.name} at ${zoom * 100}% produces document pixels`, committed !== baseline);
      await key('Control+z'); record(`${test.name} at ${zoom * 100}% is one undoable edit`, await pixels() === baseline);
      await key('Control+y'); record(`${test.name} at ${zoom * 100}% survives Redo exactly`, await pixels() === committed);
    }
    await configure(); const typingBaseline = await pixels(); await start();
    const originalText = 'first\nsecond\nthird\nfourth\nfifth\nsixth';
    await page.locator('.text-editor').fill(originalText); await page.keyboard.press('Control+End');
    await page.keyboard.press('Backspace'); await page.keyboard.type('!'); await frame();
    const typing = await page.locator('.text-editor').evaluate(el => ({ text: el.value, start: el.selectionStart,
      end: el.selectionEnd, top: el.scrollTop, left: el.scrollLeft, height: el.clientHeight, content: el.scrollHeight }));
    const expectedText = originalText.slice(0, -1) + '!';
    record('multiline End and Backspace keep the caret at complete text with no internal clipping',
      typing.text === expectedText && typing.start === expectedText.length && typing.end === expectedText.length &&
      typing.top === 0 && typing.left === 0 && typing.height >= typing.content, typing);
    await page.locator('[data-action="commit-text"]').click(); await frame(); await key('Control+z');
    record('continued multiline keyboard editing remains one undoable operation', await pixels() === typingBaseline);
    const caretViewport = page.viewportSize();
    try {
    // A taller headless viewport concealed the packaged Windows scroll defect.
    await page.setViewportSize({ width: 1300, height: 700 });
    await configure(2); await start(); await page.locator('.text-editor').fill('Row 1');
    for (let row = 2; row <= 9; row++) {
      await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type(`Row ${row}`); await frame();
    }
    const caretPosition = () => page.locator('.text-editor').evaluate(el => {
      const css = getComputedStyle(el), rect = el.getBoundingClientRect(), mirror = document.createElement('div');
      for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
        'letterSpacing', 'wordSpacing', 'lineHeight', 'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize', 'textAlign', 'direction']) mirror.style[name] = css[name];
      const left = (parseFloat(css.paddingLeft) || 0) + (parseFloat(css.borderLeftWidth) || 0);
      const top = (parseFloat(css.paddingTop) || 0) + (parseFloat(css.borderTopWidth) || 0);
      Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', pointerEvents: 'none',
        left: `${rect.left + left - el.scrollLeft}px`, top: `${rect.top + top - el.scrollTop}px`,
        width: `${el.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0)}px`,
        margin: '0', padding: '0', border: '0', height: 'auto' });
      const marker = document.createElement('span'); marker.textContent = '\u200b';
      mirror.append(document.createTextNode(el.value.slice(0, el.selectionEnd)), marker,
        document.createTextNode(el.value.slice(el.selectionEnd))); document.body.append(mirror);
      try {
        const position = marker.getBoundingClientRect(), viewport = document.querySelector('#viewport'), view = viewport.getBoundingClientRect();
        const canvas = document.querySelector('#canvas').getBoundingClientRect();
        return { visible: position.top >= Math.max(view.top, canvas.top) &&
          position.bottom <= Math.min(view.top + viewport.clientHeight, canvas.bottom) &&
          position.left >= Math.max(view.left, canvas.left) && position.right <= Math.min(view.left + viewport.clientWidth, canvas.right),
        caret: { top: position.top, bottom: position.bottom, left: position.left },
        viewport: { top: view.top, bottom: view.top + viewport.clientHeight },
        text: el.value, start: el.selectionStart, end: el.selectionEnd };
      } finally { mirror.remove(); }
    });
    const caret = await caretPosition();
    record('typing a ninth visible document line at 200% keeps the real caret within the viewport', caret.visible &&
      caret.text.endsWith('Row 9') && caret.start === caret.text.length && caret.end === caret.text.length, caret);
    await page.keyboard.press('Control+Home'); await frame();
    const first = await caretPosition();
    record('multiline keyboard navigation reveals the first caret without changing text', first.visible && first.start === 0 && first.end === 0 && first.text === caret.text, first);
    await page.keyboard.press('Control+End'); await frame();
    const last = await caretPosition();
    record('multiline keyboard navigation reveals the last caret without changing text', last.visible && last.start === caret.text.length && last.end === caret.text.length && last.text === caret.text, last);
    } finally {
      if (caretViewport) await page.setViewportSize(caretViewport);
      else {
        const session = await page.context().newCDPSession(page);
        try { await session.send('Emulation.clearDeviceMetricsOverride'); } finally { await session.detach(); }
      }
    }
    await configure(); await start(); await page.locator('.text-editor').fill('MMMMMMMM');
    await page.keyboard.press('Control+a'); await frame();
    const selectedBox = await page.locator('.text-editor').boundingBox();
    const selectedPng = await capture({ clip: { x: selectedBox.x + 3, y: selectedBox.y + 3, width: 170, height: 24 },
      style: '.text-editor{caret-color:transparent!important}' });
    const selection = await page.evaluate(async encoded => {
      const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; let dark = 0, highlighted = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [r, g, b] = pixels.slice(i, i + 3);
        if (Math.max(r, g, b) < 100) dark++;
        if (r > 130 && b > r + 20 && g > r) highlighted++;
      }
      return { dark, highlighted, focused: document.activeElement === document.querySelector('.text-editor'),
        selected: document.querySelector('.text-editor').selectionEnd - document.querySelector('.text-editor').selectionStart };
    }, selectedPng.toString('base64'));
    record('focused selected text retains legible dark glyphs beneath its selection highlight',
      selection.focused && selection.selected === 8 && selection.dark > 20 && selection.highlighted > 20, selection);
    await configure(1, true);
    if (!await page.locator('#layers-panel').isVisible()) await page.locator('.layers-group [data-action="layers"]').click();
    const lower = await page.locator('#layer-list [data-layer-select]').getAttribute('data-layer-select');
    await page.locator('#layer-opacity').focus(); await page.keyboard.press('Home');
    for (let i = 0; i < 50; i++) await page.keyboard.press('ArrowRight');
    await page.locator('[data-action="add-layer"]').click();
    await chooseShapeStyle(page, 'outline', 'none'); await chooseShapeStyle(page, 'fillStyle', 'solid');
    await page.locator('[data-tool="rectangle"]').click(); await page.locator('[data-color="#3f48cc"]').click({ button: 'right' });
    await start({ x: 90, y: 1, hold: true });
    const box = await page.locator('#overlay').boundingBox(); await page.mouse.move(box.x + 130, box.y + 280); await page.mouse.up();
    await page.locator('[data-tool="text"]').click(); await page.locator(`[data-layer-select="${lower}"]`).click();
    await page.locator('[data-color="#fff200"]').click({ button: 'right' }); await frame();
    const baseline = await pixels(); await start(); await page.locator('.text-editor').fill('Text across the foreground'); await frame();
    const preview = await screenshot(), previewPixels = await pixels(); await page.locator('[data-action="commit-text"]').click(); await frame();
    const committed = await pixels(), comparison = await comparePreview('layer-composite', preview, await screenshot(), previewPixels === committed);
    record('text preview honors 50% layer opacity and upper-layer occlusion exactly as Apply', comparison.equal, comparison);
    await key('Control+z'); record('one Undo of composited text preserves both fixture layers', await pixels() === baseline);
    await key('Control+y'); record('Redo restores composited text exactly', await pixels() === committed);
  } finally {
    if (await page.locator('#dialog').evaluate(el => el.open)) await page.locator('#dialog-cancel').click();
    await reset(); await page.locator('[data-tool="text"]').click();
    await page.locator('#font').selectOption(initial.font); await page.locator('#font-size').fill(initial.size); await page.locator('#font-size').press('Tab');
    await page.locator(`[data-text-align="${initial.align}"]`).click(); await page.locator('#text-background').setChecked(initial.background);
    for (const [name, active] of Object.entries(initial.styles)) if (await page.locator(`[data-action="${name}"]`).evaluate(el => el.classList.contains('active')) !== active)
      await page.locator(`[data-action="${name}"]`).click();
    await restoreColor(initial.colors[0], 'left'); await restoreColor(initial.colors[1], 'right');
    await chooseShapeStyle(page, 'outline', initial.outline); await chooseShapeStyle(page, 'fillStyle', initial.fill);
    if (initial.tool) await page.locator(`[data-tool="${initial.tool}"]`).click();
    else { await page.locator('[data-menu="brushes"]').click(); await page.getByRole('menuitemradio', { name: initial.label, exact: true }).click(); }
    if (await page.locator('#layers-panel').isVisible() !== initial.layers) await page.locator('.layers-group [data-action="layers"]').click();
    await page.locator('#zoom-presets').selectOption(initial.zoom); await frame();
  }
  record('text-session fixture restores blank pixels and pristine history', await pixels() === initial.pixels &&
    await page.locator('[data-action="undo"]').isDisabled() && await page.locator('[data-action="redo"]').isDisabled());
  for (const result of results) check(result.name, result.ok, result.detail);
}

export async function verifyTextSession(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(); await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await verifyTextSessionDesktop(target, check);
    const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await target.locator('#zoom-presets').selectOption('1'); await target.locator('[data-tool="text"]').click();
    const box = await target.locator('#overlay').boundingBox(); await target.mouse.move(box.x + 25, box.y + 25); await target.mouse.down();
    await target.evaluate(() => window.dispatchEvent(new Event('blur'))); await target.mouse.up();
    await target.locator('.text-editor').fill('Save the interrupted text session'); await frame();
    const preview = await target.locator('#canvas').evaluate(canvas => canvas.toDataURL());
    const downloadPromise = target.waitForEvent('download');
    await target.keyboard.press('Control+s'); await target.locator('#dialog [name="name"]').fill('text-session');
    await target.locator('#dialog [name="format"]').selectOption('png'); await target.locator('#dialog button[type="submit"]').click();
    const download = await downloadPromise, stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const encoded = Buffer.concat(chunks).toString('base64');
    await target.waitForFunction(() => !document.querySelector('#document-state').textContent); await frame();
    const saved = await target.evaluate(async ({ encoded, preview }) => {
      const decode = async source => {
        const image = new Image(); image.src = source; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, bytes: context.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const output = await decode(`data:image/png;base64,${encoded}`), intended = await decode(preview);
      return { equal: output.width === intended.width && output.height === intended.height &&
        output.bytes.length === intended.bytes.length && output.bytes.every((value, index) => value === intended.bytes[index]),
      clean: !document.querySelector('#document-state').textContent, editor: Boolean(document.querySelector('.text-editor')) };
    }, { encoded, preview });
    check('Ctrl+S after interrupted text downloads the intended PNG pixels and clears saved state',
      saved.equal && saved.clean && !saved.editor && download.suggestedFilename() === 'text-session.png', saved);
  } finally { await context.close(); }
}
