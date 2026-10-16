// Caller owns a hidden packaged instance, configured existing runtime/model,
// and a pristine default Untitled document. No launch, private engine, clipboard,
// file fixture, native chooser or main-process inspector is used here.
export async function verifyLocalAiDesktop(page, check) {
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const snapshot = () => page.evaluate(() => {
    const canvas = document.querySelector('#canvas'), context = canvas.getContext('2d');
    return { pixels: canvas.toDataURL(), center: [...context.getImageData(canvas.width/2,canvas.height/2,1,1).data],
      corner: [...context.getImageData(10,10,1,1).data], title: document.title,
      undo: !document.querySelector('[data-action="undo"]').disabled, redo: !document.querySelector('[data-action="redo"]').disabled };
  });
  const initial = await page.evaluate(() => ({
    clean: document.title === 'Untitled - Stack Junkie Paint' && document.querySelector('#canvas').width === 1152 &&
      document.querySelector('#canvas').height === 648 && document.querySelector('[data-action="undo"]').disabled &&
      document.querySelector('[data-action="redo"]').disabled && !document.querySelector('.text-editor') &&
      !document.querySelector('dialog[open]') && document.querySelector('#opacity').value === '100' &&
      getComputedStyle(document.querySelector('#primary')).backgroundColor === 'rgb(0, 0, 0)' &&
      getComputedStyle(document.querySelector('#secondary')).backgroundColor === 'rgb(255, 255, 255)',
    tool: document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,
    label: document.querySelector('#tool-label').textContent, size: document.querySelector('#size-number').value,
    zoom: document.querySelector('#zoom-presets').value,
    scroll: [document.querySelector('#viewport').scrollLeft,document.querySelector('#viewport').scrollTop],
  }));
  if (!initial.clean) throw new Error('Local AI checks require a pristine default Untitled document, default colors and full opacity.');
  const state = await page.evaluate(() => window.paintDesktop?.localAiStatus?.());
  check('packaged local AI is configured and idle', state?.ok && state.value.configured && state.value.state === 'idle' && state.value.active === null, state);
  check('packaged local AI advertises bounded inputs and the pinned model', state.value.bounds.maxPixels === 16_000_000 &&
    state.value.bounds.maxPngBytes === 64*1024*1024 && state.value.model.sha256 === '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8', state.value);
  const blank = await snapshot();
  let owned = false;
  let previewRaster = null;
  const clickCanvas = async (x,y) => {
    const box = await page.locator('#overlay').boundingBox();
    await page.mouse.move(box.x+x*box.width/1152,box.y+y*box.height/648);
    await page.mouse.down(); await page.mouse.up(); await frame();
  };
  const undo = async () => { await page.getByRole('button',{name:'Undo (Ctrl+Z)',exact:true}).click(); await frame(); };
  const redo = async () => { await page.getByRole('button',{name:'Redo (Ctrl+Y)',exact:true}).click(); await frame(); };
  const openPreview = async () => {
    await page.getByRole('button',{name:'Remove background',exact:true}).click();
    await page.locator('.background-removal-dialog').waitFor({state:'visible'});
    await page.waitForFunction(() => {
      const panel=document.querySelector('.background-removal-dialog');
      return !panel || !panel.querySelector('[type="submit"]').disabled;
    },null,{timeout:45_000});
    const preview=page.locator('.background-removal-dialog canvas[aria-label="Background removal preview"]');
    check('packaged real inference produces an explicit background-removal preview',await preview.count()===1);
    await previewRaster?.dispose();
    previewRaster=await preview.evaluateHandle(canvas=>({png:canvas.toDataURL(),width:canvas.width,height:canvas.height,
      rgba:canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,
      attributes:canvas.getContext('2d').getContextAttributes()}));
    return preview.evaluate(canvas=>({pixels:canvas.toDataURL(),width:canvas.width,height:canvas.height}));
  };
  try {
    const probe=await page.evaluate(()=>window.paintDesktop.localAiProbe({id:crypto.randomUUID()}));
    check('packaged probe loads the actual approved CPU model',probe?.ok && probe.value.modelSha256===state.value.model.sha256 && probe.value.provider==='CPUExecutionProvider',probe);
    const invalid=await page.evaluate(()=>window.paintDesktop.localAiProbe({id:'x'.repeat(81)}));
    check('packaged bridge rejects an oversized operation ID',!invalid.ok && invalid.error.code==='INPUT',invalid);
    const oversized=await page.evaluate(async()=>{
      const result=await window.paintDesktop.localAiRun({id:crypto.randomUUID(),png:new Uint8Array(64*1024*1024+1),width:1,height:1});
      return {result,status:await window.paintDesktop.localAiStatus()};
    });
    check('packaged bridge rejects an oversized PNG payload and releases its operation',!oversized.result.ok && oversized.result.error.code==='INPUT' && oversized.status.ok && oversized.status.value.active===null,oversized);

    await page.locator('#zoom-presets').selectOption('.5'); await frame();
    await page.locator('#viewport').evaluate(el=>{el.scrollLeft=0;el.scrollTop=0;});
    owned=true;
    await page.locator('#overlay').focus(); await page.keyboard.press('Control+Shift+h'); await frame();
    check('fixture exposes transparency through the public shortcut',(await snapshot()).corner[3]===0);
    await page.locator('[data-tool="fill"]').click(); await page.locator('[data-color="#ffffff"]').click();
    await clickCanvas(10,10); const filled=await snapshot();
    check('fixture paints opaque background on the active layer',filled.corner.join(',')==='255,255,255,255');
    await page.getByRole('button',{name:'Brushes',exact:true}).click();
    await page.getByRole('menuitemradio',{name:'Brush',exact:true}).click();
    await page.locator('[data-color="#ed1c24"]').click();
    await page.locator('#size-number').fill('200'); await page.locator('#size-number').press('Tab');
    await clickCanvas(576,324); const source=await snapshot();
    check('fixture draws a red subject through the public brush',source.center[0]>200 && source.center[1]<60 && source.center[3]===255 && source.pixels!==filled.pixels);
    const cancellation=await page.evaluate(async()=>{
      const canvas=document.querySelector('#canvas');
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const id=crypto.randomUUID();
      const pending=window.paintDesktop.localAiRun({id,png:new Uint8Array(await blob.arrayBuffer()),width:canvas.width,height:canvas.height});
      let observed=false;
      try{
        for(let attempt=0;attempt<100;attempt++){
          const status=await window.paintDesktop.localAiStatus();
          if(status.ok && status.value.active?.id===id){observed=true;break;}
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        const wrong=await window.paintDesktop.localAiCancel({id:crypto.randomUUID()});
        const cancelled=await window.paintDesktop.localAiCancel({id});
        return {observed,wrong,cancelled,result:await pending,status:await window.paintDesktop.localAiStatus()};
      }finally{
        const status=await window.paintDesktop.localAiStatus();
        if(status.ok && status.value.active?.id===id)await window.paintDesktop.localAiCancel({id});
        await pending;
      }
    });
    check('packaged bridge cancels only its matching actual worker operation',cancellation.observed &&
      !cancellation.wrong.ok && cancellation.wrong.error.code==='NOT_FOUND' && cancellation.cancelled.ok &&
      !cancellation.result.ok && cancellation.result.error.code==='ABORTED' && cancellation.status.ok && cancellation.status.value.active===null,cancellation);
    check('bridge inference cancellation leaves pixels and public history unchanged',JSON.stringify(await snapshot())===JSON.stringify(source));

    const cancelledPreview=await openPreview();
    check('preview preserves dimensions and does not commit pixels',cancelledPreview.width===1152 && cancelledPreview.height===648 && (await snapshot()).pixels===source.pixels);
    await page.locator('.background-removal-dialog').getByRole('button',{name:'Cancel',exact:true}).click();
    await page.locator('.background-removal-dialog').waitFor({state:'detached'});await frame();
    check('cancelling completed preview leaves pixels and history buttons unchanged',JSON.stringify(await snapshot())===JSON.stringify(source));
    await undo();
    check('preview cancellation adds no history entry before the brush stroke',(await snapshot()).pixels===filled.pixels);
    await redo();
    check('redo after preview cancellation restores the brush fixture exactly',(await snapshot()).pixels===source.pixels);

    const acceptedPreview=await openPreview();
    await page.locator('.background-removal-dialog').getByRole('button',{name:'Apply',exact:true}).click();
    await page.locator('.background-removal-dialog').waitFor({state:'detached'});await frame();
    const applied=await snapshot();
    const previewDifference=await previewRaster.evaluate(expected=>{
      const canvas=document.querySelector('#canvas'),context=canvas.getContext('2d');
      const actual=context.getImageData(0,0,canvas.width,canvas.height).data;
      const channelCounts=[0,0,0,0],maxAbsoluteDifference=[0,0,0,0],samples=[];let differingPixels=0;
      for(let offset=0;offset<actual.length;offset+=4){
        let different=false;
        for(let channel=0;channel<4;channel++){
          const difference=Math.abs(actual[offset+channel]-expected.rgba[offset+channel]);
          if(difference){different=true;channelCounts[channel]++;maxAbsoluteDifference[channel]=Math.max(maxAbsoluteDifference[channel],difference);}
        }
        if(different){differingPixels++;if(samples.length<12)samples.push({x:offset/4%canvas.width,y:Math.floor(offset/4/canvas.width),
          expected:[...expected.rgba.slice(offset,offset+4)],actual:[...actual.slice(offset,offset+4)]});}
      }
      const chunks=png=>{
        const bytes=Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),result=[];
        for(let offset=8;offset+12<=bytes.length;){const length=view.getUint32(offset),type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
          result.push({type,length,crc:view.getUint32(offset+8+length)});offset+=length+12;}
        return result;
      };
      const actualPng=canvas.toDataURL();
      return {width:canvas.width,height:canvas.height,expectedWidth:expected.width,expectedHeight:expected.height,
        differingPixels,channelCounts,maxAbsoluteDifference,samples,pngEqual:expected.png===actualPng,
        expectedChunks:chunks(expected.png),actualChunks:chunks(actualPng),
        expectedContext:expected.attributes,actualContext:context.getContextAttributes()};
    });
    check('Apply commits the real preview and removes background while retaining the subject',applied.pixels===acceptedPreview.pixels &&
      applied.pixels!==source.pixels && applied.corner[3]<20 && applied.center[3]>240,{corner:applied.corner,center:applied.center,previewDifference});
    await undo();check('one Undo restores the exact pre-inference drawing',(await snapshot()).pixels===source.pixels);
    await redo();check('one Redo restores the exact applied mask',(await snapshot()).pixels===applied.pixels);
  } finally {
    await previewRaster?.dispose();
    const panel=page.locator('.background-removal-dialog');
    if(await panel.count()){
      await panel.getByRole('button',{name:'Cancel',exact:true}).click();
      await panel.waitFor({state:'detached',timeout:45_000});
    }
    await page.mouse.up(); await page.locator('#overlay').focus(); await page.keyboard.press('Escape');
    if(owned){
      for(let i=0;i<8 && await page.locator('[data-action="undo"]').isEnabled();i++){await page.keyboard.press('Control+z');await frame();}
      if(await page.locator('[data-action="undo"]').isEnabled())throw new Error('Local AI fixture exceeded its owned cleanup history bound.');
      // Undo to the saved origin avoids a discard dialog; New clears owned redo.
      await page.keyboard.press('Control+n');await frame();
    }
    if(initial.tool)await page.locator('[data-tool="'+initial.tool+'"]').click();
    else{await page.getByRole('button',{name:'Brushes',exact:true}).click();await page.getByRole('menuitemradio',{name:initial.label,exact:true}).click();}
    await page.locator('[data-color="#000000"]').click();await page.locator('[data-color="#ffffff"]').click({button:'right'});
    await page.locator('#size-number').fill(initial.size);await page.locator('#size-number').press('Tab');
    await page.locator('#zoom-presets').selectOption(initial.zoom);await frame();
    await page.locator('#viewport').evaluate((el,scroll)=>{[el.scrollLeft,el.scrollTop]=scroll;},initial.scroll);
  }
  const restored=await snapshot();
  check('local AI desktop fixture restores blank pixels and empty history',restored.pixels===blank.pixels && !restored.undo && !restored.redo && restored.title===blank.title);
}
