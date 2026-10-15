/** Clipboard commands use private deferred stubs and never access the OS clipboard. */
export async function verifyClipboardOwnership(page, check) {
  const key = '__sjPaintClipboardOwnership';
  const results = [];
  const record = (name, ok, detail = null) => results.push({ name, ok, detail });
  await page.waitForFunction(() => window.paintApp);
  await page.evaluate(key => {
    if (window[key]) throw new Error('Clipboard ownership verifier is already installed.');
    const { doc, state } = window.paintApp;
    if (doc._transaction || document.querySelector('.text-editor')) throw new Error('Run clipboard ownership checks with no pending edit.');
    const control = {
      doc, savedDoc: Object.getOwnPropertyDescriptors(doc), savedState: { ...state },
      focus: document.activeElement, scroll: [document.querySelector('#viewport').scrollLeft, document.querySelector('#viewport').scrollTop],
      toast: { text: document.querySelector('#toast').textContent, hidden: document.querySelector('#toast').hidden },
      clipboardDescriptor: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
      bitmapDescriptor: Object.getOwnPropertyDescriptor(window, 'createImageBitmap'),
      blobDescriptor: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob'),
      jobs: [], encodings: [], holdEncoding: false, decodes: 0,
    };
    control.bitmap = window.createImageBitmap.bind(window);
    control.snapshot = () => JSON.stringify({ project: doc.serialize(), revision: doc.revision, dirty: doc.dirty,
      generation: doc._documentStartRevision, undo: doc._undo.length, redo: doc._redo.length,
      selection: doc.selection && { x: doc.selection.x, y: doc.selection.y, width: doc.selection.width, height: doc.selection.height,
        layerId: doc.selection.layerId, png: doc.selection.canvas.toDataURL(), mask: [...doc.selection.mask] } });
    control.fixture = (width = 20, selected = true) => {
      doc.newDocument(width, 20); doc.setBackground(null);
      doc.begin('Clipboard fixture');
      const context = doc.activeLayer.canvas.getContext('2d');
      context.fillStyle = '#ff0000'; context.fillRect(2, 2, 4, 4);
      context.fillStyle = '#0000ff'; context.fillRect(12, 12, 4, 4);
      doc.commit(); doc.markSaved();
      if (selected) doc.selectRect(2, 2, 4, 4);
      state.tool = 'select'; doc._changed();
    };
    control.job = kind => [...control.jobs].reverse().find(job => job.kind === kind && !job.settled);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write(items) {
        return new Promise((resolve, reject) => {
          const job = { kind: 'write', items, settled: false, copied: [],
            async release() {
              try {
                const copied = await Promise.all(items.map(item => item.getType('image/png')));
                if (!job.settled) { job.copied = copied; job.settled = true; resolve(); }
              } catch (error) { job.abort(error); }
            },
            abort(error = new DOMException('Private clipboard test ended.', 'AbortError')) {
              if (!job.settled) { job.settled = true; reject(error); }
            },
          };
          control.jobs.push(job);
        });
      },
      read() {
        return new Promise((resolve, reject) => {
          const job = { kind: 'read', settled: false,
            release() {
              if (!job.settled) {
                job.settled = true;
                resolve([{ types: ['image/png'], getType: async () => control.pasteBlob }]);
              }
            },
            abort(error = new DOMException('Private clipboard test ended.', 'AbortError')) {
              if (!job.settled) { job.settled = true; reject(error); }
            },
          };
          control.jobs.push(job);
        });
      },
    } });
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      const hold = control.holdEncoding;
      return control.blobDescriptor.value.call(this, blob => {
        if (hold) control.encodings.push(() => callback(blob));
        else callback(blob);
      }, ...args);
    };
    window.createImageBitmap = async (...args) => {
      control.decodes++;
      try { return await control.bitmap(...args); }
      finally { control.decodes--; }
    };
    window[key] = control;
  }, key);

  const command = async (kind, { menu = false } = {}) => {
    if (menu) {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.locator(`[data-command="${kind}"]`).click();
    } else {
      await page.locator('#overlay').focus();
      await page.keyboard.press(kind === 'cut' ? 'Control+x' : 'Control+v');
    }
    await page.waitForFunction(({ key, kind }) => Boolean(window[key].job(kind === 'cut' ? 'write' : 'read')), { key, kind });
  };
  const finish = async kind => {
    await page.evaluate(async ({ key, kind }) => {
      const control = window[key];
      for (const release of control.encodings.splice(0)) release();
      await control.job(kind === 'cut' ? 'write' : 'read').release();
      // Let command continuations enter any bitmap decode before checking its count.
      await new Promise(resolve => setTimeout(resolve, 0));
    }, { key, kind });
    await page.waitForFunction(key => window[key].decodes === 0, key);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  try {
    await page.evaluate(async key => {
      const c = document.createElement('canvas'); c.width = 3; c.height = 2;
      c.getContext('2d').fillStyle = '#ff00ff'; c.getContext('2d').fillRect(0, 0, 3, 2);
      window[key].pasteBlob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
    }, key);
    for (const scenario of ['document', 'selection', 'layer', 'moved-selection', 'encoding']) {
      await page.evaluate(({ key, scenario }) => {
        const control = window[key]; control.fixture(); control.holdEncoding = scenario === 'encoding';
      }, { key, scenario });
      await command('cut', { menu: scenario === 'layer' });
      if (scenario === 'encoding') await page.waitForFunction(key => window[key].encodings.length === 1, key);
      const expected = await page.evaluate(({ key, scenario }) => {
        const control = window[key], d = control.doc;
        if (scenario === 'document' || scenario === 'encoding') control.fixture(24);
        else if (scenario === 'selection') d.selectRect(12, 12, 4, 4);
        else if (scenario === 'moved-selection') d.moveSelection(6, 2);
        else {
          d.addLayer('New clipboard destination');
          d.begin('New layer artwork');
          const c = d.activeLayer.canvas.getContext('2d'); c.fillStyle = '#00ff00'; c.fillRect(0, 0, 5, 5); d.commit();
        }
        return control.snapshot();
      }, { key, scenario });
      await finish('cut');
      const observed = await page.evaluate(key => {
        const c = window[key]; c.holdEncoding = false;
        return c.snapshot();
      }, key);
      const names = {
        document: 'pending Cut preserves a replacement document',
        selection: 'pending Cut preserves a replacement selection',
        layer: 'pending Cut preserves a newly active layer',
        'moved-selection': 'pending Cut preserves a selection moved during clipboard work',
        encoding: 'pending Cut preserves a replacement document while PNG encoding completes',
      };
      record(names[scenario], observed === expected,
        observed === expected ? null : { expected: JSON.parse(expected), observed: JSON.parse(observed) });
    }

    await page.evaluate(key => window[key].fixture(), key);
    await command('paste', { menu: true });
    const pasteExpected = await page.evaluate(key => { const c = window[key]; c.fixture(24, false); return c.snapshot(); }, key);
    await finish('paste');
    const pasteObserved = await page.evaluate(key => window[key].snapshot(), key);
    record('pending Paste does not apply to a replacement document', pasteObserved === pasteExpected,
      pasteObserved === pasteExpected ? null : { expected: JSON.parse(pasteExpected), observed: JSON.parse(pasteObserved) });

    const cutBefore = await page.evaluate(key => { const c = window[key]; c.fixture(); return c.doc._undo.length; }, key);
    await command('cut');
    await finish('cut');
    const normalCut = await page.evaluate(async key => {
      const control = window[key], d = control.doc;
      const job = [...control.jobs].reverse().find(job => job.kind === 'write');
      const image = await control.bitmap(job.copied[0]);
      const clipboard = document.createElement('canvas'); clipboard.width = image.width; clipboard.height = image.height;
      clipboard.getContext('2d').drawImage(image, 0, 0); image.close();
      const output = d.composite().getContext('2d');
      return { selection: Boolean(d.selection), redAlpha: output.getImageData(3, 3, 1, 1).data[3],
        blue: [...output.getImageData(13, 13, 1, 1).data], copiedSize: [clipboard.width, clipboard.height],
        copiedPixel: [...clipboard.getContext('2d').getImageData(0, 0, 1, 1).data], undo: d._undo.length, dirty: d.dirty };
    }, key);
    record('normal Cut copies the selected raster and removes only that selection in one undo step',
      !normalCut.selection && normalCut.redAlpha === 0 && normalCut.blue.join(',') === '0,0,255,255' &&
      normalCut.copiedSize.join(',') === '4,4' && normalCut.copiedPixel.join(',') === '255,0,0,255' && normalCut.undo === cutBefore + 1 && normalCut.dirty, normalCut);

    await page.evaluate(key => { const c = window[key]; c.fixture(); c.doc.resizeSelection(8, 4); c.doc.rotate(90); }, key);
    await command('cut', { menu: true }); await finish('cut');
    const transformedCut = await page.evaluate(async key => {
      const c = window[key], job = [...c.jobs].reverse().find(job => job.kind === 'write');
      const image = await c.bitmap(job.copied[0]);
      try { return { width: image.width, height: image.height, selection: Boolean(c.doc.selection) }; }
      finally { image.close(); }
    }, key);
    record('Cut copies the rotated resized result rather than the retained source raster',
      transformedCut.width === 4 && transformedCut.height === 8 && !transformedCut.selection, transformedCut);

    const pasteBefore = await page.evaluate(key => { const c = window[key]; c.fixture(20, false); return c.doc._undo.length; }, key);
    await command('paste');
    await finish('paste');
    const normalPaste = await page.evaluate(key => {
      const d = window[key].doc, selection = d.selection;
      return { width: selection?.width, height: selection?.height, layerId: selection?.layerId, active: d.activeLayerId,
        pixel: selection && [...selection.canvas.getContext('2d').getImageData(0, 0, 1, 1).data],
        original: [...d.composite().getContext('2d').getImageData(13, 13, 1, 1).data], undo: d._undo.length, dirty: d.dirty,
        pending: d.hasSelectionSession, canUndo: d.canUndo };
    }, key);
    record('normal Paste creates the copied floating raster without losing existing artwork', normalPaste.width === 3 && normalPaste.height === 2 &&
      normalPaste.layerId === normalPaste.active && normalPaste.pixel?.join(',') === '255,0,255,255' && normalPaste.original.join(',') === '0,0,255,255' &&
      normalPaste.undo === pasteBefore && normalPaste.pending && normalPaste.canUndo && normalPaste.dirty, normalPaste);
  } finally {
    await page.evaluate(async key => {
      const control = window[key];
      if (!control) return;
      for (const job of control.jobs) if (!job.settled) job.abort();
      for (const release of control.encodings.splice(0)) release();
      await new Promise(resolve => setTimeout(resolve, 0));
    }, key);
    await page.waitForFunction(key => !window[key] || window[key].decodes === 0, key);
    await page.evaluate(async key => {
      const control = window[key];
      if (!control) return;
      if (control.clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', control.clipboardDescriptor);
      else delete navigator.clipboard;
      if (control.bitmapDescriptor) Object.defineProperty(window, 'createImageBitmap', control.bitmapDescriptor);
      else delete window.createImageBitmap;
      Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', control.blobDescriptor);
      for (const property of Reflect.ownKeys(control.doc)) if (!Object.hasOwn(control.savedDoc, property)) delete control.doc[property];
      Object.defineProperties(control.doc, control.savedDoc);
      for (const property of Object.keys(window.paintApp.state)) if (!Object.hasOwn(control.savedState, property)) delete window.paintApp.state[property];
      Object.assign(window.paintApp.state, control.savedState);
      control.doc._changed();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const viewport = document.querySelector('#viewport');
      [viewport.scrollLeft, viewport.scrollTop] = control.scroll;
      document.querySelector('#toast').textContent = control.toast.text;
      document.querySelector('#toast').hidden = control.toast.hidden;
      if (control.focus?.isConnected) control.focus.focus({ preventScroll: true });
      delete window[key];
    }, key);
  }
  for (const result of results) check(result.name, result.ok, result.detail);
}
