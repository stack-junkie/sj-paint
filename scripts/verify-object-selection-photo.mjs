import { mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Real model replies are observed by the caller, never supplied by this helper.
// openPhoto may use a native chooser harness or a browser file input; the caller
// must report that transport boundary. All editing actions use public controls.
// The fixed prompt coordinates belong to the retained NASA astronaut fixture;
// callers must verify its provenance/digest before opening it.
export async function verifyObjectSelectionPhoto(page, check, { openPhoto, readCandidate, outputDirectory, capture = options => page.screenshot(options) }) {
  if (!isAbsolute(outputDirectory)) throw new Error('An absolute fresh photo evidence directory is required.');
  await mkdir(outputDirectory);
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  await openPhoto();
  await page.waitForFunction(() => document.querySelector('#canvas').width === 512 && document.querySelector('#canvas').height === 512);
  await page.locator('#zoom-presets').selectOption('1');
  const original = await pixels(), panel = page.getByRole('dialog', { name:'Object select', exact:true });
  const savePng = (name, png) => writeFile(join(outputDirectory,name),Buffer.from(png.split(',')[1],'base64'),{flag:'wx'});
  const waitMask = async () => {
    await page.waitForFunction(() => {
      const panel=document.querySelector('.object-selection-dialog');return panel&&(!panel.querySelector('[type="submit"]').disabled||panel.querySelector('fieldset').disabled||/No object was found/.test(panel.querySelector('[role="status"]').textContent));
    },null,{timeout:60000});
    if(await panel.getByRole('button',{name:'Apply',exact:true}).isDisabled())throw new Error(await panel.getByRole('status').textContent());
  };
  try {
    await page.locator('[data-menu="ai"]').click();await page.locator('#menu [data-command="object-select"]').click();
    await page.waitForFunction(()=>{const el=document.querySelector('.object-selection-dialog fieldset');return el&&!el.disabled;},null,{timeout:60000});
    await panel.getByLabel('Prompt type').selectOption('box');
    for(const [label,value] of [['Box left',14],['Box top',15],['Box right',369],['Box bottom',511]])await panel.getByLabel(label,{exact:true}).fill(String(value));
    await panel.getByRole('button',{name:'Set box',exact:true}).click();await waitMask();
    await panel.getByLabel('Prompt type').selectOption('point');
    for(const [x,y] of [[225,125],[224,224],[246,390]]){
      await panel.getByLabel('Point X',{exact:true}).fill(String(x));await panel.getByLabel('Point Y',{exact:true}).fill(String(y));
      await panel.getByRole('button',{name:'Add point',exact:true}).click();await waitMask();
    }
    const observed=await readCandidate();
    check('real photo decoder retains the three alternatives for the exact public box and Include prompts',
      observed.request.prompts.box.x1===14&&observed.request.prompts.box.y1===15&&observed.request.prompts.box.x2===369&&observed.request.prompts.box.y2===511&&
      JSON.stringify(observed.request.prompts.points.map(({x,y})=>[x,y]))===JSON.stringify([[225,125],[224,224],[246,390]])&&observed.request.prompts.points.every(point=>point.label===1)&&
      observed.candidates.length===3&&observed.candidates.every(candidate=>candidate.length===512*512)&&observed.selectedCandidate===1,
      {prompts:observed.request.prompts,scores:observed.scores,selectedCandidate:observed.selectedCandidate});
    const masks=[];
    for(let index=0;index<observed.candidates.length;index++){
      const bytes=Buffer.from(observed.candidates[index]),name=`candidate-${index}.mask`;
      await writeFile(join(outputDirectory,name),bytes,{flag:'wx'});
      masks.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    await writeFile(join(outputDirectory,'actual-decoder-reply.json'),JSON.stringify({request:observed.request,metadata:observed.metadata,scores:observed.scores,selectedCandidate:observed.selectedCandidate,masks},null,2),{flag:'wx'});
    await savePng('default-overlay.png',await page.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL()));
    await capture({path:join(outputDirectory,'default-preview.png')});
    await panel.getByLabel('Selection preview',{exact:true}).selectOption('2');
    const alternativeOverlay=await page.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL());
    await savePng('alternative-overlay.png',alternativeOverlay);await capture({path:join(outputDirectory,'alternative-preview.png')});
    const afterChoice=await readCandidate();
    check('real fuller photo alternative is preview-only and reuses the decoded result',await pixels()===original&&
      observed.id===afterChoice.id&&await page.locator('[data-action="undo"]').isDisabled());
    await panel.getByRole('button',{name:'Apply',exact:true}).click();await panel.waitFor({state:'detached',timeout:60000});
    await key('Delete');
    const deleted=await pixels();await savePng('chosen-mask-deleted.png',deleted);
    const comparison=await page.evaluate(async({original,deleted,encodedMask})=>{
      const mask=Uint8Array.from(atob(encodedMask),character=>character.charCodeAt(0));
      const decode=async url=>{const image=new Image();image.src=url;await image.decode();const canvas=Object.assign(document.createElement('canvas'),{width:image.width,height:image.height}),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,image.width,image.height).data;};
      const a=await decode(original),b=await decode(deleted);let outsideChanged=0,selectedNotCleared=0,selected=0;
      for(let index=0;index<mask.length;index++){if(mask[index]){selected++;if(b[index*4+3]!==0)selectedNotCleared++;}else if(!a.subarray(index*4,index*4+4).every((value,channel)=>value===b[index*4+channel]))outsideChanged++;}
      return {selected,outsideChanged,selectedNotCleared};
    },{original,deleted,encodedMask:Buffer.from(observed.candidates[2]).toString('base64')});
    check('real photo Apply uses exactly the chosen fuller mask and preserves all outside pixels',comparison.selected>0&&comparison.outsideChanged===0&&comparison.selectedNotCleared===0,comparison);
    await key('Control+z');
    check('one Undo restores exact real-photo source and saved history',await pixels()===original&&await page.locator('[data-action="undo"]').isDisabled());
    const final=await page.evaluate(()=>window.paintDesktop.localAiStatus());
    check('real photo selection releases its worker and retained embedding after Apply',final.ok&&!final.value.active&&!final.value.ownsProcess&&!final.value.retainedSelection&&!final.value.cleanupBlocked,final);
    await writeFile(join(outputDirectory,'journey.json'),JSON.stringify({prompts:observed.request.prompts,scores:observed.scores,defaultCandidate:observed.selectedCandidate,chosenCandidate:2,comparison},null,2),{flag:'wx'});
  } catch(error) {
    await writeFile(join(outputDirectory,'failure.json'),JSON.stringify({error:error.stack,status:await panel.getByRole('status').textContent().catch(()=>null)},null,2),{flag:'wx'});
    await capture({path:join(outputDirectory,'failure.png')}).catch(()=>{});
    throw error;
  } finally {
    if(await panel.count()){await panel.getByRole('button',{name:'Cancel',exact:true}).click();await panel.waitFor({state:'detached',timeout:60000});}
  }
}
