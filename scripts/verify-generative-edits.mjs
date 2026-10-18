// Model-free editor boundary checks. The IPC fixture supplies deterministic PNGs;
// it does not establish inference quality, runtime setup or model performance.
import { verifyGenerativeModes } from './verify-generative-modes.mjs';
export async function verifyGenerativeEdits(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument } = await import('/src/engine.js');
    const records = [], record = (name, ok, detail) => records.push({ name, ok, detail });
    const raster = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const equal = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    const canvas = (width, height, color) => {
      const result = Object.assign(document.createElement('canvas'), { width, height });
      result.getContext('2d').fillStyle = color; result.getContext('2d').fillRect(0, 0, width, height); return result;
    };
    const fixture = () => {
      const doc = new PaintDocument(32, 24);
      doc.setBackground(null);
      doc.begin('Original pixels');
      doc.activeLayer.canvas.getContext('2d').drawImage(canvas(32, 24, 'rgba(40,80,160,.5)'), 0, 0);
      doc.activeLayer.canvas.getContext('2d').clearRect(0, 0, 3, 3);
      doc.commit(); doc.markSaved();
      return doc;
    };
    for (const shape of ['rectangle', 'rotated', 'polygon']) {
      const doc = fixture(), beforeSelection = doc.serialize(), beforeUndo = doc._undo.length;
      if (shape === 'polygon') doc.selectPolygon([[5, 4], [19, 4], [10, 17]]);
      else doc.selectRect(5, 4, 12, 8);
      if (shape === 'rotated') { doc.rotate(33); doc.translateSelection(3, 2); }
      const target = doc.captureEditTarget(), original = raster(doc.activeLayerImage()), mask = doc.selectionMask();
      const generated = doc.generatedLayer(target, canvas(64, 64, '#00ff00'), { selectionOnly: true });
      const pixels = raster(generated);
      let outside = 0, inside = 0, maskCount = 0;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i]) { maskCount++; if (!equal(pixels.slice(i * 4, i * 4 + 4), [0, 255, 0, 255])) inside++; }
        else if (!equal(pixels.slice(i * 4, i * 4 + 4), original.slice(i * 4, i * 4 + 4))) outside++;
      }
      record(`${shape} AI mask preserves every unowned RGBA pixel and replaces owned pixels`, outside === 0 && inside === 0 && maskCount > 0 && maskCount < mask.length, { outside, inside, maskCount });
      record(`${shape} preview does not mutate document or its edit target`, doc.matchesEditTarget(target) && doc._undo.length === beforeUndo);
      doc.applyGeneratedLayer(target, generated, 'Generative erase');
      const applied = JSON.stringify(doc.serialize());
      record(`${shape} Apply completes one selection-session history entry`, doc._undo.length === beforeUndo + 1 && !doc.selection && doc.dirty);
      doc.undo();
      record(`${shape} Undo restores exact pre-selection saved pixels`, JSON.stringify(doc.serialize()) === JSON.stringify(beforeSelection) && !doc.dirty);
      doc.redo(); record(`${shape} Redo restores exact accepted pixels`, JSON.stringify(doc.serialize()) === applied);
    }
    const stale = fixture(), target = stale.captureEditTarget();
    stale.setLayer(stale.activeLayerId, { opacity: .5 });
    const beforeStale = JSON.stringify(stale.serialize()), history = stale._undo.length;
    let rejected = 0;
    for (const action of [() => stale.generatedLayer(target, canvas(32, 24, 'red')),
      () => stale.applyGeneratedLayer(target, canvas(32, 24, 'red')), () => stale.insertGeneratedImage(target, canvas(8, 8, 'red'), 'Image')]) {
      try { action(); } catch { rejected++; }
    }
    record('All generated edit boundaries reject stale targets without history or pixel changes', rejected === 3 && history === stale._undo.length && beforeStale === JSON.stringify(stale.serialize()));
    return records;
  });
  for (const result of results) check(result.name, result.ok, result.detail);

  await page.evaluate(async () => {
    const { PaintDocument } = await import('/src/engine.js');
    const { generateImage } = await import('/src/generative-ai.js');
    const doc = new PaintDocument(32, 24);
    doc.begin('Base'); doc.activeLayer.canvas.getContext('2d').fillStyle = '#123456'; doc.activeLayer.canvas.getContext('2d').fillRect(0, 0, 32, 24); doc.commit();
    doc.addLayer('Edit'); doc.begin('Edited layer'); doc.activeLayer.canvas.getContext('2d').fillStyle = '#aa3344'; doc.activeLayer.canvas.getContext('2d').fillRect(0, 0, 32, 24); doc.commit();
    doc.setLayer(doc.activeLayerId, { opacity: .5 });
    const activeId = doc.activeLayerId;
    doc.addLayer('Upper'); doc.begin('Upper pixels'); doc.activeLayer.canvas.getContext('2d').fillStyle = '#ffff00'; doc.activeLayer.canvas.getContext('2d').fillRect(12, 0, 4, 24); doc.commit();
    doc.activeLayerId = activeId; doc.setResolution({ xDpi: 96, yDpi: 144 });
    const beforeSelection = JSON.stringify(doc.serialize());
    doc.selectRect(5, 4, 14, 12);
    const state = { doc, savedBridge: window.paintDesktop, clipboardDescriptor: Object.getOwnPropertyDescriptor(navigator, 'clipboard'),
      beforeSelection, session: null, retainedCandidates: [], calls: [], releases: 0, pending: null, errors: [] };
    window.__generationVerification = state;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      write: async items => { state.copiedPng = new Uint8Array(await (await items[0].getType('image/png')).arrayBuffer()); },
    } });
    window.paintDesktop = {
      saveImage: async request => { state.editExport = request; return { name: request.suggestedName }; },
      localAiSetup() {}, localAiStatus: async () => ({ ok: true, value: { features: { migan: { configured: true } }, generation: {
        requirements: { erase: ['migan'] },
        defaults: Object.fromEntries(['erase'].map(mode => [mode, { steps: 30, guidance: 7.5, strength: 1 }])),
        bounds: { maxPromptBytes: 1536, minSteps: 1, maxSteps: 50 },
      }, generationSession: state.session ? { sessionId: state.session } : null } }),
      localAiGenerate: async request => {
        state.calls.push({ id: request.id, sessionId: request.sessionId });
        if (request.sessionId && request.sessionId !== state.session) return { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Expired fixture session.' } };
        if (!state.session) { state.session = crypto.randomUUID(); state.retainedCandidates = []; }
        const canvas = Object.assign(document.createElement('canvas'), { width: request.width, height: request.height });
        state.generated = (state.generated || 0) + 1;
        canvas.getContext('2d').fillStyle = ['#00ff00', '#ff00ff', '#00ffff', '#0000ff', '#ff8800', '#8844cc'][(state.generated - 1) % 6];
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve));
        const candidateId = crypto.randomUUID(); state.retainedCandidates.push(candidateId);
        const evictedCandidateId = state.retainedCandidates.length > 4 ? state.retainedCandidates.shift() : undefined;
        return { ok: true, value: { width: canvas.width, height: canvas.height, targetToken: request.targetToken,
          png: new Uint8Array(await blob.arrayBuffer()), sessionId: state.session, candidateId, evictedCandidateId, seed: request.seed } };
      },
      localAiCancel: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'No active fixture operation.' } }),
      localAiReleaseGeneration: async ({ sessionId }) => {
        if (state.holdRelease) { state.releaseStarted = true; await new Promise(resolve => { state.finishRelease = resolve; }); state.holdRelease = false; }
        const owned = state.session === sessionId; state.session = null;
        return owned ? { ok: true, value: {} } : { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Expired fixture session.' } };
      },
      localAiRelease: async () => { state.releases++; state.session = null; return { ok: true, value: {} }; },
      onLocalAiProgress: listener => { state.progress = listener; return () => { state.progress = null; }; },
    };
    state.done = generateImage(doc, 'erase').catch(error => state.errors.push(error.message));
  });
  try {
    const dialog = page.locator('.generation-dialog');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await dialog.locator('.generation-preview canvas').waitFor();
    const observedCandidates = [];
    for (let index = 0; index < 5; index++) {
      if (index) {
        await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.generation-dialog [type="submit"]').disabled);
      }
      observedCandidates.push(await dialog.evaluate(panel => ({
        id: panel.querySelector('.generation-candidates [aria-pressed="true"]').dataset.candidate,
        preview: panel.querySelector('.generation-preview canvas').toDataURL(),
      })));
    }
    const retainedIds = await dialog.locator('.generation-candidates button').evaluateAll(buttons => buttons.map(button => button.dataset.candidate));
    check('The fifth candidate removes the oldest and retains exactly the four remaining choices',
      JSON.stringify(retainedIds) === JSON.stringify(observedCandidates.slice(1).map(candidate => candidate.id)), retainedIds);
    for (let index = 0; index < 4; index++) {
      await dialog.getByRole('button', { name: `Candidate ${index + 1}`, exact: true }).click();
      check(`Remaining candidate ${index + 1} restores its own exact preview after eviction`,
        await dialog.locator('.generation-preview canvas').evaluate(canvas => canvas.toDataURL()) === observedCandidates[index + 1].preview);
    }
    const callsBeforeExpiry = await page.evaluate(() => window.__generationVerification.calls.length);
    await page.evaluate(() => { window.__generationVerification.session = null; });
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.generation-dialog [type="submit"]').disabled);
    check('Generate recovers from backend session expiry within the same bounded preview',
      await dialog.locator('.generation-candidates button').count() === 4 &&
      await page.evaluate(count => window.__generationVerification.calls.length === count + 2, callsBeforeExpiry) &&
      await dialog.locator('.generation-candidates [aria-pressed="true"]').getAttribute('data-candidate') !== observedCandidates[4].id,
      await page.evaluate(() => ({ calls: window.__generationVerification.calls, status: document.querySelector('.generation-dialog [role="status"]').textContent })));
    await dialog.getByRole('button', { name: 'Candidate 1', exact: true }).click();
    const preview = await dialog.locator('.generation-preview canvas').evaluate(canvas => canvas.toDataURL());
    check('Candidate selection after session recovery retains the oldest surviving exact preview', preview === observedCandidates[2].preview);
    await page.evaluate(() => {
      const state = window.__generationVerification;
      state.beforeEditExport = JSON.stringify(state.doc.serialize()); state.historyBeforeEditExport = state.doc._undo.length;
    });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Saved image.' }).waitFor();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Copied image.' }).waitFor();
    const editExports = await page.evaluate(async () => {
      const state = window.__generationVerification;
      const { readImageResolution } = await import('/src/image-metadata.js');
      const decode = async bytes => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
        const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
        canvas.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); return canvas.toDataURL();
      };
      return { saved: await decode(state.editExport.bytes), copied: await decode(state.copiedPng),
        resolution: readImageResolution(state.editExport.bytes),
        unchanged: state.beforeEditExport === JSON.stringify(state.doc.serialize()) && state.historyBeforeEditExport === state.doc._undo.length };
    });
    check('Public editing Save exports the visible candidate with target opacity and upper/lower layers', editExports.saved === preview);
    check('Public editing Copy exports the same visible candidate through an isolated clipboard adapter', editExports.copied === preview);
    check('Editing candidate PNG preserves both source density axes at PNG precision',
      editExports.resolution.xDpi === 3780 * .0254 && editExports.resolution.yDpi === 5669 * .0254, editExports.resolution);
    check('Candidate Save and Copy do not change document pixels or history', editExports.unchanged);
    await page.evaluate(() => {
      const state = window.__generationVerification;
      state.holdRelease = true; state.callsBeforeApply = state.calls.length;
      state.historyBeforeApply = state.doc._undo.length; state.contentBeforeApply = JSON.stringify(state.doc.serialize());
    });
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(() => window.__generationVerification.releaseStarted);
    // Real pointer attempts against disabled controls must neither admit work
    // nor switch the candidate being accepted while its worker is releasing.
    for (const name of ['Generate', 'Candidate 2', 'Close']) {
      const bounds = await dialog.getByRole('button', { name, exact: true }).boundingBox();
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    }
    await page.keyboard.press('Escape');
    const whileReleasing = await page.evaluate(() => {
      const state = window.__generationVerification, panel = document.querySelector('.generation-dialog');
      return { open: !!panel?.open, extraCalls: state.calls.length - state.callsBeforeApply,
        unchanged: state.contentBeforeApply === JSON.stringify(state.doc.serialize()) && state.historyBeforeApply === state.doc._undo.length,
        candidate: panel?.querySelector('.generation-candidates [aria-pressed="true"]')?.textContent,
        generateDisabled: panel?.querySelector('[type="submit"]').disabled,
        inputsDisabled: [...panel.querySelectorAll('textarea, input, select')].every(input => input.disabled) };
    });
    check('Apply holds its candidate and UI ownership until release, blocking Generate, candidate switching and Close',
      whileReleasing.open && whileReleasing.extraCalls === 0 && whileReleasing.unchanged && whileReleasing.candidate === 'Candidate 1' && whileReleasing.generateDisabled && whileReleasing.inputsDisabled, whileReleasing);
    await page.evaluate(() => window.__generationVerification.finishRelease());
    await dialog.waitFor({ state: 'detached' });
    const applied = await page.evaluate(() => {
      const state = window.__generationVerification;
      return { composite: state.doc.composite().toDataURL(), releases: state.releases, errors: state.errors, historyAdded: state.doc._undo.length - state.historyBeforeApply };
    });
    check('Rendered AI preview exactly matches accepted layer composition including upper layers and opacity', applied.composite === preview, { releases: applied.releases, errors: applied.errors });
    check('Applying a generated candidate releases retained backend ownership', applied.releases > 0 && applied.errors.length === 0, applied.errors);
    check('Apply accepts the original chosen candidate in exactly one history entry after cleanup', applied.composite === preview && applied.historyAdded === 1, { historyAdded: applied.historyAdded });
    const historyRoundtrip = await page.evaluate(() => {
      const state = window.__generationVerification, accepted = JSON.stringify(state.doc.serialize());
      state.doc.undo(); const undone = JSON.stringify(state.doc.serialize()) === state.beforeSelection;
      state.doc.redo(); return { undone, redone: JSON.stringify(state.doc.serialize()) === accepted };
    });
    check('One Undo restores exact pre-selection artwork after accepting a retained candidate; Redo restores the edit',
      historyRoundtrip.undone && historyRoundtrip.redone, historyRoundtrip);

    for (const staleOutcome of ['success', 'aborted']) {
      await page.evaluate(async outcome => {
        const state = window.__generationVerification;
        const { generateImage } = await import('/src/generative-ai.js');
        const original = state.initialGenerate || window.paintDesktop.localAiGenerate;
        state.initialGenerate = original;
        state.staleOutcome = outcome; state.waitingRequest = null; state.cancelRequested = null;
        window.paintDesktop.localAiGenerate = async request => {
          state.waitingRequest = request;
          const canceled = await new Promise(resolve => { state.resume = resolve; });
          return canceled || original(request);
        };
        window.paintDesktop.localAiCancel = async ({ id }) => {
          if (id !== state.waitingRequest?.id) return { ok: false, error: { code: 'NOT_FOUND', message: 'No matching operation.' } };
          state.cancelRequested = id;
          if (outcome === 'success') return { ok: false, error: { code: 'NOT_FOUND', message: 'Operation already completed.' } };
          state.resume({ ok: false, error: { code: 'ABORTED', message: 'Operation canceled after source edit.' } });
          return { ok: true, value: {} };
        };
        state.doc.selectRect(5, 4, 14, 12);
        state.done = generateImage(state.doc, 'erase').catch(error => state.errors.push(error.message));
        await generateImage(state.doc, 'erase');
      }, staleOutcome);
      await dialog.waitFor();
      check('The shared AI UI gate prevents a second dialog during asynchronous readiness', await dialog.count() === 1);
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      await page.waitForFunction(() => !!window.__generationVerification.waitingRequest);
      check('Active generation exposes a named progress bar', await dialog.getByRole('progressbar', { name: 'Image generation progress', exact: true }).count() === 1);
      await page.evaluate(() => {
        const state = window.__generationVerification;
        state.progress({ id: state.waitingRequest.id, progress: { stage: 'denoise', completed: 1, total: 19 } });
        state.progress({ id: 'previous-operation', progress: { stage: 'denoise', completed: 18, total: 19 } });
      });
      check('Generation shows current image progress and ignores progress from another operation',
        await dialog.getByRole('status').textContent() === 'Generating image (1/19)…' &&
        await dialog.locator('progress').evaluate(el => el.value === 1 && el.max === 19));
      await page.evaluate(() => {
        const state = window.__generationVerification;
        state.doc.setLayer(state.doc.activeLayerId, { opacity: state.staleOutcome === 'success' ? .25 : .75 });
        state.afterExternalEdit = JSON.stringify(state.doc.serialize());
        state.afterExternalHistory = state.doc._undo.length;
        state.progress({ id: state.waitingRequest.id, progress: { stage: 'encode', completed: 1, total: 1 } });
        if (state.staleOutcome === 'success') state.resume();
      });
      await page.waitForFunction(() => document.querySelector('.generation-dialog progress').hidden);
      const stale = await page.evaluate(() => {
        const state = window.__generationVerification;
        return { unchanged: JSON.stringify(state.doc.serialize()) === state.afterExternalEdit && state.doc._undo.length === state.afterExternalHistory,
          canceled: state.cancelRequested === state.waitingRequest.id,
          candidates: document.querySelectorAll('.generation-candidates button').length,
          disabled: document.querySelector('.generation-dialog [data-ai="apply"]').disabled,
          status: document.querySelector('.generation-dialog [role="status"]').textContent };
      });
      check(`A changed drawing requests cancellation and its late ${staleOutcome} response cannot alter pixels or history`, stale.canceled && stale.unchanged && stale.candidates === 0 && stale.disabled, stale);
      check(`Late ${staleOutcome} response and progress preserve the changed-drawing recovery message`, stale.status.includes('The drawing changed.'), stale.status);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
    }
    await page.evaluate(async () => {
      const state = window.__generationVerification;
      await state.done;
      const { PaintDocument } = await import('/src/engine.js');
      const { generateImage } = await import('/src/generative-ai.js');
      state.doc = new PaintDocument(64, 64); state.doc.markSaved();
      state.beforeInsertion = JSON.stringify(state.doc.serialize());
      state.doc.selectRect(0, 0, 64, 64);
      window.paintDesktop.localAiGenerate = state.initialGenerate;
      state.saveMode = 'cancel';
      window.paintDesktop.saveImage = async request => {
        state.saveRequest = request;
        if (state.saveMode === 'cancel') return null;
        if (state.saveMode === 'fail') throw new Error('Output folder unavailable.');
        return { name: request.suggestedName };
      };
      state.done = generateImage(state.doc, 'erase').catch(error => state.errors.push(error.message));
    });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    await dialog.locator('.generation-preview canvas').waitFor();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.generation-dialog [role="status"]').textContent === 'Save canceled.');
    await page.evaluate(() => { window.__generationVerification.saveMode = 'fail'; });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.generation-dialog [role="status"]').textContent === 'Output folder unavailable.');
    check('Canceled and failed candidate saves preserve the preview and unchanged drawing',
      await dialog.locator('.generation-preview canvas').count() === 1 &&
      await dialog.getByRole('button', { name: 'Apply', exact: true }).isEnabled() &&
      await page.evaluate(() => {
        const state = window.__generationVerification;
        return !state.doc.dirty && JSON.stringify(state.doc.serialize()) === state.beforeInsertion;
      }));
    await page.evaluate(() => { window.__generationVerification.saveMode = 'success'; });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.generation-dialog [role="status"]').textContent === 'Saved image.');
    const exported = await page.evaluate(async () => {
      const state = window.__generationVerification, request = state.saveRequest;
      const { readImageResolution } = await import('/src/image-metadata.js');
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(request.bytes)], { type: 'image/png' }));
      const saved = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      saved.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      return { matches: saved.toDataURL() === document.querySelector('.generation-preview canvas').toDataURL(),
        width: saved.width, height: saved.height, format: request.format, dirty: state.doc.dirty, resolution: readImageResolution(request.bytes) };
    });
    check('Candidate Save sends the full preview pixels as PNG without marking the drawing saved or edited',
      exported.matches && exported.width === 64 && exported.height === 64 && exported.format === 'png' && !exported.dirty, exported);
    check('Erased candidate PNG does not invent physical resolution', exported.resolution.xDpi === null && exported.resolution.yDpi === null, exported.resolution);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const insertion = await page.evaluate(() => {
      const state = window.__generationVerification, accepted = JSON.stringify(state.doc.serialize());
      const inserted = state.doc.layers.length === 1 && !state.doc.selection && state.doc.dirty;
      state.doc.undo(); const undone = JSON.stringify(state.doc.serialize()) === state.beforeInsertion && !state.doc.dirty;
      state.doc.redo(); return { inserted, undone, redone: JSON.stringify(state.doc.serialize()) === accepted && state.doc.dirty };
    });
    check('Public erase Apply records one undoable edit and Redo restores the accepted image',
      insertion.inserted && insertion.undone && insertion.redone, insertion);
  } finally {
    await page.evaluate(() => window.__generationVerification?.finishRelease?.());
    if (await page.locator('.generation-dialog').count()) {
      await page.locator('.generation-dialog [data-ai="close"]').click();
      await page.locator('.generation-dialog').waitFor({ state: 'detached' });
    }
    await page.evaluate(async () => {
      const state = window.__generationVerification; await state.done; window.paintDesktop = state.savedBridge;
      if (state.clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', state.clipboardDescriptor);
      else delete navigator.clipboard;
      delete window.__generationVerification;
    });
  }
  await verifyGenerativeModes(page, check);
}
