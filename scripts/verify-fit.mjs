export async function verifyFit(page, check) {
  const viewport = page.viewportSize();
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  try {
    for (const size of [{ width: 1024, height: 768 }, { width: 640, height: 700 }]) {
      await page.setViewportSize(size);
      for (const [width, height] of [[1152, 648], [600, 1200], [1400, 300]]) {
        await page.evaluate(({ width, height }) => {
          paintApp.doc.newDocument(width, height); paintApp.state.layers = false;
          document.querySelector('#layers-panel').hidden = true;
        }, { width, height });
        await frame();
        const results = [];
        for (const zoom of ['50%', '200%']) {
          await page.locator('#zoom-presets').selectOption({ label: zoom }); await frame();
          await page.locator('#overlay').focus(); await page.keyboard.press('Control+1'); await frame();
          results.push(await page.evaluate(() => {
            const v = document.querySelector('#viewport'), c = document.querySelector('#canvas').getBoundingClientRect();
            const css = getComputedStyle(v), px = name => parseFloat(css[name]) || 0;
            return { zoom: paintApp.state.zoom, width: c.width, height: c.height,
              availableWidth: v.clientWidth - px('paddingLeft') - px('paddingRight'),
              availableHeight: v.clientHeight - px('paddingTop') - px('paddingBottom'),
              overflowX: v.scrollWidth - v.clientWidth, overflowY: v.scrollHeight - v.clientHeight,
              dirty: paintApp.doc.dirty, undo: paintApp.doc.canUndo };
          }));
        }
        check(`Fit has the same scale from both zoom directions at ${size.width}px for ${width}x${height}`,
          results[0].zoom === results[1].zoom, results);
        check(`Fit respects responsive padding without scrollbars or edits at ${size.width}px for ${width}x${height}`,
          results.every(r => r.width <= r.availableWidth + 1 && r.height <= r.availableHeight + 1 &&
            r.overflowX <= 1 && r.overflowY <= 1 && !r.dirty && !r.undo), results);
      }
    }
  } finally {
    await page.setViewportSize(viewport);
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state);
      document.querySelector('#layers-panel').hidden = !initial.state.layers; paintApp.setZoom(initial.state.zoom);
    }, initial);
    await frame();
  }
}
