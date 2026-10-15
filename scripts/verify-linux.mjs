import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output=new URL('../output/',import.meta.url);
const nodeInfo=await (await fetch('http://127.0.0.1:9231/json/list')).json();
const socket=new WebSocket(nodeInfo[0].webSocketDebuggerUrl.replace('0.0.0.0','127.0.0.1'));
await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});let sequence=0;const pending=new Map();
socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const q=pending.get(m.id);pending.delete(m.id);if(m.error)q.reject(new Error(JSON.stringify(m.error)));else q.resolve(m.result);}};
const main=async(expression)=>{const id=++sequence;const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
const version=await main("({platform:process.platform,arch:process.arch,electron:process.versions.electron})");
await main("globalThis.qaElectron=process.mainModule.require('electron');globalThis.qaFs=process.mainModule.require('node:fs');globalThis.qaSavePath='/tmp/verification.linuxpaint';qaFs.writeFileSync(qaSavePath,'previous project fixture');qaElectron.dialog.showSaveDialog=async()=>({canceled:false,filePath:qaSavePath});qaElectron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[qaSavePath]});qaElectron.dialog.showMessageBox=async()=>({response:1});'ready'");
const browser=await chromium.connectOverCDP('http://127.0.0.1:9229');const page=browser.contexts()[0].pages()[0];const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=(name,ok,detail)=>{checks.push({name,ok,detail});if(!ok)throw new Error(name+': '+JSON.stringify(detail));};
try{
 await page.reload();await page.waitForSelector('#overlay');check('packaged Linux renderer loaded',await page.title()==='Untitled - Paint for Linux',await page.title());
 check('isolated preload bridge',await page.evaluate(()=>!!window.paintDesktop&&typeof require==='undefined'&&typeof process==='undefined'),null);
 const r=await page.locator('#overlay').boundingBox();await page.mouse.move(r.x+70,r.y+90);await page.mouse.down();await page.mouse.move(r.x+250,r.y+180,{steps:20});await page.mouse.up();
 const painted=await page.locator('#canvas').evaluate(c=>c.toDataURL());
 await page.getByRole('button',{name:'Undo (Ctrl+Z)',exact:true}).click();check('Linux undo changes pixels',painted!==await page.locator('#canvas').evaluate(c=>c.toDataURL()),null);
 await page.getByRole('button',{name:'Redo (Ctrl+Y)',exact:true}).click();
 await page.getByRole('button',{name:'Layers',exact:true}).click();await page.getByRole('button',{name:'Add layer',exact:true}).click();
 await page.getByRole('button',{name:'Text',exact:true}).click();const rr=await page.locator('#overlay').boundingBox();await page.mouse.click(rr.x+70,rr.y+210);await page.getByRole('textbox',{name:'Text on canvas'}).fill('Paint on Linux');await page.getByRole('button',{name:'Apply text',exact:true}).click();
 await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('[data-command="save-project"]').click();await page.waitForFunction(()=>!document.title.includes('â€¢'));
 const project=await main("JSON.parse(qaFs.readFileSync('/tmp/verification.linuxpaint','utf8'))");check('native IPC saves layered project on Linux',project.format==='paint-linux'&&project.layers.length===2,project.layers.length);
 const beforeReload=await page.locator('#canvas').evaluate(c=>c.toDataURL());
 await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('[data-command="new"]').click();
 await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('[data-command="open-project"]').click();await page.waitForFunction(()=>document.querySelector('#title').textContent.startsWith('verification'));
 check('native project reopen restores pixels',beforeReload===await page.locator('#canvas').evaluate(c=>c.toDataURL()),null);
 await main("qaFs.writeFileSync('/tmp/verification.png','previous image fixture')");
 for(const format of ['png','jpeg','bmp','webp','gif','tiff']){
   await main(`qaSavePath='/tmp/verification.${format}'`);
   await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('[data-command="save-as"]').click();await page.locator('select[name="format"]').selectOption(format);await page.locator('#dialog button[type="submit"]').click();
   let size=0;for(let n=0;n<50&&size<=50;n++){size=await main(`qaFs.existsSync(qaSavePath)?qaFs.statSync(qaSavePath).size:0`);if(size<=50)await new Promise(r=>setTimeout(r,100));}
   check(`native ${format} export`,size>50,size);
 }
 await page.screenshot({path:fileURLToPath(new URL('paint-linux-runtime.png',output))});
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-command="copy-all"]').click();
 await page.waitForFunction(()=>document.querySelector('#toast').textContent==='Copied visible layers.');
 await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('[data-command="new"]').click();
 await page.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('[data-command="paste"]').click();await page.waitForFunction(()=>document.querySelector('#selection-size').textContent.length>0);
 check('Linux clipboard copies visible layers and pastes image',beforeReload===await page.locator('#canvas').evaluate(c=>c.toDataURL()),null);
 await main("qaSavePath='/tmp/verification.png'");await page.getByRole('button',{name:'File',exact:true}).click();await page.locator('[data-command="open"]').click();await page.waitForFunction(()=>document.querySelector('#title').textContent.startsWith('verification')&&!document.title.includes('•'));
 check('native PNG reopen restores exported pixels',beforeReload===await page.locator('#canvas').evaluate(c=>c.toDataURL()),null);
 check('no renderer errors',errors.length===0,errors);
}catch(e){checks.push({name:'failure',ok:false,detail:e.stack});process.exitCode=1;}
finally{await fs.writeFile(new URL('linux-verification.json',output),JSON.stringify({timestamp:new Date().toISOString(),version,environment:'Ubuntu 22.04 Xvfb container, no-sandbox only for root container testing',dialogBoundary:'Native file chooser responses controlled through test-only main-process inspector; real preload IPC, filesystem, encoding and decoding used',checks,errors},null,2));console.log(JSON.stringify({version,passed:checks.filter(c=>c.ok).length,failed:checks.filter(c=>!c.ok),errors}));await browser.close();socket.close();}
