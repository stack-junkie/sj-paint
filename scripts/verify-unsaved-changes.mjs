// Private save bridge exercises renderer decisions without native dialogs/files.
export async function verifyUnsavedChanges(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state } }));
  await page.evaluate(() => {
    const q = window.__unsaved = { descriptor: Object.getOwnPropertyDescriptor(window, 'paintDesktop'), saves: [], opens: 0 };
    q.fixture = () => {
      paintApp.doc.newDocument(240, 160);
      Object.assign(paintApp.state, { name: 'drawing', format: 'png', project: false });
      paintApp.setZoom(1);
      q.edit(); q.saves = []; q.receipt = { name: 'drawing.png', target: 'private-destination' };
      q.fail = false; q.defer = false; q.release = null;
    };
    q.edit = () => { const d = paintApp.doc; d.begin('Unsaved fixture');
      d.activeLayer.canvas.getContext('2d').fillRect(d._undo.length * 12 + 4, 4, 8, 8); d.commit(); };
    const save = async request => {
      q.saves.push(request);
      if (q.fail) throw new Error('Private save failure');
      if (q.defer) return new Promise(resolve => { q.release = () => resolve(q.receipt); });
      return q.receipt;
    };
    Object.defineProperty(window, 'paintDesktop', { configurable: true, value: {
      setTitle() {}, saveImage: save, saveProject: save, savePaint: save,
      openImage: async () => { q.opens++; return null; },
    } });
  });
  const fixture = () => page.evaluate(() => __unsaved.fixture());
  const start = action => page.evaluate(action => {
    __unsaved.done = false; __unsaved.error = null;
    __unsaved.pending = Promise.resolve(paintApp.actions[action]()).catch(e => { __unsaved.error = e.message; })
      .finally(() => { __unsaved.done = true; });
  }, action);
  const finish = () => page.waitForFunction(() => __unsaved.done);
  const snapshot = () => page.evaluate(() => ({ project: paintApp.doc.serialize(), name: paintApp.state.name,
    dirty: paintApp.doc.dirty, undo: paintApp.doc._undo.length, revision: paintApp.doc.revision }));
  const choose = async choice => {
    await page.getByRole('heading', { name: 'Unsaved changes', exact: true }).waitFor();
    await page.locator(choice === 'save' ? '#dialog button[type="submit"]' : choice === 'discard' ? '#dialog-alternate' : '#dialog-cancel').click();
  };
  try {
    await fixture(); const original = await snapshot();
    await start('new'); await choose('cancel'); await finish();
    check('Cancel New preserves document pixels, identity and history', JSON.stringify(await snapshot()) === JSON.stringify(original));
    await start('open'); await choose('cancel'); await finish();
    check('Cancel Open never invokes the picker or changes the drawing', await page.evaluate(() => __unsaved.opens === 0) && JSON.stringify(await snapshot()) === JSON.stringify(original));

    await page.evaluate(() => { __unsaved.receipt = false; });
    await start('new'); await choose('save'); await finish();
    check('canceling the save destination prevents New', JSON.stringify(await snapshot()) === JSON.stringify(original));
    await page.evaluate(() => { __unsaved.fail = true; });
    await start('open'); await choose('save'); await finish();
    check('failed Save prevents Open and retains unsaved pixels', await page.evaluate(() => __unsaved.opens === 0 && __unsaved.error === 'Private save failure') && JSON.stringify(await snapshot()) === JSON.stringify(original));

    await fixture(); await start('new'); await choose('save'); await finish();
    check('successful Save writes before creating a clean new document', await page.evaluate(() => __unsaved.saves.length === 1 && paintApp.state.name === 'Untitled' && !paintApp.doc.dirty && paintApp.doc.width === 1152));
    await fixture(); await start('open'); await choose('save'); await finish();
    check('successful Save permits Open and a canceled picker retains the saved drawing', await page.evaluate(() => __unsaved.opens === 1 && __unsaved.saves.length === 1 && !paintApp.doc.dirty && paintApp.doc.width === 240));
    await fixture(); await start('new'); await choose('discard'); await finish();
    check('Don\'t save creates a new document without writing', await page.evaluate(() => __unsaved.saves.length === 0 && paintApp.state.name === 'Untitled'));

    await fixture(); await start('new'); await page.getByRole('heading', { name: 'Unsaved changes', exact: true }).waitFor();
    await page.evaluate(() => __unsaved.edit()); const newer = await snapshot();
    await choose('discard'); await finish();
    check('an edit made during the prompt invalidates discard approval', JSON.stringify(await snapshot()) === JSON.stringify(newer));
    await fixture(); await page.evaluate(() => { __unsaved.defer = true; });
    await start('new'); await choose('save'); await page.waitForFunction(() => __unsaved.release);
    await page.evaluate(() => __unsaved.edit()); const edited = await snapshot();
    await page.evaluate(() => __unsaved.release()); await finish();
    check('an edit made while saving prevents New and remains dirty', JSON.stringify(await snapshot()) === JSON.stringify(edited));

    await fixture(); await page.evaluate(() => { paintApp.doc.markSaved(); });
    await page.locator('[data-tool="text"]').click();
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.click(bounds.x + 20, bounds.y + 20); await page.locator('.text-editor').fill('Keep this draft');
    await start('new'); await choose('cancel'); await finish();
    check('Cancel retains pending text as committed editable history', await page.evaluate(() => paintApp.doc.dirty && paintApp.doc._undo.length === 2 && paintApp.doc.width === 240 && !document.querySelector('.text-editor')));

    await fixture(); await page.evaluate(() => paintApp.doc.addLayer());
    const layered = await snapshot();
    await start('save'); await page.getByRole('heading', { name: 'Save as flattened image?', exact: true }).waitFor();
    await page.locator('#dialog-cancel').click(); await finish();
    check('canceling flatten warning makes no write or document change', await page.evaluate(() => __unsaved.saves.length === 0) && JSON.stringify(await snapshot()) === JSON.stringify(layered));
    await start('new'); await choose('save');
    await page.getByRole('heading', { name: 'Save as flattened image?', exact: true }).waitFor(); await page.locator('#dialog-cancel').click(); await finish();
    check('canceling flatten during Save before New retains every layer', JSON.stringify(await snapshot()) === JSON.stringify(layered));
    await start('save'); await page.getByRole('heading', { name: 'Save as flattened image?', exact: true }).waitFor();
    await page.locator('#dialog button[type="submit"]').click(); await finish();
    check('confirmed flattened export retains editable layers and their dirty state', await page.evaluate(() => __unsaved.saves.length === 1 && paintApp.doc.layers.length === 2 && paintApp.doc.dirty));
    await page.evaluate(() => { paintApp.state.format = 'tiff'; });
    await start('save-as'); await page.getByRole('heading', { name: 'Save image', exact: true }).waitFor();
    check('Save As initially selects the current document format', await page.locator('#dialog [name="format"]').inputValue() === 'tiff');
    await page.locator('#dialog-cancel').click(); await finish();
    await fixture(); await page.evaluate(() => { paintApp.state.name = 'Untitled'; void paintApp.actions.properties(); });
    await page.locator('#dialog [name="width"]').fill('99');
    await start('new'); await choose('save');
    await page.getByRole('heading', { name: 'Save image', exact: true }).waitFor();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
    check('replacing a modal cannot submit its stale values or resolve the new Save As',
      await page.evaluate(() => document.querySelector('#dialog').open && !__unsaved.done && __unsaved.saves.length === 0 && paintApp.doc.width === 240));
    await page.keyboard.press('Escape'); await finish();
    check('Escape from replacement Save As keeps the unsaved document', await page.evaluate(() => paintApp.doc.width === 240 && paintApp.doc.dirty && __unsaved.saves.length === 0));
  } finally {
    if (await page.locator('#dialog').evaluate(d => d.open)) await page.locator('#dialog-cancel').click();
    await page.evaluate(async initial => {
      const q = __unsaved; q.release?.(); await q.pending;
      if (q.descriptor) Object.defineProperty(window, 'paintDesktop', q.descriptor); else delete window.paintDesktop;
      delete window.__unsaved;
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
    }, initial);
  }
}
