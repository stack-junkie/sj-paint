// Native app.quit and real beforeunload/IPC; only confirmation responses are
// substituted by the owning desktop harness. No model or clipboard operation.
export async function verifyQuitCancelDesktop(page, check, main, { draw = true, finishQuit = true, hidden = true } = {}) {
  if (draw) {
    await page.getByRole('button', { name: 'Pencil', exact: true }).click();
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
    await page.mouse.move(box.x + 70, box.y + 40, { steps: 6 }); await page.mouse.up();
  }
  await page.waitForFunction(() => document.title.includes('•'));
  const pixels = await page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const before = await page.evaluate(() => window.paintDesktop.localAiStatus());
  check('AI owner is open before the native quit request', before.ok && !before.value.closed && !before.value.closing, before);
  await main(`(() => {
    const q = __sjPaintVerification;
    q.confirmCalls = 0; q.confirmResponse = 2;
    setTimeout(() => q.electron.app.quit(), 50);
    return true;
  })()`);
  let confirmed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await main('__sjPaintVerification.confirmCalls') > 0) { confirmed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  check('native application quit reaches the dirty-drawing confirmation', confirmed &&
    JSON.stringify(await main('__sjPaintVerification.lastConfirmOptions.buttons')) === JSON.stringify(['Save', "Don't save", 'Cancel']));
  check('Cancel vetoes native application quit and preserves exact dirty pixels', !page.isClosed() &&
    (await page.title()).includes('•') && await page.locator('#canvas').evaluate(canvas => canvas.toDataURL()) === pixels);
  const after = await page.evaluate(() => window.paintDesktop.localAiStatus());
  check('Cancel leaves the existing AI controller and service open', after.ok && !after.value.closed && !after.value.closing, after);
  // Invalid operation ID is rejected before backend admission regardless of
  // installed models, so this checks the real service without loading a model.
  const admission = await page.evaluate(() => window.paintDesktop.localAiGenerate({ id: '?', targetToken: 'quit-review', mode: 'create' }));
  check('AI admission remains reachable after canceled quit without starting inference',
    !admission.ok && ['INPUT', 'UNCONFIGURED'].includes(admission.error?.code), admission);
  if (hidden) check('canceled application quit keeps its Windows window hidden', await main('__sjPaintVerification.electron.BrowserWindow.getAllWindows().every(window => !window.isVisible())'));
  if (!finishQuit) return;
  await main('(() => { __sjPaintVerification.confirmResponse = 1; return true; })()');
  const closed = page.waitForEvent('close', { timeout: 30000 });
  await main('(() => { setTimeout(() => __sjPaintVerification.electron.app.quit(), 50); return true; })()');
  await closed;
  check('a later approved native application quit closes the same window', page.isClosed());
}
