import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readPaint } from '../src/paint-format.js';

/** Square eraser behavior, including an optional owned native pixel golden. */
export async function verifyEraser(page, check) {
  let native;
  const comparisons = [];
  const fixture = async (name, digest) => {
    const bytes = await readFile(new URL(`../output/${name}`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error(`Owned eraser fixture changed: ${name}`);
    return readPaint(bytes);
  };
  try {
    const before = await fixture('reference-eraser-input.paint', 'd422e354de1129632a0468f581931599a558f8801f30d48f0aeb52ac85168ff8');
    const after = await fixture('reference-eraser-result.paint', 'aa76f674324377c85c5f3f944a4302d9ff4c0aae86fc195af5d5f057171e7060');
    native = { width: before.width, height: before.height,
      source: Buffer.from(before.layers[1].rgba).toString('base64'),
      expected: createHash('sha256').update(after.layers[1].rgba).digest('hex'),
      lowerUnchanged: Buffer.from(before.layers[0].rgba).equals(Buffer.from(after.layers[0].rgba)) };
    const diagonal = await fixture('reference-eraser-diagonal.paint', '2d6b4529b743c9f46ec32f1172f44457139e76f46d37d2c5380bcc5d12707697');
    native.diagonal = createHash('sha256').update(diagonal.layers[1].rgba).digest('hex');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const [name, beforeName, beforeDigest, afterName, afterDigest, size, points] of [
    ['native 64-case color tolerance grid', 'reference-eraser-tolerance-fine.paint', '9489fab8ea67dbd50d6568853833b521a69802b05e316549352fc54b38552fb1', 'reference-eraser-tolerance-fine-result.paint', 'd6c819ba961492bb223e34ed11b8ac2d07d2a78b91d61b6d59aa879917190318', 248, [[62,61]]],
    ['native partial-alpha color replacement', 'reference-eraser-alpha-baseline.paint', '663c810d33c02a5f1e4f59fa04174758560badb1458ee41b1870318736039f38', 'reference-eraser-alpha-result.paint', 'c4aacd34b6f64990d732861a178db4290d4266f303122214bd9c7baf0da6472b', 8, [[103,224],[303,224],[503,224],[703,224]]],
  ]) {
    try {
      const before = await fixture(beforeName, beforeDigest), after = await fixture(afterName, afterDigest);
      comparisons.push({ name, width: before.width, height: before.height, size, points,
        source: Buffer.from(before.layers[0].rgba).toString('base64'), expected: Buffer.from(after.layers[0].rgba).toString('base64') });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const results = await page.evaluate(async ({ native, comparisons }) => {
    const { createEraserStroke, eraserFootprint } = await import('/src/eraser.js');
    const results = [], record = (name, ok, detail = null) => results.push({ name, ok, detail });
    const canvas = (width = 32, height = 24) => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; };
    const rgba = c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data];
    const pixel = (c, x, y) => [...c.getContext('2d').getImageData(x, y, 1, 1).data];
    const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const filled = color => { const c = canvas(); const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, c.width, c.height); return c; };
    const changed = (before, after, width) => {
      const points = [];
      for (let i = 0; i < before.length; i += 4) if (before.slice(i, i+4).some((v, n) => v !== after[i+n])) points.push([i/4%width, Math.floor(i/4/width)]);
      return points;
    };
    const left = filled('#ed1c24'), leftBefore = rgba(left);
    const erase = createEraserStroke(left.getContext('2d'), { size: 8, mode: 'erase' });
    erase.move(12, 10); erase.end();
    const square = changed(leftBefore, rgba(left), left.width);
    record('left eraser makes an exact eight-by-eight transparent square', square.length === 64 && square.every(([x, y]) =>
      x >= 8 && x < 16 && y >= 6 && y < 14 && equal(pixel(left, x, y), [0,0,0,0])));
    const horizontal = filled('#ed1c24'), horizontalBefore = rgba(horizontal);
    const sweep = createEraserStroke(horizontal.getContext('2d'), { size: 8, mode: 'erase' });
    sweep.move(7, 10); sweep.move(25, 10); sweep.end();
    const swept = changed(horizontalBefore, rgba(horizontal), horizontal.width);
    record('horizontal eraser sweep covers both square endpoints without gaps', swept.length === 26*8 && swept.every(([x, y]) => x >= 3 && x < 29 && y >= 6 && y < 14));
    const replacement = filled('#22b14c'), rc = replacement.getContext('2d');
    rc.fillStyle = '#ed1c24'; rc.fillRect(0, 0, 16, 24);
    const replace = createEraserStroke(rc, { size: 8, mode: 'replace', primary: '#ed1c24', secondary: '#00a2e8' });
    replace.move(16, 10); replace.end();
    record('right eraser replaces primary-colored pixels while preserving distinct green pixels', equal(pixel(replacement, 14, 10), [0,162,232,255]) &&
      equal(pixel(replacement, 17, 10), [34,177,76,255]) && equal(pixel(replacement, 9, 10), [237,28,36,255]));
    const empty = canvas(), emptyBefore = rgba(empty);
    const noMatch = createEraserStroke(empty.getContext('2d'), { mode: 'replace', size: 8, primary: '#000000', secondary: '#00a2e8' });
    noMatch.move(12, 10); noMatch.end();
    record('right eraser leaves unmatched transparent pixels unchanged', equal(rgba(empty), emptyBefore));
    const boundary = canvas(6, 1), bc = boundary.getContext('2d');
    const boundaryPixels = bc.createImageData(6, 1);
    boundaryPixels.data.set([239,29,37,255, 239,30,36,255, 240,28,36,255, 235,27,35,255, 238,29,37,255, 237,28,36,128]);
    bc.putImageData(boundaryPixels, 0, 0);
    const boundaryStroke = createEraserStroke(bc, { size: 8, mode: 'replace', primary: '#ed1c24', secondary: '#00a2e8' });
    boundaryStroke.move(3, 0); boundaryStroke.end();
    record('replacement accepts observed distance-six boundary and rejects distances eight and nine',
      equal(pixel(boundary,0,0), [0,162,232,255]) && equal(pixel(boundary,1,0), [239,30,36,255]) &&
      equal(pixel(boundary,2,0), [240,28,36,255]) && equal(pixel(boundary,3,0), [0,162,232,255]) && equal(pixel(boundary,4,0), [0,162,232,255]));
    const partial = pixel(boundary,5,0);
    record('replacement preserves original partial alpha and writes the secondary RGB', partial[3] === 128 && partial[0] === 0 && Math.abs(partial[1]-162) <= 1 && Math.abs(partial[2]-232) <= 1);
    const footprint = eraserFootprint(12, 10, 8);
    record('shared footprint exactly describes the single-click erased square', footprint.x === 8 && footprint.y === 6 && footprint.width === 8 && footprint.height === 8 &&
      square.every(([x,y]) => x >= footprint.x && x < footprint.x+footprint.width && y >= footprint.y && y < footprint.y+footprint.height) && eraserFootprint(NaN,0,8) === null);
    const clipped = filled('#ed1c24');
    const edge = createEraserStroke(clipped.getContext('2d'), { mode: 'erase', size: 8 }); edge.move(0, 0); edge.end();
    record('square erasure clips at the canvas boundary', rgba(clipped).filter((value, index) => index%4 === 3 && value === 0).length === 16);
    const ended = rgba(clipped); edge.end(); edge.move(20, 10);
    record('ending an eraser stroke is idempotent and later movement cannot paint', equal(rgba(clipped), ended));
    const preserved = filled('#ed1c24'), pc = preserved.getContext('2d');
    pc.globalAlpha = .4; pc.globalCompositeOperation = 'xor'; pc.translate(3, 2);
    const transform = [...pc.getTransform().toFloat64Array()];
    const preserve = createEraserStroke(pc, { size: 8, mode: 'erase' }); preserve.move(12, 10); preserve.end();
    record('eraser leaves caller context settings intact', pc.globalAlpha === .4 && pc.globalCompositeOperation === 'xor' && equal([...pc.getTransform().toFloat64Array()], transform));
    const forward = filled('#ed1c24'), reverse = filled('#ed1c24');
    for (const [target, points] of [[forward, [[-10000,-5000], [10000,5000]]], [reverse, [[10000,5000], [-10000,-5000]]]]) {
      const stroke = createEraserStroke(target.getContext('2d'), { mode: 'erase', size: 8 });
      for (const p of points) stroke.move(...p); stroke.end();
    }
    record('clipped square sweeps are direction independent for far-off-canvas endpoints', equal(rgba(forward), rgba(reverse)) &&
      rgba(forward).some((value, index) => index%4 === 3 && value === 0));
    const invalid = filled('#ed1c24'), invalidBefore = rgba(invalid);
    let rejected = 0;
    for (const options of [{ size: 0 }, { size: Infinity }, { mode: 'other' }, { mode: 'replace', primary: 'invalid-color' }]) {
      try { createEraserStroke(invalid.getContext('2d'), options); } catch { rejected++; }
    }
    record('invalid eraser options reject without modifying pixels', rejected === 4 && equal(rgba(invalid), invalidBefore));
    const { PaintDocument } = await import('/src/engine.js');
    const doc = new PaintDocument(32, 24); doc.begin('Fixture');
    doc.activeLayer.canvas.getContext('2d').fillStyle = '#ed1c24'; doc.activeLayer.canvas.getContext('2d').fillRect(0, 0, 32, 24); doc.commit(); doc.markSaved();
    const originalDocument = doc.activeLayer.canvas.toDataURL(), oldUndo = doc._undo.length;
    doc.begin('Erase'); let transactionStroke = createEraserStroke(doc.activeLayer.canvas.getContext('2d'), { size: 8, mode: 'erase' });
    transactionStroke.move(12, 10); transactionStroke.end(); doc.commit();
    const erasedDocument = doc.activeLayer.canvas.toDataURL(), oneEdit = doc._undo.length === oldUndo+1;
    doc.undo(); const undoRestored = doc.activeLayer.canvas.toDataURL() === originalDocument && !doc.dirty; doc.redo();
    record('caller-owned stroke transaction remains one reversible pixel edit', oneEdit && undoRestored && doc.activeLayer.canvas.toDataURL() === erasedDocument);
    doc.undo(); doc.begin('Cancelled erase'); transactionStroke = createEraserStroke(doc.activeLayer.canvas.getContext('2d'), { size: 8, mode: 'erase' });
    transactionStroke.move(12, 10); transactionStroke.end(); doc.cancel();
    const canceled = doc.activeLayer.canvas.toDataURL() === originalDocument && !doc.dirty && doc._undo.length === oldUndo;
    doc.begin('Unmatched replacement'); transactionStroke = createEraserStroke(doc.activeLayer.canvas.getContext('2d'), { size: 8, mode: 'replace', primary: '#22b14c', secondary: '#00a2e8' });
    transactionStroke.move(12, 10); transactionStroke.end(); doc.commit();
    record('cancelled erasure and unmatched replacement preserve pixels, saved state and history', canceled && doc.activeLayer.canvas.toDataURL() === originalDocument && !doc.dirty && doc._undo.length === oldUndo);
    if (native) {
      const target = canvas(native.width, native.height), ctx = target.getContext('2d');
      const source = Uint8Array.from(atob(native.source), character => character.charCodeAt(0));
      const pixels = ctx.createImageData(native.width, native.height); pixels.data.set(source); ctx.putImageData(pixels, 0, 0);
      // Native endpoint status was (703,99); the start (66,99) is reconstructed from changed bounds.
      const leftStroke = createEraserStroke(ctx, { size: 8, mode: 'erase' }); leftStroke.move(66, 99); leftStroke.move(703, 99); leftStroke.end();
      for (const x of [103, 303]) {
        const rightStroke = createEraserStroke(ctx, { size: 8, mode: 'replace', primary: '#ed1c24', secondary: '#00a2e8' });
        rightStroke.move(x, 224); rightStroke.end();
      }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, native.width, native.height).data))].map(value => value.toString(16).padStart(2, '0')).join('');
      record('owned native eraser fixture matches all upper-layer pixels and leaves lower layer unchanged', digest === native.expected && native.lowerUnchanged, { actual: digest, expected: native.expected });
      if (native.diagonal) {
        const diagonal = createEraserStroke(ctx, { size: 8, mode: 'erase' });
        diagonal.move(66, 274); diagonal.move(378, 361); diagonal.end();
        const diagonalDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, native.width, native.height).data))].map(value => value.toString(16).padStart(2, '0')).join('');
        record('continuous square sweep matches every pixel of the owned native diagonal fixture', diagonalDigest === native.diagonal,
          { actual: diagonalDigest, expected: native.diagonal });
      }

    }
    for (const reference of comparisons) {
      const target = canvas(reference.width, reference.height), ctx = target.getContext('2d');
      const decode = encoded => Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const source = ctx.createImageData(reference.width, reference.height); source.data.set(decode(reference.source)); ctx.putImageData(source,0,0);
      for (const point of reference.points) {
        const stroke = createEraserStroke(ctx, { size: reference.size, mode: 'replace', primary: '#ed1c24', secondary: '#00a2e8' });
        stroke.move(...point); stroke.end();
      }
      const actual = ctx.getImageData(0,0,reference.width,reference.height).data, expected = decode(reference.expected);
      let alphaDifferences = 0, premultipliedDifferences = 0;
      // Native and Canvas can expose different straight RGB after unpremultiplying.
      // Compare their stored premultiplied bytes, and always compare alpha exactly.
      for (let i=0;i<actual.length;i+=4) {
        if (actual[i+3] !== expected[i+3]) alphaDifferences++;
        for (let c=0;c<3;c++) if (Math.round(actual[i+c]*actual[i+3]/255) !== Math.round(expected[i+c]*expected[i+3]/255)) premultipliedDifferences++;
      }
      record(reference.name+' matches every alpha and premultiplied color byte', !alphaDifferences && !premultipliedDifferences, { alphaDifferences, premultipliedDifferences });
    }
    return results;
  }, { native, comparisons });
  for (const result of results) check(result.name, result.ok, result.detail);
}
