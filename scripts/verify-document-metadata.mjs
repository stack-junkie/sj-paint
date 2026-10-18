// Document ownership checks complement the independent codec fixture checks.
export async function verifyDocumentMetadata(page, check) {
  const results = await page.evaluate(async () => {
    const { PaintDocument } = await import('/src/engine.js');
    const results = [], record = (name, ok, detail) => results.push({ name, ok, detail });
    const resolutionIs = (doc, x, y) => doc.resolution.xDpi === x && doc.resolution.yDpi === y;
    const d = new PaintDocument(8, 6);
    record('new drawing preserves unknown physical resolution', resolutionIs(d, null, null));
    d.setResolution({ xDpi: 96, yDpi: 144 });
    const configuredRevision = d.revision;
    record('resolution is document content and can be undone', d.dirty && d.canUndo);
    d.undo(); record('resolution Undo restores unknown values and saved state', resolutionIs(d, null, null) && !d.dirty);
    d.redo(); record('resolution Redo restores both axes and revision', resolutionIs(d, 96, 144) && d.revision === configuredRevision);
    d.markSaved();
    const supplied = { xDpi: 96, yDpi: 144 };
    d.setResolution(supplied); supplied.xDpi = 600;
    record('equal resolution does not create an edit and caller mutation cannot change it', !d.dirty && d.revision === configuredRevision && resolutionIs(d, 96, 144));
    d.rotate(90);
    record('document quarter turn swaps dimensions and physical axes together', d.width === 6 && d.height === 8 && resolutionIs(d, 144, 96));
    d.undo(); record('quarter turn Undo restores dimensions, resolution and saved state', d.width === 8 && d.height === 6 && resolutionIs(d, 96, 144) && !d.dirty);
    d.selectRect(0, 0, 3, 2); d.rotate(90);
    record('selection rotation retains document resolution', resolutionIs(d, 96, 144));
    d.cancelSelection();
    const project = d.serialize(), reopened = new PaintDocument(1, 1);
    await reopened.load(JSON.parse(JSON.stringify(project)));
    record('editable project round trip retains exact resolution without dirtying opened drawing', resolutionIs(reopened, 96, 144) && !reopened.dirty);
    delete project.resolution;
    await reopened.load(project);
    record('legacy project without resolution opens with explicit unknown axes', resolutionIs(reopened, null, null));
    reopened.setResolution({ xDpi: null, yDpi: 72 });
    const before = JSON.stringify(reopened.serialize()), revision = reopened.revision;
    for (const invalid of [0, [], { xDpi: 0 }, { yDpi: -1 }, { xDpi: Infinity }, { yDpi: '72' }]) {
      let rejected = false;
      try { await reopened.load({ ...project, resolution: invalid }); } catch { rejected = true; }
      record(`invalid project resolution ${JSON.stringify(invalid)} preserves existing drawing`, rejected && revision === reopened.revision && before === JSON.stringify(reopened.serialize()));
    }
    reopened.begin('Resolution draft'); reopened.setResolution({ xDpi: 300, yDpi: 300 }); reopened.cancel();
    record('cancelled transaction restores partial unknown resolution', resolutionIs(reopened, null, 72));
    const pixels = new Uint8Array(8 * 6 * 4);
    reopened.loadRaster({ width: 8, height: 6, background: null, resolution: { xDpi: 72, yDpi: null },
      activeLayerId: 'native', layers: [{ id: 'native', name: 'Native', visible: true, opacity: 1, rgba: pixels }] });
    record('decoded raster document owns resolution with explicit unknown axis', resolutionIs(reopened, 72, null) && !reopened.dirty);
    return results;
  });
  for (const { name, ok, detail } of results) check(name, ok, detail);
}
