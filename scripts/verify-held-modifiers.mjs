export async function verifyHeldModifiersDesktop(page, check) {
 const overlay=page.locator('#overlay'),frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const pixels=()=>page.locator('#canvas').evaluate(el=>el.toDataURL());const initial=await pixels();
 const initialZoom=await page.locator('#zoom-presets').inputValue();
 const initialTool=await page.evaluate(()=>({tool:document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,label:document.querySelector('#tool-label').textContent}));
 if(await page.locator('[data-action="undo"]').isEnabled())throw new Error('Modifier fixture requires a pristine document.');
 const move=async(x,y)=>{const b=await overlay.boundingBox();await page.mouse.move(b.x+x,b.y+y);await frame();};
 try {
  await page.locator('#zoom-presets').selectOption('1');await frame();
  for(const tool of ['curve','line','rectangle']){
   await page.locator(`[data-tool="${tool}"]`).click();await move(80,100);await page.mouse.down();await move(240,160);const free=await pixels();
   await page.keyboard.down('Shift');await frame();const constrained=await pixels();
   check(`${tool} Shift changes the held preview without pointer movement`,constrained!==free);
   await page.keyboard.down('Shift');await frame();check(`${tool} repeated Shift leaves the preview stable`,await pixels()===constrained);
   await page.keyboard.up('Shift');await frame();check(`${tool} releasing Shift while held restores unconstrained geometry`,await pixels()===free);
   await page.keyboard.down('Shift');await frame();await page.mouse.up();await frame();
   check(`${tool} mouse release retains the constrained preview`,await pixels()===constrained);
   await page.keyboard.up('Shift');await frame();check(`${tool} later Shift release cannot change released geometry`,await pixels()===constrained);
   await page.keyboard.press('Escape');await frame();check(`${tool} cancellation restores pristine pixels and history`,await pixels()===initial&&await page.locator('[data-action="undo"]').isDisabled());
   await move(80,100);await page.mouse.down();await move(240,160);await page.keyboard.down('Shift');await frame();await page.mouse.up();await page.keyboard.up('Shift');
   await page.locator('[data-tool="pencil"]').click();await frame();const committed=await pixels();
   check(`${tool} continued drawing commits the same constrained geometry`,committed===constrained);
   await page.keyboard.press('Control+z');await frame();check(`${tool} constrained construction is one Undo step`,await pixels()===initial&&await page.locator('[data-action="undo"]').isDisabled());
   await page.keyboard.press('Control+y');await frame();check(`${tool} constrained construction Redo is exact`,await pixels()===committed);
   await page.keyboard.press('Control+z');await frame();await page.keyboard.press('Control+n');await frame();
  }
  await page.locator('[data-tool="rectangle"]').click();await move(80,100);await page.mouse.down();await move(240,160);await page.mouse.up();
  await move(240,160);await page.mouse.down();await move(280,220);const resized=await pixels();
  await page.keyboard.down('Shift');await frame();const proportional=await pixels();
  check('stationary Shift recomputes a pending-shape resize through its existing geometry owner',proportional!==resized);
  await page.keyboard.up('Shift');await frame();check('releasing Shift restores the unconstrained pending resize',await pixels()===resized);
  await page.keyboard.down('Shift');await frame();await page.mouse.up();await page.keyboard.up('Shift');await frame();
  check('released pending resize retains its constrained geometry',await pixels()===proportional);
  await page.keyboard.press('Escape');await frame();
  await move(80,100);await page.mouse.down();await move(240,160);await page.keyboard.down('Shift');await frame();
  await overlay.evaluate(el=>{const id=[...Array(16).keys()].find(id=>el.hasPointerCapture(id));if(id===undefined)throw new Error('Expected owned mouse capture');el.releasePointerCapture(id);});
  await page.mouse.up();await page.keyboard.up('Shift');await frame();
  check('capture loss and later Shift release cannot restore canceled shape pixels',await pixels()===initial&&await page.locator('[data-action="undo"]').isDisabled());
 }finally{
  await page.keyboard.up('Shift');await page.mouse.up();await page.keyboard.press('Escape');
  if(await page.locator('[data-action="undo"]').isEnabled())await page.keyboard.press('Control+z');await frame();await page.keyboard.press('Control+n');
  const discard=page.getByRole('button',{name:"Don't save",exact:true});if(await discard.isVisible())await discard.click();
  if(initialTool.tool)await page.locator(`[data-tool="${initialTool.tool}"]`).click();else{await page.locator('[data-menu="brushes"]').click();await page.getByRole('menuitemradio',{name:initialTool.label,exact:true}).click();}
  await page.locator('#zoom-presets').selectOption(initialZoom);await frame();
 }
}
export async function verifyHeldModifiers(page,check){const context=await page.context().browser().newContext({viewport:page.viewportSize()});try{const target=await context.newPage();await target.goto(page.url());await target.locator('#overlay').waitFor();await verifyHeldModifiersDesktop(target,check);}finally{await context.close();}}
