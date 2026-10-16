// Pixel checks of the actual displayed canvas plus overlay. Fixtures alone use
// the engine; all draft creation, release, acceptance and cancellation use UI.
export async function verifyHeldLayerPreview(page, check) {
  const context = await page.context().browser().newContext({ viewport: page.viewportSize() });
  const target = await context.newPage(), results = [];
  const record = (name, ok, detail) => results.push({ name, ok, detail });
  const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const move = async (x,y) => {
    const bounds = await target.locator('#overlay').boundingBox();
    await target.mouse.move(bounds.x+x,bounds.y+y); await frame();
  };
  const click = async (x,y) => { await move(x,y); await target.mouse.down(); await target.mouse.up(); await frame(); };
  const documentState = () => target.evaluate(() => ({
    layers: paintApp.doc.layers.map(layer => layer.canvas.toDataURL()),
    undo: paintApp.doc._undo.length, dirty: paintApp.doc.dirty,
  }));
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const visible = () => target.evaluate(() => {
    const source = document.querySelector('#canvas'), overlay = document.querySelector('#overlay');
    const surface = document.createElement('canvas'); surface.width = source.width; surface.height = source.height;
    const c = surface.getContext('2d'); c.drawImage(source,0,0); c.drawImage(overlay,0,0);
    const regions = [[65,76,10,8],[45,76,10,8],[104,76,10,8]];
    return { regions: regions.map(rect => [...c.getImageData(...rect).data]),
      interior: [...c.getImageData(25,20,130,130).data],
      foreground: [...c.getImageData(104,35,10,100).data] };
  });
  const everyPixel = (pixels,predicate) => pixels.every((_,i) => i%4 !== 0 || predicate(pixels.slice(i,i+4)));
  const obeysLayers = view => everyPixel(view.regions[0],([r,g,b,a]) => r>240 && g>=185 && g<=205 && b>=185 && b<=205 && a===255) &&
    same(view.regions[0],view.regions[1]) && everyPixel(view.regions[2],pixel => same(pixel,[0,0,255,255]));
  const fixture = async tool => {
    await target.keyboard.press('Escape'); await target.mouse.up();
    await target.evaluate(() => {
      const d=paintApp.doc; d.newDocument(240,180); d.setBackground('#ffffff');
      const active=d.activeLayerId;
      d.begin('Existing pixels on the translucent layer');
      const c=d.activeLayer.canvas.getContext('2d'); c.fillStyle='#00ff00';c.fillRect(40,40,20,100);d.commit();
      d.setLayer(active,{opacity:.25}); d.addLayer('Opaque foreground'); d.begin('Foreground fixture');
      const upper=d.activeLayer.canvas.getContext('2d');upper.fillStyle='#0000ff';upper.fillRect(100,0,20,180);d.commit();
      d.selectLayer(active);d.markSaved();
      Object.assign(paintApp.state,{grid:false,rulers:false,opacity:1});paintApp.setZoom(1);
    }); await frame();
    await target.locator(`[data-tool="${tool}"]`).click();
    await target.locator('[data-color="#ed1c24"]').click();
    await target.locator('[data-color="#ed1c24"]').click({button:'right'});
    await target.locator('#outline').selectOption(tool==='curve'?'solid':'none');
    await target.locator('#shape-fill').selectOption(tool==='curve'?'none':'solid');
    await target.locator('#size-number').fill('12');await target.locator('#size-number').press('Tab');await frame();
    return documentState();
  };
  try {
    await target.goto(page.url()); await target.waitForFunction(() => window.paintApp);
    for (const tool of ['rectangle','curve','polygon']) {
      const before=await fixture(tool);
      if(tool==='polygon') {
        await click(20,30);await click(160,30);await click(160,140);await move(20,140);await target.mouse.down();
      } else {
        await move(20,tool==='curve'?80:30);await target.mouse.down();await move(160,tool==='curve'?80:140);
      }
      await frame();const held=await visible(), heldState=await documentState();
      record(`held ${tool} preview applies layer opacity once and stays behind the foreground`,obeysLayers(held),held.regions.map(region=>region.slice(0,4)));
      await target.mouse.up();await frame();const released=await visible();
      record(`${tool} pointer release preserves the displayed draft pixels away from controls`,same(held.regions,released.regions));
      record(`${tool} held and released previews leave layer pixels and history untouched`,same(before,heldState)&&same(before,await documentState()));
      if(tool==='rectangle')await target.locator('[data-tool="pencil"]').click();
      else await target.keyboard.press('Enter');
      await frame();const committed=await visible(), after=await documentState();
      record(`${tool} acceptance preserves the visible draft pixels`,same(released.regions,committed.regions)&&obeysLayers(committed),committed.regions.map(region=>region.slice(0,4)));
      record(`${tool} acceptance changes only the active layer and records one history entry`,after.undo===before.undo+1&&after.dirty&&after.layers[0]!==before.layers[0]&&after.layers[1]===before.layers[1]);
    }

    await fixture('curve');await move(20,100);await target.mouse.down();await move(160,100);await target.mouse.up();await move(90,20);
    const bent=await visible();await target.keyboard.press('Enter');await frame();const bentCommitted=await visible();
    record('bent curve hover preview and committed display agree across the full interior region',same(bent.interior,bentCommitted.interior));
    record('the foreground occludes the bent curve throughout hover preview',everyPixel(bent.foreground,pixel=>same(pixel,[0,0,255,255])));

    await fixture('rectangle');const clean=await visible(), cleanDocument=await documentState();
    await move(20,30);await target.mouse.down();await move(160,140);await target.keyboard.press('Escape');await target.mouse.up();await frame();
    record('cancelling a held shape removes its composite preview without changing layers or history',same(clean,await visible())&&same(cleanDocument,await documentState()));
  } finally { await context.close(); }
  for(const result of results)check(result.name,result.ok,result.detail);
}

