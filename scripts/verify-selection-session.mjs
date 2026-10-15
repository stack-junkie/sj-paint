/** Selection sessions retain their original raster until accepted or cancelled. */
export async function verifySelectionSession(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument, createCanvas } = await import('/src/engine.js');
    const results = [];
    const record = (name, ok, detail = null) => results.push({ name, ok, detail });
    const project = d => JSON.stringify(d.serialize());
    const selected = d => d.selection && JSON.stringify({ ...d.selection, canvas: d.selection.canvas.toDataURL(), mask: [...d.selection.mask] });
    const pixel = (d, x, y) => [...d.composite().getContext('2d').getImageData(x, y, 1, 1).data];
    const fixture = () => {
      const d = new PaintDocument(16, 12); d.setBackground(null);
      d.begin('Fixture'); const ctx = d.activeLayer.canvas.getContext('2d');
      ctx.fillStyle = '#ff0000'; ctx.fillRect(2, 2, 3, 3);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(10, 8, 2, 2);
      d.commit(); d.markSaved(); return d;
    };

    const d = fixture(), baseline = project(d), baselineRevision = d.revision, baselineUndo = d._undo.length;
    d.begin('Create redo'); d.activeLayer.canvas.getContext('2d').fillRect(7, 0, 1, 1); d.commit(); d.undo();
    const redoBefore = d._redo.length;
    d.selectRect(2, 2, 3, 3);
    record('selection creation retains saved pixels and history while exposing cancellation', d.hasSelectionSession && d.canUndo &&
      project(d) === baseline && d.revision === baselineRevision && !d.dirty && d._undo.length === baselineUndo && d._redo.length === redoBefore);
    d.begin('Drag selection'); d.moveSelection(6, 2); d.commit();
    record('released selection movement remains pending without consuming undo or redo', d.hasSelectionSession && d.dirty &&
      d._undo.length === baselineUndo && d._redo.length === redoBefore && pixel(d, 7, 3)[0] === 255 && pixel(d, 3, 3)[3] === 0);
    const moved = project(d), movedSelection = selected(d), movedRevision = d.revision;
    d.begin('Resize gesture'); d.resizeSelection(6, 6); d.cancel();
    record('short gesture cancellation restores the preceding pending selection', d.hasSelectionSession && project(d) === moved &&
      selected(d) === movedSelection && d.revision === movedRevision && d._undo.length === baselineUndo && d._redo.length === redoBefore);
    d.cancelSelection();
    record('whole selection cancellation restores original pixels and saved state without replacing redo', !d.selection && !d.hasSelectionSession &&
      project(d) === baseline && d.revision === baselineRevision && !d.dirty && d._undo.length === baselineUndo && d._redo.length === redoBefore);

    const accepted = fixture(), acceptedBaseline = project(accepted), acceptedUndo = accepted._undo.length;
    accepted.selectRect(2, 2, 3, 3); accepted.moveSelection(6, 2); accepted.resizeSelection(4, 3); accepted.flip(true);
    const acceptedPixels = project(accepted);
    accepted.commitSelection();
    record('accepting a transformed selection publishes one raster history entry', !accepted.selection && !accepted.hasSelectionSession &&
      project(accepted) === acceptedPixels && accepted._undo.length === acceptedUndo + 1);
    accepted.undo();
    const undoAccepted = project(accepted) === acceptedBaseline && !accepted.selection && !accepted.dirty;
    accepted.redo();
    record('accepted selection undo and redo restore raster states without handles', undoAccepted && project(accepted) === acceptedPixels && !accepted.selection && !accepted.hasSelectionSession);

    const undone = fixture(), original = project(undone), oldUndo = undone._undo.length;
    undone.selectRect(2, 2, 3, 3); undone.moveSelection(7, 5);
    const movedRaster = project(undone);
    undone.undo();
    const directUndo = project(undone) === original && !undone.selection && !undone.hasSelectionSession && undone._undo.length === oldUndo;
    undone.redo();
    record('Undo during a changed selection restores baseline and Redo materializes the moved raster', directUndo && project(undone) === movedRaster && !undone.selection && !undone.hasSelectionSession);
    const stillMoved = project(undone), undoAfterRedo = undone._undo.length;
    undone.selectRect(7, 5, 3, 3); undone.undo();
    record('Undo during an unchanged selection dismisses handles without undoing earlier artwork', project(undone) === stillMoved &&
      !undone.selection && !undone.hasSelectionSession && undone._undo.length === undoAfterRedo);

    const keyed = fixture();
    keyed.begin('White key pixels'); const keyedContext = keyed.activeLayer.canvas.getContext('2d');
    keyedContext.fillStyle = '#ffffff'; keyedContext.fillRect(0, 0, 2, 6); keyed.commit(); keyed.markSaved();
    const keyedBaseline = project(keyed), keyedUndo = keyed._undo.length;
    keyed.selectPolygon([[0, 0], [7, 0], [0, 7]], { transparent: true, color: '#ffffff' });
    const maskContainsHoles = keyed.selection.mask.some(value => value === 0);
    const whiteTransparent = keyed.selection.canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 0;
    keyed.moveSelection(5, 3); keyed.resizeSelection(9, 8); keyed.rotate(90); keyed.flip(false); keyed.invertColors();
    keyed.cancelSelection();
    record('cancelling transformed transparent lasso selection restores exact mask-owned and keyed pixels', maskContainsHoles && whiteTransparent &&
      project(keyed) === keyedBaseline && !keyed.selection && !keyed.dirty && keyed._undo.length === keyedUndo);

    const layered = fixture(), lower = layered.activeLayerId;
    layered.addLayer('Upper'); layered.begin('Upper ink'); layered.activeLayer.canvas.getContext('2d').fillRect(0, 0, 2, 2); layered.commit();
    layered.selectLayer(lower); layered.markSaved(); const layerBaseline = project(layered), layerUndo = layered._undo.length;
    layered.selectRect(2, 2, 3, 3); layered.moveSelection(6, 2);
    const committedMove = project(layered);
    layered.setLayer(lower, { opacity: 0.5 });
    const separatedHistory = layered._undo.length === layerUndo + 2 && !layered.hasSelectionSession && !layered.selection;
    layered.undo(); const propertyUndo = project(layered) === committedMove;
    layered.undo();
    record('layer mutation settles selection before recording its own independent edit', separatedHistory && propertyUndo && project(layered) === layerBaseline);

    const cropped = fixture(), cropBaseline = project(cropped), cropUndo = cropped._undo.length;
    cropped.selectRect(2, 2, 3, 3); cropped.moveSelection(6, 2); const cropPlaced = project(cropped); cropped.crop();
    const croppedProject = project(cropped), cropFinal = cropped.width === 3 && cropped.height === 3 && !cropped.selection && !cropped.hasSelectionSession && cropped._undo.length === cropUndo + 2;
    cropped.undo(); const cropRestores = project(cropped) === cropPlaced && !cropped.selection;
    cropped.undo(); const placementRestores = project(cropped) === cropBaseline && !cropped.selection;
    cropped.redo(); cropped.redo();
    record('crop records accepted selection placement before its separate reversible crop', cropFinal && cropRestores && placementRestores && project(cropped) === croppedProject && !cropped.selection);
    const deleted = fixture(), deleteBaseline = project(deleted), deleteUndo = deleted._undo.length;
    deleted.selectRect(2, 2, 3, 3); deleted.moveSelection(6, 2); deleted.deleteSelection();
    const deletionFinal = pixel(deleted, 3, 3)[3] === 0 && pixel(deleted, 7, 3)[3] === 0 && deleted._undo.length === deleteUndo + 1 && !deleted.hasSelectionSession;
    deleted.undo();
    record('deleting a moved selection removes only its owned pixels in one reversible edit', deletionFinal && project(deleted) === deleteBaseline && !deleted.selection);

    const pasted = fixture(), pasteBaseline = project(pasted), pasteUndo = pasted._undo.length;
    const paste = createCanvas(2, 3); paste.getContext('2d').fillStyle = '#ff00ff'; paste.getContext('2d').fillRect(0, 0, 2, 3);
    pasted.pasteCanvas(paste); pasted.moveSelection(7, 4);
    record('paste and placement share a pending selection session', pasted.hasSelectionSession && pasted.dirty && pasted._undo.length === pasteUndo);
    pasted.cancelSelection();
    record('cancelling paste restores the previous document without adding history', project(pasted) === pasteBaseline && !pasted.selection && !pasted.dirty && pasted._undo.length === pasteUndo);

    const invalid = fixture(); invalid.selectRect(2, 2, 3, 3); invalid.moveSelection(6, 2);
    const invalidBefore = project(invalid), invalidSelection = selected(invalid), invalidSession = invalid._selectionSession, invalidHistory = invalid._undo.length;
    const failures = [];
    for (const operation of [() => invalid.resizeCanvas(0, 12), () => invalid.resize(0, 4), () => invalid.setBackground('not-a-color'),
      () => invalid.selectRect(0, 0, 2, 2, { transparent: true, color: 'not-a-color' }), () => invalid.pasteCanvas({ width: 2, height: 2 })]) {
      let rejected = false; try { operation(); } catch { rejected = true; }
      failures.push(rejected && project(invalid) === invalidBefore && selected(invalid) === invalidSelection && invalid._selectionSession === invalidSession && invalid._undo.length === invalidHistory);
    }
    record('invalid commands do not settle or replace the pending selection session', failures.every(Boolean), failures);
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    let failedDraw = false;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      if (args[0] === invalid.selection?.canvas) throw new Error('Injected selection export failure');
      return originalDrawImage.apply(this, args);
    };
    try { invalid.selectionCanvas(); } catch (error) { failedDraw = error.message === 'Injected selection export failure'; }
    finally { CanvasRenderingContext2D.prototype.drawImage = originalDrawImage; }
    record('failed transformed selection export preserves the session baseline and pending pixels', failedDraw && project(invalid) === invalidBefore &&
      selected(invalid) === invalidSelection && invalid._selectionSession === invalidSession && invalid._transaction === null && invalid._undo.length === invalidHistory);

    const atomic = fixture();
    atomic.begin('Redo candidate'); atomic.activeLayer.canvas.getContext('2d').fillRect(0, 9, 1, 1); atomic.commit(); atomic.undo();
    atomic.selectRect(2, 2, 3, 3); atomic.moveSelection(6, 2);
    const atomicBefore = project(atomic), atomicSelection = selected(atomic), atomicSession = atomic._selectionSession;
    const atomicUndo = atomic._undo.slice(), atomicRedo = atomic._redo.slice(), atomicRevision = atomic.revision;
    const sameHistory = () => atomic._undo.length === atomicUndo.length && atomic._redo.length === atomicRedo.length &&
      atomic._undo.every((entry, i) => entry === atomicUndo[i]) && atomic._redo.every((entry, i) => entry === atomicRedo[i]);
    const failedCommands = [], originalPutImageData = CanvasRenderingContext2D.prototype.putImageData;
    for (const operation of [() => atomic.resizeCanvas(9, 7), () => atomic.selectRect(0, 0, 9, 7)]) {
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.width === 9 && this.canvas.height === 7) throw new Error('Injected replacement failure');
        return originalDrawImage.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.putImageData = function (...args) {
        if (this.canvas.width === 9 && this.canvas.height === 7) throw new Error('Injected replacement failure');
        return originalPutImageData.apply(this, args);
      };
      let rejected = false;
      try { operation(); } catch (error) { rejected = error.message === 'Injected replacement failure'; }
      finally {
        CanvasRenderingContext2D.prototype.drawImage = originalDrawImage;
        CanvasRenderingContext2D.prototype.putImageData = originalPutImageData;
      }
      failedCommands.push(rejected && project(atomic) === atomicBefore && selected(atomic) === atomicSelection &&
        atomic.revision === atomicRevision && atomic._selectionSession === atomicSession && sameHistory() &&
        atomic._transaction === null && atomic._settlement === null);
    }
    record('failed document edits and replacement selections restore the entire pending session and both history stacks', failedCommands.every(Boolean), failedCommands);
    atomic.cancelSelection();
    record('cancellation after a failed settling command still restores original pixels and preserves redo', !atomic.selection && sameHistory() && !atomic.dirty);

    const retained = fixture(); retained.selectRect(2, 2, 3, 3); retained.begin('Retention checkpoint');
    const retention = retained._retainedSnapshotBytes();
    const bytesPerRaster = 16 * 12 * 4;
    record('selection baseline and gesture checkpoint have separately counted bounded owners',
      retention.selection === bytesPerRaster && retention.gesture === bytesPerRaster + 3 * 3 * 5 && retention.settlement === 0 && retention.history > 0, retention);
    retained.cancel(); retained.cancelSelection();
    const released = retained._retainedSnapshotBytes();
    record('cancelling releases all temporary snapshot owners without evicting history', released.selection === 0 && released.gesture === 0 &&
      released.settlement === 0 && released.history === retention.history, released);

    const savedPending = fixture(), savedBaseline = project(savedPending);
    savedPending.selectRect(2, 2, 3, 3); savedPending.moveSelection(6, 2); savedPending.markSaved(); savedPending.cancelSelection();
    record('cancelling after a pending representation was saved correctly reports unsaved restored content', project(savedPending) === savedBaseline && savedPending.dirty);
    const savedGesture = fixture(); savedGesture.selectRect(2, 2, 3, 3); savedGesture.begin('Pending drag'); savedGesture.moveSelection(6, 2);
    const releasedRevision = savedGesture.revision; savedGesture.markSaved(); savedGesture.commit();
    record('releasing a selection gesture does not invent a new content revision', savedGesture.revision === releasedRevision && !savedGesture.dirty);

    const target = fixture();
    const initialTarget = target.captureEditTarget(), initialMatches = target.matchesEditTarget(initialTarget);
    target.begin('Intervening gesture'); target.cancel();
    const gestureInvalidates = !target.matchesEditTarget(initialTarget);
    target.selectRect(2, 2, 3, 3); const selectedTarget = target.captureEditTarget(); target.moveSelection(3, 2);
    const movementInvalidates = !target.matchesEditTarget(selectedTarget);
    const movedTarget = target.captureEditTarget(); target.cancelSelection();
    const cancellationInvalidates = !target.matchesEditTarget(movedTarget);
    const beforeReload = target.captureEditTarget(); await target.load(target.serialize());
    const reloadInvalidates = !target.matchesEditTarget(beforeReload);
    const beforeNew = target.captureEditTarget(); target.newDocument(16, 12);
    record('edit target tokens detect gestures, selection changes, cancellation, reload, and reused document objects',
      initialMatches && gestureInvalidates && movementInvalidates && cancellationInvalidates && reloadInvalidates && !target.matchesEditTarget(beforeNew));
    return results;
  });
  for (const result of results) check(result.name, result.ok, result.detail);
}
