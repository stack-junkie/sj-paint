import { chooseShapeStyle } from './shape-style-controls.mjs';
// Ctrl+Space is advertised by the native control-point help resource. These
// checks establish SJ Paint's public behavior, not native timing or raster parity.
export async function verifyKeyboardCommit(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state },
    controls: Object.fromEntries(['outline', 'shape-fill', 'size', 'size-number', 'font', 'font-size', 'text-background'].map(id => {
      const el = document.getElementById(id); return [id, { value: el.value, checked: el.checked }];
    })) }));
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc, overlay = document.querySelector('#overlay');
    const pixels = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
    return { display: document.querySelector('#canvas').toDataURL(), layer: d.activeLayer.canvas.toDataURL(),
      undo: d._undo.length, redo: d._redo.length, session: d.hasSelectionSession,
      selected: Boolean(d.selection), transaction: Boolean(d._transaction),
      controls: pixels.some((value, index) => index % 4 === 3 && value > 0),
      text: document.querySelector('.text-editor')?.value };
  });
  const fixture = async selected => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(selected => {
      const d = paintApp.doc; d.newDocument(300, 200);
      Object.assign(paintApp.state, { primary: '#000000', secondary: '#ffffff', size: 3, opacity: 1,
        outline: 'solid', fillStyle: 'none', grid: false, rulers: false, transparentSelection: false,
        font: 'Arial', fontSize: 24, bold: false, italic: false, underline: false, strikethrough: false,
        textBackground: false, align: 'left' });
      d.setSelectionTransparency(false, '#ffffff');
      if (selected) {
        d.begin('Keyboard commit fixture'); const ctx = d.activeLayer.canvas.getContext('2d');
        ctx.fillStyle = '#ff0000'; ctx.fillRect(30, 30, 40, 30); d.commit();
      }
      d.markSaved(); paintApp.setZoom(1);
    }, selected);
    await page.waitForFunction(() => document.querySelector('#overlay').width === 300 &&
      Math.abs(document.querySelector('#overlay').getBoundingClientRect().width - 300) < 0.02);
    await frame(); return snapshot();
  };
  const drag = async (x1, y1, x2, y2) => {
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.move(bounds.x + x1, bounds.y + y1); await page.mouse.down();
    await page.mouse.move(bounds.x + x2, bounds.y + y2, { steps: 4 }); await page.mouse.up(); await frame();
  };
  const historyRoundtrip = async (name, baseline, committed) => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+z'); await frame();
    const undone = await snapshot();
    check(`one Undo restores the whole ${name} baseline`, undone.layer === baseline.layer &&
      undone.display === baseline.display && undone.undo === baseline.undo && !undone.controls && !undone.selected);
    await page.keyboard.press('Control+y'); await frame(); const redone = await snapshot();
    check(`one Redo restores the committed ${name} without editable handles`,
      redone.layer === committed.layer && redone.display === committed.display && !redone.controls && !redone.selected);
  };
  try {
    for (const focus of ['#overlay', '#selection-rotation']) {
      const baseline = await fixture(true);
      await page.locator('[data-tool="select"]').click();
      await drag(20, 20, 80, 70); await drag(50, 45, 120, 85);
      const preview = await snapshot();
      check(`selection fixture remains moved and editable before Ctrl+Space from ${focus}`,
        preview.selected && preview.session && preview.controls && preview.display !== baseline.display && preview.undo === baseline.undo);
      await page.locator(focus).focus(); await page.keyboard.press('Control+Space'); await frame();
      const committed = await snapshot();
      check(`Ctrl+Space from ${focus} commits selected pixels without changing the preview`,
        !committed.selected && !committed.session && !committed.controls && !committed.transaction &&
        committed.display === preview.display && committed.undo === baseline.undo + 1);
      await historyRoundtrip(`selection (${focus})`, baseline, committed);
    }

    const baseline = await fixture(false);
    await page.locator('[data-tool="rectangle"]').click();
    await chooseShapeStyle(page, 'outline', 'solid'); await chooseShapeStyle(page, 'fillStyle', 'none');
    await drag(40, 60, 160, 140); const preview = await snapshot();
    check('ordinary shape remains a pending preview before keyboard commitment',
      preview.controls && preview.transaction && preview.layer === baseline.layer && preview.display !== baseline.display);
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+Space'); await frame();
    const committed = await snapshot();
    const delta = await page.evaluate(async ([a,b]) => {
      const pixels=async url=>{const c=document.createElement('canvas');c.width=300;c.height=200;const x=c.getContext('2d');x.drawImage(await createImageBitmap(await (await fetch(url)).blob()),0,0);return x.getImageData(0,0,300,200).data;};
      const aa=await pixels(a),bb=await pixels(b), differences=[];let count=0,max=0;
      for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i]){count++;max=Math.max(max,Math.abs(aa[i]-bb[i]));if(differences.length<8)differences.push([i,aa[i],bb[i]]);}
      return {count,max,differences};
    }, [preview.display,committed.display]);
    check('Ctrl+Space commits the ordinary shape and removes handles without changing displayed pixels',
      !committed.controls && !committed.transaction && committed.layer !== baseline.layer &&
      committed.display === preview.display && committed.undo === baseline.undo + 1,
      { controls: committed.controls, transaction: committed.transaction, changed: committed.layer !== baseline.layer,
        sameDisplay: committed.display === preview.display, undo: committed.undo, previousUndo: baseline.undo, delta });
    await historyRoundtrip('ordinary shape', baseline, committed);

    await fixture(false); await page.locator('[data-tool="text"]').click();
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x + 20, bounds.y + 20);
    await page.locator('.text-editor').fill('Retain editable text'); const draft = await snapshot();
    await page.keyboard.press('Control+Space'); await frame(); const after = await snapshot();
    check('Ctrl+Space inside a textarea retains the draft and document transaction',
      after.text === draft.text && after.transaction && after.layer === draft.layer &&
      after.undo === draft.undo && after.redo === draft.redo && await page.locator('.text-editor').evaluate(el => el === document.activeElement));
  } finally {
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      for (const [id, properties] of Object.entries(initial.controls)) Object.assign(document.getElementById(id), properties);
    }, initial);
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width &&
      document.querySelector('#overlay').height === project.height, initial.project);
  }
}
