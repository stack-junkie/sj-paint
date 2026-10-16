// Simulated backend contract coverage. Fixture/race setup uses the DEV document
// owner; every background-removal operation starts through its public controls.
// This does not run a model or establish native backend inference coverage.
export async function verifyBackgroundRemoval(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  try {
    await context.addInitScript(() => {
      const mock = window.__backgroundMock = { requests: [], cancels: [], pending: new Map(), cancelPending: new Map(), configured: true };
      window.paintDesktop = {
        setTitle: () => {},
        localAiStatus: async () => ({ ok: true, value: { configured: mock.configured, bounds: { maxPixels: 16_000_000, maxPngBytes: 64 * 1024 * 1024 } } }),
        localAiRun: request => new Promise(resolve => {
          mock.requests.push(request); mock.pending.set(request.id, { request, resolve });
        }),
        localAiCancel: ({ id }) => new Promise(resolve => { mock.cancels.push(id); mock.cancelPending.set(id, resolve); }),
      };
      mock.acknowledgeCancellation = () => {
        for (const resolve of mock.cancelPending.values()) resolve({ ok: true, value: { canceled: true } });
        mock.cancelPending.clear();
      };
      mock.finish = (mode = 'success', id = mock.requests.at(-1)?.id) => {
        const pending = mock.pending.get(id);
        if (!pending) throw new Error('No simulated request exists for completion.');
        mock.pending.delete(id);
        if (mode === 'failure') return pending.resolve({ ok: false, error: { code: 'BACKEND_FAILED', message: 'Simulated inference failed.' } });
        const { width, height } = pending.request;
        const mask = new Uint8Array(mode === 'malformed' ? width * height - 1 : width * height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask[y * width + x] = x < 4 ? 0 : x < 8 ? 128 : 255;
        pending.resolve({ ok: true, value: { mask, width, height, metadata: { model: 'simulated-fixture' } } });
      };
    });
    const target = await context.newPage(); await target.goto(page.url()); await target.waitForFunction(() => window.paintApp);
    const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const button = target.getByRole('button', { name: 'Remove background', exact: true });
    check('simulated background removal exposes its public control', await button.count() === 1);
    check('background removal control stays above the Image group label', await button.evaluate(el => {
      const bounds = el.getBoundingClientRect(), group = el.closest('.image-group');
      const label = group.querySelector('.group-label').getBoundingClientRect(), parent = group.getBoundingClientRect();
      return bounds.bottom <= label.top && bounds.left >= parent.left && bounds.right <= parent.right;
    }));
    const fixture = async () => {
      await target.evaluate(async () => {
        const png = (color, partial = false) => {
          const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 8;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 12, 8);
          if (partial) {
            ctx.clearRect(0, 0, 2, 8); ctx.clearRect(5, 0, 1, 8); ctx.clearRect(9, 0, 1, 8);
            ctx.globalAlpha = .5; for (const x of [1, 5, 9]) ctx.fillRect(x, 0, 1, 8);
          }
          return canvas.toDataURL();
        };
        await paintApp.doc.load({ format: 'sj-paint', version: 1, width: 12, height: 8, background: null,
          layers: [{ id: 'lower', name: 'Untouched lower', visible: true, opacity: .4, png: png('#1234aa') },
            { id: 'active', name: 'Active subject', visible: true, opacity: .7, png: png('#e07020', true) }], activeLayerId: 'active' });
      }); await frame();
    };
    const snapshot = () => target.evaluate(() => {
      const doc = paintApp.doc;
      return { content: JSON.stringify(doc.serialize()), undo: doc.canUndo, redo: doc.canRedo, dirty: doc.dirty,
        revision: doc.revision, active: doc.activeLayerId, selection: Boolean(doc.selection),
        layers: doc.layers.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity,
          pixels: [...layer.canvas.getContext('2d').getImageData(0, 0, doc.width, doc.height).data] })) };
    });
    const unchanged = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const start = async () => {
      const previous = await target.evaluate(() => __backgroundMock.requests.length);
      await button.click(); await target.waitForFunction(count => __backgroundMock.requests.length === count + 1, previous);
      return target.evaluate(() => __backgroundMock.requests.at(-1).id);
    };
    const apply = () => target.locator('.background-removal-dialog[open]').getByRole('button', { name: 'Apply', exact: true });
    const cancel = () => target.locator('.background-removal-dialog[open]').getByRole('button', { name: 'Cancel', exact: true });
    const finish = async mode => { await target.evaluate(mode => __backgroundMock.finish(mode), mode); await frame(); };
    const acknowledgeCancellation = async () => { await target.evaluate(() => __backgroundMock.acknowledgeCancellation()); await frame(); };
    const closeError = async () => {
      if (await target.locator('.background-removal-dialog[open]').count()) {
        if (await cancel().count()) await cancel().click();
        else await target.keyboard.press('Escape');
      }
      await frame();
    };

    await fixture(); let before = await snapshot(); const canceledId = await start();
    check('simulated inference opens Remove background with Cancel and disabled Apply',
      await target.locator('.background-removal-dialog[open] h2').textContent() === 'Remove background' && await cancel().isEnabled() && await apply().isDisabled());
    const input = await target.evaluate(async () => {
      const request = __backgroundMock.requests.at(-1);
      if (!(request.png instanceof Uint8Array)) return { typedPng: false };
      const image = await createImageBitmap(new Blob([request.png], { type: 'image/png' }));
      try {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return { typedPng: true, width: request.width, height: request.height,
          pixels: [...ctx.getImageData(0, 0, canvas.width, canvas.height).data] };
      } finally { image.close(); }
    });
    check('simulated inference receives only active-layer PNG bytes and exact dimensions', input.typedPng && input.width === 12 && input.height === 8 &&
      JSON.stringify(input.pixels) === JSON.stringify(before.layers[1].pixels));
    check('starting simulated inference leaves document pixels and history unchanged', unchanged(before, await snapshot()));
    await cancel().click(); await frame();
    check('Cancel calls the backend owner and keeps its disabled UI lease while cleanup is pending',
      await target.evaluate(id => __backgroundMock.cancels.includes(id), canceledId) &&
      await target.locator('.background-removal-dialog[open]').count() === 1 && await apply().isDisabled());
    await acknowledgeCancellation();
    check('cancellation acknowledgement alone does not release a still-pending run',
      await target.locator('.background-removal-dialog[open]').count() === 1 && unchanged(before, await snapshot()));
    await finish('success');
    check('a late simulated result after Cancel cannot change the document', unchanged(before, await snapshot()) && !await target.locator('.background-removal-dialog[open]').count());

    await fixture(); before = await snapshot(); await start(); await cancel().click(); await frame(); await finish('success');
    check('run settlement alone does not release a cancellation whose cleanup is pending',
      await target.locator('.background-removal-dialog[open]').count() === 1 && await apply().isDisabled() && unchanged(before, await snapshot()));
    await acknowledgeCancellation();
    check('cancellation releases its UI lease after run and cleanup both settle',
      !await target.locator('.background-removal-dialog[open]').count() && unchanged(before, await snapshot()));

    await fixture(); before = await snapshot(); await start(); await finish('success'); await apply().waitFor({ state: 'visible' });
    check('simulated result enables Apply and exposes a preview without editing the document', await apply().isEnabled() &&
      await target.locator('.background-removal-dialog[open] canvas, .background-removal-dialog[open] img').count() > 0 && unchanged(before, await snapshot()));
    await cancel().click(); await frame();
    check('Cancel discards a completed simulated preview without adding history', unchanged(before, await snapshot()));

    await fixture(); before = await snapshot(); await start(); await finish('success'); await apply().click(); await frame();
    const applied = await snapshot(), originalPixels = before.layers[1].pixels, resultPixels = applied.layers[1].pixels;
    check('Apply multiplies active-layer alpha by the simulated foreground mask', resultPixels.every((value, index) => {
      const x = Math.floor(index / 4) % 12, mask = x < 4 ? 0 : x < 8 ? 128 : 255;
      const alphaIndex = Math.floor(index / 4) * 4 + 3, expectedAlpha = Math.round(originalPixels[alphaIndex] * mask / 255);
      return index % 4 === 3 ? Math.abs(value - expectedAlpha) <= 1 : expectedAlpha === 0 || Math.abs(value - originalPixels[index]) <= 2;
    }) && resultPixels.some((value, index) => index % 4 === 3 && value !== originalPixels[index]));
    check('Apply preserves other layers, layer properties and active identity', unchanged(applied.layers[0], before.layers[0]) &&
      applied.active === before.active && applied.layers.every((layer, index) => ['id', 'name', 'visible', 'opacity'].every(key => layer[key] === before.layers[index][key])));
    await target.getByRole('button', { name: 'Undo (Ctrl+Z)', exact: true }).click(); await frame(); const undone = await snapshot();
    await target.getByRole('button', { name: 'Redo (Ctrl+Y)', exact: true }).click(); await frame(); const redone = await snapshot();
    check('background removal Apply is exactly one Undo and Redo operation', applied.undo && !applied.redo && undone.content === before.content &&
      !undone.undo && redone.content === applied.content);

    for (const [race, phase] of [['newer edit', 'inflight'], ['replacement document', 'inflight'], ['newer edit', 'preview']]) {
      await fixture(); await start();
      if (phase === 'preview') await finish('success');
      await target.evaluate(race => {
        const doc = paintApp.doc;
        if (race === 'replacement document') doc.newDocument(9, 7);
        else { doc.begin('Newer edit'); const ctx = doc.activeLayer.canvas.getContext('2d'); ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 3, 3); doc.commit(); }
      }, race); await frame(); const newer = await snapshot();
      if (phase === 'inflight') await finish('success');
      await acknowledgeCancellation();
      if (await apply().count() && await apply().isEnabled()) { await apply().click(); await frame(); }
      check(`simulated result preserves a ${race} during ${phase}`, unchanged(newer, await snapshot()));
      await closeError();
    }

    for (const mode of ['failure', 'malformed']) {
      await fixture(); before = await snapshot(); await start(); await finish(mode);
      const canApply = await apply().count() && await apply().isEnabled();
      check(`simulated ${mode} result cannot be applied and leaves document intact`, !canApply && unchanged(before, await snapshot()));
      check(`simulated ${mode} result gives a visible explanation`, await target.evaluate(mode => {
        const dialog = document.querySelector('.background-removal-dialog[open]'), toast = document.querySelector('#toast');
        const text = `${dialog?.textContent || ''} ${toast && getComputedStyle(toast).display !== 'none' ? toast.textContent : ''}`;
        return mode === 'failure' ? text.includes('Simulated inference failed.') : /mask/i.test(text);
      }, mode));
      await closeError();
    }

    await fixture(); await target.evaluate(() => paintApp.doc.selectRect(0, 0, 4, 4)); await frame(); before = await snapshot();
    const requestCount = await target.evaluate(() => __backgroundMock.requests.length); await button.click(); await frame();
    check('pending selection is refused without settling it or starting inference', unchanged(before, await snapshot()) &&
      await target.evaluate(count => __backgroundMock.requests.length === count, requestCount));
    check('pending selection refusal explains the required user action', await target.evaluate(() =>
      /selection/i.test(`${document.querySelector('#toast').textContent} ${document.querySelector('.background-removal-dialog[open]')?.textContent || ''}`)));
  } finally { await context.close(); }
}