// A compact packaged-renderer check. Build both layers with real UI gestures,
// then undo the owned fixture and restore the caller's fresh blank document.
export async function verifyHeldLayerPreviewDesktop(page,check) {
  const results=[],record=(name,ok)=>results.push({name,ok});
  const frame=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const initial=await page.evaluate(()=>{
    const hex=selector=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=document.querySelector(selector).style.background;c.fillRect(0,0,1,1);return '#'+[...c.getImageData(0,0,1,1).data].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');};
    return {pixels:document.querySelector('#canvas').toDataURL(),width:document.querySelector('#canvas').width,height:document.querySelector('#canvas').height,zoom:document.querySelector('#zoom-presets').value,
      tool:document.querySelector('[data-tool][aria-pressed="true"]')?.dataset.tool,label:document.querySelector('#tool-label').textContent,
      primary:hex('#primary'),secondary:hex('#secondary'),size:document.querySelector('#size-number').value,
      fill:document.querySelector('#shape-fill').value,outline:document.querySelector('#outline').value,
      layers:!document.querySelector('#layers-panel').hidden,opacity:document.querySelector('#opacity').value,
      clean:document.querySelector('[data-action="undo"]').disabled&&document.querySelector('[data-action="redo"]').disabled&&document.title.startsWith('Untitled - ')};
  });
  if(!initial.clean||initial.width!==1152||initial.height!==648||initial.opacity!=='100')throw new Error('Desktop layer-preview checks require a fresh default-size Untitled document and full drawing opacity.');
  if(!await page.locator(`[data-color="${initial.primary}"]`).count()||!await page.locator(`[data-color="${initial.secondary}"]`).count())throw new Error('Desktop layer-preview checks require palette-restorable initial colors.');
  const move=async(x,y)=>{const b=await page.locator('#overlay').boundingBox();await page.mouse.move(b.x+x,b.y+y);await frame();};
  const rectangle=async(x0,y0,x1,y1,color,{hold=false}={})=>{
    await page.locator('[data-tool="rectangle"]').click();await page.locator(`[data-color="${color}"]`).click({button:'right'});
    await move(x0,y0);await page.mouse.down();await move(x1,y1);
    if(!hold){await page.mouse.up();await page.locator('[data-tool="pencil"]').click();await frame();}
  };
  const visible=()=>page.evaluate(()=>{
    const c=document.createElement('canvas');c.width=120;c.height=10;const x=c.getContext('2d');
    for(const id of ['canvas','overlay'])x.drawImage(document.getElementById(id),25,75,120,10,0,0,120,10);
    return {region:[...x.getImageData(0,0,120,10).data],clear:[...x.getImageData(40,3,1,1).data],overlap:[...x.getImageData(20,3,1,1).data],front:[...x.getImageData(80,3,1,1).data]};
  });
  let owned=false;
  try {
    await page.locator('#zoom-presets').selectOption({label:'100%'});await frame();
    await page.locator('#outline').selectOption('none');await page.locator('#shape-fill').selectOption('solid');
    owned=true;await rectangle(40,40,60,140,'#22b14c');
    if(!await page.locator('#layers-panel').isVisible())await page.locator('.layers-group [data-action="layers"]').click();
    const lower=await page.locator('#layer-list [data-layer-select]').getAttribute('data-layer-select');
    await page.locator('#layer-opacity').focus();await page.keyboard.press('Home');
    for(let i=0;i<25;i++)await page.keyboard.press('ArrowRight');
    await frame();if(await page.locator('#layer-opacity').inputValue()!=='25')throw new Error('Could not set fixture layer opacity to 25%.');
    await page.locator('[data-action="add-layer"]').click();await rectangle(100,1,120,179,'#3f48cc');
    await page.locator(`[data-layer-select="${lower}"]`).click();
    const before=await visible();await rectangle(20,30,160,140,'#ed1c24',{hold:true});const held=await visible();
    record('desktop held shape honors 25% layer opacity and opaque foreground occlusion',held.clear[0]>240&&held.clear[1]>=185&&held.clear[1]<=205&&held.clear[2]>=185&&held.clear[2]<=205&&held.clear[3]===255&&JSON.stringify(held.clear)===JSON.stringify(held.overlap)&&held.front.join(',')==='63,72,204,255');
    await page.mouse.up();await frame();const released=await visible();
    record('desktop releasing the shape preserves the displayed layer composite',JSON.stringify(held)===JSON.stringify(released));
    await page.locator('[data-tool="pencil"]').click();await frame();
    record('desktop accepting the shape preserves the displayed layer composite',JSON.stringify(released)===JSON.stringify(await visible()));
    await page.locator('#overlay').focus();await page.keyboard.press('Control+z');await frame();
    record('desktop one Undo removes the accepted preview while preserving its layer fixture',JSON.stringify(before)===JSON.stringify(await visible()));
  } finally {
    await page.keyboard.press('Escape');await page.mouse.up();
    if(owned){
      await page.locator('#overlay').focus();
      for(let i=0;i<64&&await page.locator('[data-action="undo"]').isEnabled();i++){await page.keyboard.press('Control+z');await frame();}
      if(await page.locator('[data-action="undo"]').isEnabled())throw new Error('Layer-preview fixture cleanup exceeded its owned history bound.');
      await page.keyboard.press('Control+n');await frame();
    }
    if(initial.tool)await page.locator(`[data-tool="${initial.tool}"]`).click();
    else{await page.locator('[data-menu="brushes"]').click();await page.getByRole('menuitemradio',{name:initial.label,exact:true}).click();}
    await page.locator(`[data-color="${initial.primary}"]`).click();await page.locator(`[data-color="${initial.secondary}"]`).click({button:'right'});
    await page.locator('#size-number').fill(initial.size);await page.locator('#size-number').press('Tab');
    await page.locator('#outline').selectOption(initial.outline);await page.locator('#shape-fill').selectOption(initial.fill);
    await page.locator('#zoom-presets').selectOption(initial.zoom);
    if(await page.locator('#layers-panel').isVisible()!==initial.layers)await page.locator('.layers-group [data-action="layers"]').click();await frame();
  }
  record('desktop held-preview fixture restores blank pixels and clean history',await page.locator('#canvas').evaluate((canvas,expected)=>canvas.toDataURL()===expected,initial.pixels)&&!await page.locator('[data-action="undo"]').isEnabled()&&!await page.locator('[data-action="redo"]').isEnabled());
  for(const result of results)check(result.name,result.ok);
}
