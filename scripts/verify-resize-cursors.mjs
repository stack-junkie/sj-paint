export async function verifyResizeCursorsDesktop(page, check) {
  const overlay = page.locator('#overlay');
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cursor = () => overlay.evaluate(el => getComputedStyle(el).cursor);
  const pixels = () => page.locator('#canvas').evaluate(el => el.toDataURL());
  const initial = await pixels();
  const initialZoom=await page.locator('#zoom-presets').inputValue();
  const initialTool=await page.evaluate(()=>({tool:document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,label:document.querySelector('#tool-label').textContent}));
  if (await page.locator('[data-action="undo"]').isEnabled()) throw new Error('Cursor fixture requires a pristine document.');
  const move = async ([x,y]) => { const b = await overlay.boundingBox(); const zoom = Number(await page.locator('#zoom-presets').inputValue()); await page.mouse.move(b.x+x*zoom,b.y+y*zoom,{steps:4}); await frame(); };
  const drag = async (start,end) => { await move(start); await page.mouse.down(); await move(end); await page.mouse.up(); await frame(); };
  const handles = [[80,100],[160,100],[240,100],[240,150],[240,200],[160,200],[80,200],[80,150]];
  const expected = ['nwse-resize','ns-resize','nesw-resize','ew-resize','nwse-resize','ns-resize','nesw-resize','ew-resize'];
  try {
    await page.locator('#zoom-presets').selectOption('1');await frame();
    for (const tool of ['rectangle','select']) {
      await page.locator(`[data-tool="${tool}"]`).click(); await drag(handles[0],handles[4]);
      for (let i=0;i<handles.length;i++) { await move(handles[i]); check(`${tool} handle ${i} cursor matches its resize direction`, await cursor() === expected[i], await cursor()); }
      await move(handles[2]); await page.mouse.down(); await move([260,90]);
      check(`${tool} held resize retains its cursor across redraw`, await cursor() === 'nesw-resize', await cursor());
      await page.mouse.up(); await frame();
      check(`${tool} release keeps the handle cursor`, await cursor() === 'nesw-resize', await cursor());
      await page.keyboard.press('Escape'); await frame();
      check(`${tool} cancellation restores pixels, history and base cursor`, await pixels() === initial && await page.locator('[data-action="undo"]').isDisabled() && await cursor() === 'crosshair');
      await drag(handles[0],handles[4]);
      await drag([160,76],[160+74/Math.SQRT2,150-74/Math.SQRT2]);
      const rotated = ['ns-resize','nesw-resize','ew-resize','nwse-resize','ns-resize','nesw-resize','ew-resize','nwse-resize'];
      for (let i=0;i<handles.length;i++) {
        const [x,y]=handles[i],dx=x-160,dy=y-150;
        await move([160+(dx-dy)/Math.SQRT2,150+(dx+dy)/Math.SQRT2]);
        const actual=await cursor();
        check(`${tool} rotated handle ${i} uses its screen direction`,actual === rotated[i],{actual,expected:rotated[i],overlay:await overlay.boundingBox(),zoom:await page.locator('#zoom-presets').inputValue(),tool:await page.locator('#tool-label').textContent()});
      }
      await page.keyboard.press('Escape'); await frame();
      await drag(handles[0],handles[4]); await move(handles[3]);
      await overlay.evaluate(el => el.addEventListener('pointerdown',event=>{el.dataset.observedPointerId=event.pointerId;},{once:true}));
      await page.mouse.down();await move([260,150]);
      await overlay.evaluate(el=>{el.releasePointerCapture(Number(el.dataset.observedPointerId));delete el.dataset.observedPointerId;});
      await page.mouse.up();await frame();
      const loss={cursor:await cursor(),pixels:await pixels()===initial,undo:await page.locator('[data-action="undo"]').isDisabled()};
      check(`${tool} capture loss restores cursor and retains the existing cancellation boundary`,loss.cursor==='crosshair'&&loss.pixels&&loss.undo===(tool!=='select'),loss);
      await page.keyboard.press('Escape');await frame();
      check(`${tool} cancellation after capture loss leaves no Undo entry`,await page.locator('[data-action="undo"]').isDisabled());
      await page.locator('#zoom-presets').selectOption({label:'50%'});await frame();
      await drag(handles[0],handles[4]);await move(handles[1]);
      check(`${tool} handle direction is independent of zoom`,await cursor()==='ns-resize');
      await page.keyboard.press('Escape');await page.locator('#zoom-presets').selectOption('1');await frame();
    }
    await page.locator('[data-tool="rectangle"]').click(); await drag(handles[0],handles[4]);
    await move(handles[3]); await page.mouse.down(); await move([260,150]); await page.mouse.up();
    await page.keyboard.press('Control+Space'); await frame(); const committed = await pixels();
    check('cursor updates preserve a committed resize and one Undo boundary',committed !== initial && await page.locator('[data-action="undo"]').isEnabled());
    await page.keyboard.press('Control+z'); await frame();
    check('cursor-only state leaves Undo pixels exact',await pixels() === initial);
    await page.keyboard.press('Control+y'); await frame();
    check('cursor-only state leaves Redo pixels exact',await pixels() === committed);
  } finally {
    await page.mouse.up(); await page.keyboard.press('Escape');
    if(await page.locator('[data-action="undo"]').isEnabled())await page.keyboard.press('Control+z');await frame();
    await page.keyboard.press('Control+n');
    const discard=page.getByRole('button',{name:"Don't save",exact:true});if(await discard.isVisible())await discard.click();
    if(initialTool.tool)await page.locator(`[data-tool="${initialTool.tool}"]`).click();
    else{await page.locator('[data-menu="brushes"]').click();await page.getByRole('menuitemradio',{name:initialTool.label,exact:true}).click();}
    await page.locator('#zoom-presets').selectOption(initialZoom);await frame();
  }
}
export async function verifyResizeCursors(page,check) {
 const context=await page.context().browser().newContext({viewport:page.viewportSize()});
 try {const target=await context.newPage();await target.goto(page.url());await target.locator('#overlay').waitFor();await verifyResizeCursorsDesktop(target,check);} finally{await context.close();}
}
