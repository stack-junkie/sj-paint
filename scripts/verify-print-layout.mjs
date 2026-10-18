// Public Print dispatch with an owned deferred bridge, never a native printer.
// Optional inspectPdf(Buffer) supplies an independent raster oracle locally.
export async function verifyPrintLayout(page, check, { inspectPdf } = {}) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state }, theme: document.documentElement.dataset.theme }));
  await page.evaluate(() => {
    const q = window.__printLayout = { descriptor: Object.getOwnPropertyDescriptor(window, 'paintDesktop'), calls: 0,
      styles: document.head.querySelectorAll('style').length, release: null, fail: false, decode: HTMLImageElement.prototype.decode };
    Object.defineProperty(window, 'paintDesktop', { configurable: true, value: {
      setTitle() {},
      print() {
        q.calls++;
        if (q.fail) return Promise.reject(new Error('Private print failure'));
        return new Promise(resolve => { q.release = resolve; });
      },
    } });
  });
  const start = async () => {
    const count = await page.evaluate(() => __printLayout.calls);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+p');
    await page.waitForFunction(previous => __printLayout.calls === previous + 1, count);
  };
  const finish = async () => {
    await page.evaluate(() => { __printLayout.release?.(true); __printLayout.release = null; });
    await page.waitForFunction(() => !document.querySelector('#paint-print-document'));
  };
  const snapshot = () => page.evaluate(() => JSON.stringify({ project: paintApp.doc.serialize(), revision: paintApp.doc.revision,
    dirty: paintApp.doc.dirty, undo: paintApp.doc._undo.length, redo: paintApp.doc._redo.length }));
  try {
    for (const [shape, width, height] of [['portrait', 240, 2400], ['landscape', 2400, 240]]) for (const theme of ['dark', 'light']) {
      await page.evaluate(({ width, height, theme }) => {
        document.documentElement.dataset.theme = theme;
        paintApp.doc.newDocument(width, height); paintApp.doc.setBackground(null);
        const ctx = paintApp.doc.activeLayer.canvas.getContext('2d');
        ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, width / 3, height / 8);
        ctx.fillStyle = '#0000ff'; ctx.fillRect(width * 2 / 3, height * 7 / 8, width / 3, height / 8);
        paintApp.doc.markSaved(); paintApp.setZoom(.125);
      }, { width, height, theme });
      const before = await snapshot();
      await start();
      const source = await page.evaluate(() => {
        const image = document.querySelector('#paint-print-document img'), c = document.createElement('canvas');
        c.width = image.naturalWidth; c.height = image.naturalHeight; c.getContext('2d').drawImage(image, 0, 0);
        return { matches: image.src === paintApp.doc.composite().toDataURL('image/png'),
          alpha: c.getContext('2d').getImageData(Math.floor(c.width / 2), 0, 1, 1).data[3],
          hidden: getComputedStyle(document.querySelector('#paint-print-document')).display === 'none' };
      });
      check(`${shape} ${theme} Print captures unchanged transparent pixels and stays hidden on screen`, source.matches && source.alpha === 0 && source.hidden, source);
      await page.emulateMedia({ media: 'print' });
      const layout = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement), body = getComputedStyle(document.body);
        const image = document.querySelector('#paint-print-document img'), rect = image.getBoundingClientRect();
        return { rootOverflow: root.overflow, bodyOverflow: body.overflow, background: body.backgroundColor,
          width: rect.width, height: rect.height, aspect: image.naturalWidth / image.naturalHeight,
          appHidden: getComputedStyle(document.querySelector('#app')).display === 'none',
          margin: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.cssText.includes('@media print'))
            .some(rule => /@page\s*\{\s*margin:\s*12mm/.test(rule.cssText)) };
      });
      check(`${shape} ${theme} Print isolates paper from screen clipping and theme`, layout.rootOverflow === 'visible' && layout.bodyOverflow === 'visible' &&
        layout.background === 'rgb(255, 255, 255)' && layout.appHidden && layout.margin && Math.abs(layout.width / layout.height - layout.aspect) < .001, layout);
      if (inspectPdf) {
        const raster = await inspectPdf(await page.pdf({ format: 'Letter', printBackground: true }), `${shape}-${theme}`);
        check(`${shape} ${theme} rendered PDF preserves both distant markers and white transparent paper`,
          raster.red > 0 && raster.blue > 0 && raster.dark === 0 && raster.paperWhite && (shape === 'portrait' ? raster.pages > 1 : raster.pages === 1), raster);
      }
      await page.emulateMedia({ media: 'screen' }); await finish();
      check(`${shape} ${theme} Print leaves document and history unchanged and removes owned styles`, before === await snapshot() &&
        await page.evaluate(() => document.head.querySelectorAll('style').length === __printLayout.styles));
    }
    if (!inspectPdf) check.skip('independent PDF raster inspection', 'Run scripts/verify-print-pdf.mjs with an existing Python PyMuPDF installation.');

    await start();
    const calls = await page.evaluate(() => __printLayout.calls);
    await page.keyboard.press('Control+p');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('Finish the current print'));
    check('a concurrent Print cannot create another print document or invoke the bridge twice', await page.evaluate(calls =>
      __printLayout.calls === calls && document.querySelectorAll('#paint-print-document').length === 1, calls));
    await finish();

    const decodeCalls = await page.evaluate(() => {
      HTMLImageElement.prototype.decode = function () { return Promise.reject(new Error('Private print image failure')); };
      return __printLayout.calls;
    });
    const decodeFailure = page.waitForEvent('console', { predicate: e => e.type() === 'error' && e.text().includes('Private print image failure') });
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+p'); await decodeFailure;
    check('failed print image decoding cleans up before any bridge call', await page.evaluate(calls =>
      __printLayout.calls === calls && !document.querySelector('#paint-print-document') &&
      document.head.querySelectorAll('style').length === __printLayout.styles, decodeCalls));
    await page.evaluate(() => { HTMLImageElement.prototype.decode = __printLayout.decode; });

    await page.evaluate(() => { __printLayout.fail = true; });
    const failure = page.waitForEvent('console', { predicate: e => e.type() === 'error' && e.text().includes('Private print failure') });
    await start(); await failure;
    await page.waitForFunction(() => !document.querySelector('#paint-print-document'));
    check('a failed print removes its document and stylesheet', await page.evaluate(() => document.head.querySelectorAll('style').length === __printLayout.styles));
    await page.evaluate(() => { __printLayout.fail = false; });
    await start(); await finish();
    check('Print can be retried after bridge failure', await page.evaluate(() => !document.querySelector('#paint-print-document')));
  } finally {
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(async initial => {
      const q = __printLayout; q.release?.(false);
      await new Promise(resolve => setTimeout(resolve, 0));
      HTMLImageElement.prototype.decode = q.decode;
      if (q.descriptor) Object.defineProperty(window, 'paintDesktop', q.descriptor); else delete window.paintDesktop;
      delete window.__printLayout;
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state);
      document.documentElement.dataset.theme = initial.theme; paintApp.setZoom(initial.state.zoom);
    }, initial);
  }
}
