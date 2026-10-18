import { chooseShapeStyle } from './shape-style-controls.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

// One uninterrupted public editing journey. Only the resulting DOM, rendered
// pixels and actual downloaded project are inspected; no engine commands run.
export async function verifyConnectedEditor(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    const target = await context.newPage(), errors = [];
    target.on('pageerror', error => errors.push(error.message));
    await target.goto(page.url()); await target.locator('#overlay').waitFor();
    const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pixels = () => target.locator('#canvas').evaluate(canvas => canvas.toDataURL());
    // Read-only diagnostics inspect source surfaces only after the real public
    // workflow. Decode copies to avoid changing live canvas raster backends.
    const comparePng = (before, after) => target.evaluate(async ({ before, after }) => {
      if (!before || !after) return { available: false };
      const decode = async png => {
        const image = new Image(); image.src = png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const c = canvas.getContext('2d', { willReadFrequently: true }); c.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, rgba: c.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const a = await decode(before), b = await decode(after);
      if (a.width !== b.width || a.height !== b.height) return { available: true, sameDimensions: false, before: [a.width, a.height], after: [b.width, b.height] };
      let pixels = 0, maxChannelDelta = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
      const samples = [];
      for (let offset = 0; offset < a.rgba.length; offset += 4) {
        if (a.rgba.subarray(offset, offset + 4).every((value, channel) => value === b.rgba[offset + channel])) continue;
        const x = offset / 4 % a.width, y = Math.floor(offset / 4 / a.width); pixels++;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        for (let channel = 0; channel < 4; channel++) maxChannelDelta = Math.max(maxChannelDelta, Math.abs(a.rgba[offset + channel] - b.rgba[offset + channel]));
        if (samples.length < 10) samples.push({ x, y, before: [...a.rgba.subarray(offset, offset + 4)], after: [...b.rgba.subarray(offset, offset + 4)] });
      }
      return { available: true, sameDimensions: true, pixels, maxChannelDelta, bounds: pixels ? { minX, minY, maxX, maxY } : null, samples };
    }, { before, after });
    const displayedScreenshot = async () => {
      const title = await target.locator('.titlebar').boundingBox(); await target.mouse.move(title.x + 5, title.y + 5);
      const clip = await target.locator('#canvas').evaluate(canvas => {
        const rect = canvas.getBoundingClientRect(), viewport = document.querySelector('#viewport'), view = viewport.getBoundingClientRect();
        const x = Math.max(0, rect.left, view.left), y = Math.max(0, rect.top, view.top);
        return { x, y, width: Math.min(innerWidth, rect.right, view.left + viewport.clientWidth) - x,
          height: Math.min(innerHeight, rect.bottom, view.top + viewport.clientHeight) - y };
      });
      const bytes = await target.screenshot({ clip, animations: 'disabled',
        style: '.text-editor{border-color:transparent!important;caret-color:transparent!important}.text-editor::-webkit-resizer{visibility:hidden}' });
      return { clip, png: `data:image/png;base64,${bytes.toString('base64')}` };
    };
    const diagnostic = displayedPng => target.evaluate(async displayedPng => {
      const describePng = async png => {
        if (!png) return null;
        const image = new Image(); image.src = png; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = await crypto.subtle.digest('SHA-256', rgba);
        return { width: canvas.width, height: canvas.height,
          rgbaSha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
      };
      const editor = document.querySelector('.text-editor'), active = window.paintApp?.doc.activeLayer;
      return { displayed: await describePng(displayedPng),
        activeLayer: active ? { name: active.name, opacity: active.opacity, visible: active.visible,
          pixels: await describePng(active.canvas.toDataURL()) } : null,
        opacityControl: document.querySelector('#layer-opacity').value,
        textarea: editor ? { value: editor.value, width: editor.clientWidth, height: editor.clientHeight,
          scrollTop: editor.scrollTop, background: getComputedStyle(editor).backgroundColor,
          color: getComputedStyle(editor).color, font: getComputedStyle(editor).font,
          letterSpacing: getComputedStyle(editor).letterSpacing, wordSpacing: getComputedStyle(editor).wordSpacing,
          align: getComputedStyle(editor).textAlign } : null,
        focused: document.activeElement?.className || document.activeElement?.id || document.activeElement?.tagName };
    }, displayedPng);
    const key = async value => { await target.locator('#overlay').focus(); await target.keyboard.press(value); await frame(); };
    const move = async (x, y) => {
      const bounds = await target.locator('#overlay').boundingBox();
      const zoom = Number(await target.locator('#zoom-presets').inputValue());
      await target.mouse.move(bounds.x + x * zoom, bounds.y + y * zoom, { steps: 6 }); await frame();
    };
    const drag = async (x1, y1, x2, y2) => {
      await move(x1, y1); await target.mouse.down(); await move(x2, y2); await target.mouse.up(); await frame();
    };
    const click = async (x, y) => { await move(x, y); await target.mouse.down(); await target.mouse.up(); await frame(); };
    const undoRedo = async (before, accepted, name) => {
      await key('Control+z'); check(`${name}: one Undo restores preceding artwork`, await pixels() === before);
      await key('Control+y'); check(`${name}: one Redo restores accepted pixels`, await pixels() === accepted);
    };
    await key('Control+e');
    await target.locator('#dialog [name="width"]').fill('640'); await target.locator('#dialog [name="height"]').fill('420');
    await target.locator('#dialog button[type="submit"]').click();
    await target.locator('#zoom-presets').selectOption('1'); await frame();
    const blank = await pixels();
    await target.locator('[data-tool="pencil"]').click(); await drag(25, 30, 90, 60);
    const drawing = await pixels();
    check('connected journey creates a visible pencil drawing', drawing !== blank);

    await target.locator('[data-tool="curve"]').click();
    await chooseShapeStyle(target, 'outline', 'solid'); await chooseShapeStyle(target, 'fillStyle', 'none');
    await drag(180, 50, 320, 80); await click(220, 140); await click(280, 20);
    const curved = await pixels();
    check('connected journey accepts a two-control curve beside existing artwork', curved !== drawing);
    await undoRedo(drawing, curved, 'connected curve');

    await target.locator('[data-tool="rectangle"]').click(); await drag(360, 40, 470, 120);
    const plainPreview = await pixels();
    await target.locator('[data-color="#ed1c24"]').click();
    await target.locator('[data-color="#fff200"]').click({ button: 'right' });
    await chooseShapeStyle(target, 'fillStyle', 'solid'); await frame();
    const styledPreview = await pixels();
    check('connected pending shape responds to palette and fill changes', styledPreview !== plainPreview);
    await target.locator('[data-tool="select"]').click(); await frame();
    check('connected styled shape commits exactly as previewed', await pixels() === styledPreview);

    await drag(15, 20, 110, 80);
    await target.waitForFunction(() => document.querySelector('#selection-size').textContent.trim() === '95 × 60px');
    await drag(110, 80, 130, 100);
    await target.waitForFunction(() => document.querySelector('#selection-size').textContent.trim() === '115 × 80px');
    await key('Shift+ArrowRight'); await key('Shift+ArrowDown'); await key('Control+Space');
    const transformed = await pixels();
    check('connected selection resize and move changes the pencil region', transformed !== styledPreview);
    await undoRedo(styledPreview, transformed, 'connected selection transform');

    await target.locator('.layers-group [data-action="layers"]').click();
    await target.locator('[data-action="add-layer"]').click();
    await target.locator('[data-action="rename-layer"]').click();
    await target.locator('#dialog [name="name"]').fill('Caption');
    await target.locator('#dialog button[type="submit"]').click();
    await target.locator('#layer-opacity').focus(); await target.keyboard.press('Home');
    for (let i = 0; i < 50; i++) await target.keyboard.press('ArrowRight');
    await target.locator('[data-tool="text"]').click();
    await target.locator('[data-color="#000000"]').click();
    await target.locator('#text-background').check();
    await click(50, 190); await target.locator('.text-editor').fill('Curves, shapes and layers'); await frame();
    const textPreview = await pixels();
    const scratchPreview = await target.evaluate(() => window.paintApp?.doc._compositeScratch?.toDataURL() ?? null);
    const viewportPreview = await displayedScreenshot(), previewState = await diagnostic(textPreview);
    await target.locator('[data-action="commit-text"]').click(); await frame();
    const finished = await pixels();
    const acceptedLayer = await target.evaluate(() => window.paintApp?.doc.activeLayer.canvas.toDataURL() ?? null);
    const viewportCommitted = await displayedScreenshot();
    let pixelDifference = null, sourceDifference = null, viewportDifference = null;
    if (finished !== textPreview) {
      pixelDifference = await comparePng(textPreview, finished);
      sourceDifference = await comparePng(scratchPreview, acceptedLayer);
      viewportDifference = { ...await comparePng(viewportPreview.png, viewportCommitted.png),
        sameClip: JSON.stringify(viewportPreview.clip) === JSON.stringify(viewportCommitted.clip) };
      const directory = new URL('../output/', import.meta.url); await mkdir(directory, { recursive: true });
      await writeFile(new URL('connected-editor-preview.png', directory), Buffer.from(textPreview.split(',')[1], 'base64'));
      await writeFile(new URL('connected-editor-committed.png', directory), Buffer.from(finished.split(',')[1], 'base64'));
      for (const [name, png] of [['scratch-preview', scratchPreview], ['accepted-layer', acceptedLayer],
        ['viewport-preview', viewportPreview.png], ['viewport-committed', viewportCommitted.png]]) {
        if (png) await writeFile(new URL(`connected-editor-${name}.png`, directory), Buffer.from(png.split(',')[1], 'base64'));
      }
    }
    check('connected layered opaque text commits exactly as previewed', finished === textPreview && finished !== transformed,
      { previewEqual: finished === textPreview, changed: finished !== transformed, preview: previewState,
        committed: await diagnostic(finished), pixelDifference, sourceDifference, viewportDifference });
    await undoRedo(transformed, finished, 'connected text');

    await key('Control+Shift+s');
    await target.locator('#dialog [name="name"]').fill('connected-journey');
    await target.locator('#dialog [name="format"]').selectOption('sjpaint');
    const downloading = target.waitForEvent('download');
    await target.locator('#dialog button[type="submit"]').click();
    const download = await downloading, stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks), project = JSON.parse(bytes);
    check('connected project download preserves two editable layers and caption opacity',
      project.format === 'sj-paint' && project.width === 640 && project.height === 420 && project.layers.length === 2 &&
      project.layers[1].name === 'Caption' && project.layers[1].opacity === .5 && project.layers.every(layer => layer.visible));
    await target.waitForFunction(() => !document.title.includes('•'));
    await key('Control+n');
    await target.waitForFunction(() => document.title.startsWith('Untitled - '));
    const choosing = target.waitForEvent('filechooser'); await key('Control+o');
    await (await choosing).setFiles({ name: 'connected-journey.sjpaint', mimeType: 'application/json', buffer: bytes });
    await target.waitForFunction(() => document.title.startsWith('connected-journey - '));
    check('connected project reopen preserves exact composite, layers and active opacity', await pixels() === finished &&
      await target.locator('#layer-list [data-layer-select]').count() === 2 && await target.locator('#layer-opacity').inputValue() === '50');
    check('connected project reopen starts clean without persisted undo history',
      await target.locator('[data-action="undo"]').isDisabled() && await target.locator('[data-action="redo"]').isDisabled());
    await target.locator('[data-tool="pencil"]').click(); await drag(400, 250, 500, 280);
    const continued = await pixels();
    check('connected project remains editable after reopening', continued !== finished);
    await undoRedo(finished, continued, 'connected edit after reopen');
    check('connected editing journey has no renderer errors', errors.length === 0, errors);
  } finally { await context.close(); }
}
