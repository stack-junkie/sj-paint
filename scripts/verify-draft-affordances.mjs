// Public drawing and text drafts must expose consistent cancellation and dirty
// affordances as other pending artwork. This is an SJ Paint correctness check.
export async function verifyDraftAffordances(page, check) {
  const initial = await page.evaluate(() => ({ project: paintApp.doc.serialize(), state: { ...paintApp.state },
    controls: Object.fromEntries(['outline', 'shape-fill', 'size', 'size-number'].map(id => [id, document.getElementById(id).value])) }));
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => {
    const d = paintApp.doc;
    return { project: JSON.stringify(d.serialize()), display: document.querySelector('#canvas').toDataURL(),
      revision: d.revision, savedRevision: d._savedRevision, dirty: d.dirty,
      undo: d._undo.length, redo: d._redo.length, transaction: Boolean(d._transaction),
      selection: Boolean(d.selection), session: d.hasSelectionSession,
      undoDisabled: document.querySelector('[data-action="undo"]').disabled,
      title: document.title, status: document.querySelector('#document-state').textContent,
      text: document.querySelector('.text-editor')?.value };
  });
  const move = async (x, y) => {
    const bounds = await page.locator('#overlay').boundingBox();
    await page.mouse.move(bounds.x + x, bounds.y + y);
  };
  const click = async (x, y) => { await move(x, y); await page.mouse.down(); await page.mouse.up(); };
  const fixture = async () => {
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(() => {
      const d = paintApp.doc; d.newDocument(300, 200);
      Object.assign(paintApp.state, { name: 'Draft affordance fixture', primary: '#000000', secondary: '#ffffff',
        size: 3, opacity: 1, outline: 'solid', fillStyle: 'none', grid: false, rulers: false });
      d.markSaved(); paintApp.setZoom(1);
    });
    await page.waitForFunction(() => document.querySelector('#overlay').width === 300 &&
      Math.abs(document.querySelector('#overlay').getBoundingClientRect().width - 300) < 0.02);
    await page.locator('#outline').selectOption('solid'); await page.locator('#shape-fill').selectOption('none');
    await frame(); return snapshot();
  };
  const unchanged = (actual, baseline) => actual.project === baseline.project && actual.revision === baseline.revision &&
    actual.savedRevision === baseline.savedRevision && !actual.dirty && actual.undo === baseline.undo && actual.redo === baseline.redo;
  try {
    for (const tool of ['curve', 'polygon']) {
      const baseline = await fixture();
      await page.locator(`[data-tool="${tool}"]`).click();
      if (tool === 'curve') {
        await move(30, 60); await page.mouse.down(); await move(170, 100); await page.mouse.up();
      } else {
        await click(30, 30); await click(170, 30); await click(100, 130);
      }
      await frame(); const draft = await snapshot();
      check(`${tool} has a visible pending draft without altering saved pixels or history`,
        draft.display !== baseline.display && draft.transaction && unchanged(draft, baseline), draft);
      check(`${tool} draft enables toolbar Undo and reports unsaved work`,
        !draft.undoDisabled && draft.title.includes(' •') && draft.status === 'Unsaved changes',
        { undoDisabled: draft.undoDisabled, title: draft.title, status: draft.status });

      // A broken disabled control has already failed the check. Avoid waiting
      // for Playwright's actionability timeout and let the cleanup checks fail.
      if (!draft.undoDisabled) await page.locator('[data-action="undo"]').click();
      await frame(); const canceled = await snapshot();
      check(`toolbar Undo cancels the entire ${tool} draft and restores the clean baseline`,
        unchanged(canceled, baseline) && canceled.display === baseline.display && !canceled.transaction &&
        !canceled.selection && !canceled.session && canceled.undoDisabled &&
        canceled.title === baseline.title && canceled.status === baseline.status, canceled);

      await page.locator('[data-tool="pencil"]').click(); await frame(); const switched = await snapshot();
      check(`switching tools after ${tool} cancellation cannot resurrect pixels or history`,
        unchanged(switched, baseline) && switched.display === baseline.display && !switched.transaction &&
        switched.title === baseline.title && switched.status === baseline.status, switched);
    }

    const baseline = await fixture();
    await page.locator('[data-tool="text"]').click(); await click(30, 30); await frame();
    const empty = await snapshot(), transaction = await page.evaluateHandle(() => paintApp.doc._transaction);
    try {
      check('an empty text editor retains its transaction without reporting unsaved artwork',
        empty.text === '' && empty.transaction && unchanged(empty, baseline) && empty.undoDisabled &&
        empty.title === baseline.title && empty.status === baseline.status, empty);
      await page.locator('.text-editor').fill('Pending text'); await frame(); const typed = await snapshot();
      check('typing text immediately enables toolbar Undo and reports unsaved artwork',
        typed.text === 'Pending text' && typed.transaction && unchanged(typed, baseline) &&
        !typed.undoDisabled && typed.title.includes(' •') && typed.status === 'Unsaved changes', typed);
      await page.locator('.text-editor').press('Control+a'); await page.locator('.text-editor').press('Backspace');
      await frame(); const erased = await snapshot();
      check('erasing all draft text restores clean indicators without replacing its transaction or history',
        erased.text === '' && erased.transaction && unchanged(erased, baseline) && erased.undoDisabled &&
        erased.title === baseline.title && erased.status === baseline.status &&
        await page.evaluate(before => paintApp.doc._transaction === before, transaction), erased);
    } finally { await transaction.dispose(); }
    await page.locator('.text-editor').fill('Undo this text'); await frame();
    const typedAgain = await snapshot();
    if (!typedAgain.undoDisabled) await page.locator('[data-action="undo"]').click();
    await frame(); const undoneText = await snapshot();
    check('toolbar Undo removes the text draft and returns to the saved pixels with one redoable edit',
      undoneText.text === undefined && !undoneText.transaction && undoneText.project === baseline.project &&
      undoneText.display === baseline.display && undoneText.revision === baseline.revision &&
      undoneText.savedRevision === baseline.savedRevision && !undoneText.dirty &&
      undoneText.undo === baseline.undo && undoneText.redo === baseline.redo + 1 && undoneText.undoDisabled &&
      undoneText.title === baseline.title && undoneText.status === baseline.status, undoneText);
  } finally {
    await page.locator('#overlay').focus(); await page.keyboard.press('Escape'); await page.mouse.up();
    await page.evaluate(async initial => {
      await paintApp.doc.load(initial.project); Object.assign(paintApp.state, initial.state); paintApp.setZoom(initial.state.zoom);
      document.querySelector('#layers-panel').hidden = !initial.state.layers;
      for (const [id, value] of Object.entries(initial.controls)) document.getElementById(id).value = value;
    }, initial);
    await page.waitForFunction(project => document.querySelector('#overlay').width === project.width &&
      document.querySelector('#overlay').height === project.height, initial.project);
  }
}
