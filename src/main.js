import './style.css';
import PROJECT from './project-format.json' with { type: 'json' };
import { VERSION } from './version.js';
import { bindCanvasResize } from './canvas-resize.js';
import { PaintDocument } from './engine.js';
import { drawShape } from './shapes.js';
import { createPendingShape, paintPendingShape, hitPendingShape, transformPendingShape } from './pending-shape.js';
import { createStroke, BRUSHES } from './brushes.js';
import { createEraserStroke, eraserFootprint } from './eraser.js';
import { layoutTextEditor } from './text-layout.js';
import { icon, SHAPES } from './icons.js';
import { openImageFile, saveImageFile, openProjectFile, saveProjectFile, savePaintFile, isProjectFile, readImageFile, readProjectFile, copyCanvas, pasteImage, printCanvas } from './files.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = (s) => s.replaceAll('-',' ').replace(/^./,c=>c.toUpperCase());
const doc = new PaintDocument(1152,648);
const state = {tool:'brush',brush:'brush',primary:'#000000',secondary:'#ffffff',size:5,opacity:1,tolerance:0,zoom:1,outline:'solid',fillStyle:'none',layers:false,grid:false,rulers:false,name:'Untitled',format:'png',project:false,transparentSelection:false,font:'Arial',fontSize:24,bold:false,italic:false,underline:false,textBackground:false,align:'left',theme:localStorage.getItem('paint-theme')||'dark',lastBrushSize:5,eraserSize:8};
let drag=null,stroke=null,shapePreview=null,pendingShape=null,curve=null,polygon=[],textEditor=null,raf=0,toastTimer,menuAnchor=null,activePointerId=null,hoverClient=null;
const colors=['#000000','#7f7f7f','#880015','#ed1c24','#ff7f27','#fff200','#22b14c','#00a2e8','#3f48cc','#a349a4','#ffffff','#c3c3c3','#b97a57','#ffaec9','#ffc90e','#efe4b0','#b5e61d','#99d9ea','#7092be','#c8bfe7'];
let customColors=[];try{const saved=JSON.parse(localStorage.getItem('paint-colors')||'[]');if(Array.isArray(saved))customColors=saved.filter(c=>typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c)).slice(0,10);}catch{}
const btn=(id,title,img=id,extra='')=>`<button type="button" data-action="${id}" title="${title}" aria-label="${title}" ${extra}>${icon(img)}</button>`;
const toolBtn=(id,title,img=id)=>`<button type="button" data-tool="${id}" title="${title}" aria-label="${title}">${icon(img)}</button>`;

$('#app').innerHTML=`
  <header class="titlebar"><span class="appmark">${icon('palette',16)}</span><span id="title">Untitled - ${PROJECT.productName}</span><span class="title-spacer"></span><span class="platform-label">${PROJECT.shortName}</span></header>
  <nav class="menubar" aria-label="Main menu"><button data-menu="file">File</button><button data-menu="edit">Edit</button><button data-menu="view">View</button><span class="divider"></span>${btn('save','Save (Ctrl+S)','save')}${btn('undo','Undo (Ctrl+Z)')}${btn('redo','Redo (Ctrl+Y)')}<span class="grow"></span>${btn('settings','Settings')}</nav>
  <section class="toolbar" aria-label="Drawing tools">
    <div class="toolgroup selection-group"><div class="group-content"><div class="split"><button data-tool="select" class="large" title="Rectangular selection" aria-label="Rectangular selection">${icon('select',26)}</button><button data-menu="selection" class="split-arrow" title="Selection options" aria-label="Selection options">⌄</button></div></div><span class="group-label">Selection</span></div>
    <div class="toolgroup image-group"><div class="group-content image-tools">${btn('crop','Crop','crop')}${btn('rotate-menu','Rotate','rotate')}${btn('flip-menu','Flip','flip')}${btn('resize','Resize and skew','resize')}</div><span class="group-label">Image</span></div>
    <div class="toolgroup"><div class="group-content tool-grid">${toolBtn('pencil','Pencil')}${toolBtn('fill','Fill with color')}${toolBtn('text','Text')}${toolBtn('eraser','Eraser')}${toolBtn('picker','Color picker')}${toolBtn('zoom','Magnifier')}</div><span class="group-label">Tools</span></div>
    <div class="toolgroup brush-group"><div class="group-content"><button class="large brush-selector" data-menu="brushes" title="Brushes" aria-label="Brushes">${icon('brush',30)}<span>⌄</span></button></div><span class="group-label">Brushes</span></div>
    <div class="toolgroup shapes-group"><div class="group-content shapes-content"><div class="shape-grid">${SHAPES.map(s=>toolBtn(s,label(s))).join('')}</div><div class="shape-settings"><label title="Shape outline">${icon('pencil',15)}<select id="outline" aria-label="Shape outline"><option value="solid">Solid outline</option><option value="crayon">Crayon</option><option value="marker">Marker</option><option value="oil">Oil</option><option value="natural-pencil">Natural pencil</option><option value="watercolor">Watercolor</option><option value="none">No outline</option></select></label><label title="Shape fill">${icon('fill',15)}<select id="shape-fill" aria-label="Shape fill"><option value="none">No fill</option><option value="solid">Solid fill</option><option value="crayon">Crayon</option><option value="marker">Marker</option><option value="oil">Oil</option><option value="natural-pencil">Natural pencil</option><option value="watercolor">Watercolor</option></select></label></div></div><span class="group-label">Shapes</span></div>
    <div class="toolgroup colors-group"><div class="group-content"><div class="primary-colors"><button id="primary" data-action="primary" title="Color 1" aria-label="Color 1"></button><button id="secondary" data-action="secondary" title="Color 2" aria-label="Color 2"></button></div><div><div class="palette">${colors.map(c=>`<button data-color="${c}" style="--swatch:${c}" title="${c}" aria-label="Color ${c}"></button>`).join('')}</div><div class="custom-palette" id="custom-colors"></div></div><button data-action="colors" class="color-wheel" title="Edit colors" aria-label="Edit colors"></button></div><span class="group-label">Colors</span></div>
    <div class="toolgroup layers-group"><div class="group-content">${btn('layers','Layers','layers','class="large"')}</div><span class="group-label">Layers</span></div>
    <button class="collapse-tools" data-action="collapse" title="Collapse toolbar" aria-label="Collapse toolbar">⌃</button>
  </section>
  <div class="contextbar"><span id="tool-label">Brush</span><label>Size <input id="size" type="range" min="1" max="500" value="5"><input id="size-number" type="number" min="1" max="500" value="5" aria-label="Size in pixels"><span>px</span></label><label id="opacity-control">Opacity <input id="opacity" type="range" min="1" max="100" value="100"><output id="opacity-value">100%</output></label><label id="tolerance-control" hidden>Tolerance <input id="tolerance" type="range" min="0" max="100" value="0"><output id="tolerance-value">0%</output></label><div id="text-controls" hidden><select id="font" aria-label="Font"><option>Arial</option><option>Verdana</option><option>Georgia</option><option>Times New Roman</option><option>Courier New</option><option>Trebuchet MS</option><option>serif</option><option>sans-serif</option><option>monospace</option></select><input id="font-size" type="number" min="6" max="500" value="24" aria-label="Font size"><button data-action="bold" title="Bold"><b>B</b></button><button data-action="italic" title="Italic"><i>I</i></button><button data-action="underline" title="Underline"><u>U</u></button><select id="text-align" aria-label="Text alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select><label><input id="text-background" type="checkbox">Opaque</label>${btn('commit-text','Apply text','check')}</div></div>
  <main class="workspace"><div class="viewport" id="viewport"><div class="canvas-stage" id="stage"><canvas id="canvas" aria-label="Drawing canvas"></canvas><canvas id="overlay" aria-label="Drawing interaction surface" tabindex="0"></canvas><div id="canvas-resize-preview" aria-hidden="true" hidden></div>${['nw','n','ne','w','e','sw','s','se'].map(edge=>`<div class="resize-handle" data-handle="${edge}" title="Resize canvas" aria-label="Resize canvas ${edge}"></div>`).join('')}</div></div><aside class="layers-panel" id="layers-panel" hidden><div class="panel-title"><strong>Layers</strong>${btn('layers','Close layers','close')}</div><div class="layer-actions">${btn('add-layer','Add layer','plus')}${btn('duplicate-layer','Duplicate layer','duplicate')}${btn('merge-layer','Merge down','merge')}${btn('delete-layer','Delete layer','trash')}</div><div id="layer-list"></div><div class="layer-controls">${btn('layer-up','Move layer up','up')}${btn('layer-down','Move layer down','down')}<label>Opacity <input type="range" min="0" max="100" id="layer-opacity" value="100"></label></div><button class="background-control" data-action="background"><span id="background-swatch"></span><span>Background</span></button></aside></main>
  <footer class="statusbar"><span id="coordinates">${icon('pencil',14)}<span>Ready</span></span><span id="selection-size"></span><span id="dimensions"></span><span id="document-state"></span><span class="grow"></span>${btn('fit','Fit to window','fit')}<select id="zoom-presets" aria-label="Zoom"><option value=".125">12.5%</option><option value=".25">25%</option><option value=".5">50%</option><option value=".75">75%</option><option value="1" selected>100%</option><option value="1.5">150%</option><option value="2">200%</option><option value="4">400%</option><option value="8">800%</option></select>${btn('zoom-out','Zoom out','minus')}<input id="zoom-slider" type="range" min="-3" max="3" step=".05" value="0" aria-label="Zoom slider">${btn('zoom-in','Zoom in','plus')}</footer>
  <div id="menu" class="menu" hidden></div><div id="toast" role="status" hidden></div><dialog id="dialog"></dialog>`;
const canvas=$('#canvas'),overlay=$('#overlay'),viewport=$('#viewport'),stage=$('#stage'),ctx=canvas.getContext('2d'),oc=overlay.getContext('2d');
const selectionRotation=document.createElement('button');
selectionRotation.id='selection-rotation';selectionRotation.type='button';selectionRotation.title='Rotate selection';selectionRotation.setAttribute('aria-label','Rotate selection');selectionRotation.innerHTML=icon('rotate',12);selectionRotation.hidden=true;stage.append(selectionRotation);
const eraserCursor=document.createElement('div');
eraserCursor.id='eraser-cursor';eraserCursor.hidden=true;eraserCursor.setAttribute('aria-hidden','true');stage.append(eraserCursor);
function renderEraserCursor(){
  const rect=overlay.getBoundingClientRect(), visible=viewport.getBoundingClientRect();
  const inside=hoverClient&&hoverClient[0]>=Math.max(rect.left,visible.left)&&hoverClient[0]<Math.min(rect.right,visible.right)&&hoverClient[1]>=Math.max(rect.top,visible.top)&&hoverClient[1]<Math.min(rect.bottom,visible.bottom);
  const footprint=state.tool==='eraser'&&inside&&drag?.kind!=='pan'?eraserFootprint((hoverClient[0]-rect.left)/state.zoom,(hoverClient[1]-rect.top)/state.zoom,state.size):null;
  eraserCursor.hidden=!footprint;
  if(footprint)Object.assign(eraserCursor.style,{left:`${footprint.x*state.zoom}px`,top:`${footprint.y*state.zoom}px`,width:`${footprint.width*state.zoom}px`,height:`${footprint.height*state.zoom}px`});
}
document.documentElement.dataset.theme=state.theme;

function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function safe(fn){return async(...args)=>{try{return await fn(...args);}catch(e){console.error(e);toast(e.message||String(e));}};}
function changed(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;render();});}
doc.addEventListener('change',changed);doc.addEventListener('preview',changed);
function render(){
  if(canvas.width!==doc.width||canvas.height!==doc.height){canvas.width=overlay.width=doc.width;canvas.height=overlay.height=doc.height;}
  const hasDraft=shapePreview||pendingShape||curve||polygon.length;
  doc.renderTo(ctx,{layerPreview:hasDraft?{layerId:doc.activeLayerId,paint:paintDrawingDraft}:null});
  stage.style.width=`${doc.width*state.zoom}px`;stage.style.height=`${doc.height*state.zoom}px`;
  for(const c of [canvas,overlay]){c.style.width=`${doc.width*state.zoom}px`;c.style.height=`${doc.height*state.zoom}px`;}
  stage.classList.toggle('pixelated',state.zoom>=3);
  renderOverlay();
  const dirty=doc.dirty||pendingShape?' •':'';const title=`${state.name}${dirty} - ${PROJECT.productName}`;
  $('#title').textContent=title;document.title=title;window.paintDesktop?.setTitle(title);
  const size=canvasResize.candidate||doc;$('#dimensions').textContent=`${size.width} × ${size.height}px`;
  $('#document-state').textContent=doc.dirty||pendingShape?'Unsaved changes':'';
  const geometry=doc.getSelectionGeometry({zoom:state.zoom});
  const selection=drag?.kind==='select'?box(drag.start,drag.current):pendingShape?box(pendingShape.start,pendingShape.end):geometry?{width:geometry.frameWidth,height:geometry.frameHeight}:null;
  $('#selection-size').textContent=selection?`${Math.round(selection.width)} × ${Math.round(selection.height)}px`:'';
  selectionRotation.hidden=!geometry;
  if(geometry){selectionRotation.style.left=`${geometry.rotationHandle[0]*state.zoom}px`;selectionRotation.style.top=`${geometry.rotationHandle[1]*state.zoom}px`;}
  $('[data-action="undo"]').disabled=!doc.canUndo&&!pendingShape;$('[data-action="redo"]').disabled=!doc.canRedo;$('[data-action="crop"]').disabled=!doc.selection;
  if(state.layers)renderLayers();updateToolState();
}
function renderOverlay(){
  oc.clearRect(0,0,overlay.width,overlay.height);
  if(state.grid&&state.zoom>=4){oc.save();oc.strokeStyle='rgba(127,127,127,.35)';oc.lineWidth=1/state.zoom;oc.beginPath();for(let x=0;x<=doc.width;x++) {oc.moveTo(x,0);oc.lineTo(x,doc.height);}for(let y=0;y<=doc.height;y++){oc.moveTo(0,y);oc.lineTo(doc.width,y);}oc.stroke();oc.restore();}
  if(state.rulers){oc.save();oc.font=`${10/state.zoom}px sans-serif`;oc.fillStyle='#777';oc.strokeStyle='#777';oc.lineWidth=1/state.zoom;for(let i=0;i<doc.width;i+=100){oc.fillText(String(i),i+2/state.zoom,12/state.zoom);oc.fillRect(i,0,1/state.zoom,5/state.zoom);}for(let i=100;i<doc.height;i+=100)oc.fillText(String(i),2/state.zoom,i);oc.restore();}
  if(pendingShape)paintPendingShape(oc,pendingShape,{handles:true,pixels:false,zoom:state.zoom});
  const rect=drag?.kind==='select'?box(drag.start,drag.current):null;
  if(drag?.kind==='lasso'){oc.save();oc.strokeStyle='#444';oc.lineWidth=1/state.zoom;oc.setLineDash([4/state.zoom,4/state.zoom]);oc.beginPath();drag.points.forEach((p,i)=>i?oc.lineTo(...p):oc.moveTo(...p));oc.stroke();oc.restore();}
  if(rect){oc.save();oc.lineWidth=1/state.zoom;oc.strokeStyle='#fff';oc.strokeRect(rect.x,rect.y,rect.width,rect.height);oc.strokeStyle='#333';oc.setLineDash([4/state.zoom,4/state.zoom]);oc.strokeRect(rect.x,rect.y,rect.width,rect.height);oc.restore();}
  const geometry=doc.getSelectionGeometry({zoom:state.zoom});
  if(geometry){
    oc.save();oc.lineWidth=1/state.zoom;oc.beginPath();geometry.corners.forEach((p,i)=>i?oc.lineTo(...p):oc.moveTo(...p));oc.closePath();oc.strokeStyle='#fff';oc.stroke();oc.strokeStyle='#333';oc.setLineDash([4/state.zoom,4/state.zoom]);oc.stroke();oc.setLineDash([]);
    const k=6/state.zoom;oc.fillStyle='#fff';oc.strokeStyle='#555';
    for(const [x,y] of geometry.handles){oc.fillRect(x-k/2,y-k/2,k,k);oc.strokeRect(x-k/2,y-k/2,k,k);}
    oc.restore();
  }
}
function shapeOptions(){return {stroke:state.primary,fill:state.secondary,lineWidth:state.size,opacity:state.opacity,outline:state.outline,fillStyle:state.fillStyle,constrain:drag?.shift||false};}
function updatePendingStyle(){if(pendingShape)pendingShape={...pendingShape,options:{...shapeOptions(),constrain:false}};changed();}
function renderLayers(){
  const list=$('#layer-list'), wanted=new Set(doc.layers.map(layer=>layer.id)),focused=list.contains(document.activeElement)?document.activeElement:null;
  for(const row of [...list.children])if(!wanted.has(row.dataset.layer))row.remove();
  for(const [index,l] of [...doc.layers].reverse().entries()){
    let row=[...list.children].find(row=>row.dataset.layer===l.id);
    if(!row){row=document.createElement('div');row.className='layer';row.dataset.layer=l.id;row.innerHTML='<button type="button" class="layer-eye"></button><button type="button" class="layer-select"><canvas width="66" height="45" aria-hidden="true"></canvas><span></span></button>';}
    if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
    row.classList.toggle('active',l.id===doc.activeLayerId);
    const eye=row.querySelector('.layer-eye'), select=row.querySelector('.layer-select'), c=select.querySelector('canvas');
    eye.dataset.visible=l.id;eye.title=`${l.visible?'Hide':'Show'} layer`;eye.setAttribute('aria-label',`${eye.title} ${l.name}`);eye.setAttribute('aria-pressed',String(l.visible));
    if(eye.dataset.visibleState!==String(l.visible)){eye.innerHTML=icon(l.visible?'eye':'hidden',17);eye.dataset.visibleState=String(l.visible);}
    select.dataset.layerSelect=l.id;select.setAttribute('aria-label',`Select layer ${l.name}`);select.setAttribute('aria-pressed',String(l.id===doc.activeLayerId));select.querySelector('span').textContent=l.name;
    c.dataset.thumb=l.id;const cx=c.getContext('2d'), scale=Math.min(c.width/doc.width,c.height/doc.height);cx.clearRect(0,0,c.width,c.height);cx.drawImage(l.canvas,(c.width-doc.width*scale)/2,(c.height-doc.height*scale)/2,doc.width*scale,doc.height*scale);
  }
  if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});
  $('#layer-opacity').value=Math.round((doc.activeLayer?.opacity??1)*100);$('#background-swatch').style.background=doc.background||'repeating-conic-gradient(#bbb 0 25%,white 0 50%) 0 / 8px 8px';
}
function updateToolState(){
  document.querySelectorAll('[data-tool]').forEach(el=>{const active=el.dataset.tool===state.tool;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
  $('.brush-selector').classList.toggle('active',BRUSHES.some(b=>b.id===state.tool));
  $('#primary').style.background=state.primary;$('#secondary').style.background=state.secondary;
  $('#custom-colors').innerHTML=Array.from({length:10},(_,i)=>`<button style="--swatch:${customColors[i]||'transparent'}" ${customColors[i]?`data-color="${customColors[i]}"`:'data-action="colors"'} aria-label="Custom color ${i+1}" title="${customColors[i]||'Add custom color'}"></button>`).join('');
  $('#tool-label').textContent=BRUSHES.find(b=>b.id===state.tool)?.label||label(state.tool);
  $('#opacity-control').hidden=['select','lasso','picker','zoom','text','eraser'].includes(state.tool);
  $('#tolerance-control').hidden=state.tool!=='fill';$('#text-controls').hidden=state.tool!=='text';
  renderEraserCursor();
  overlay.style.cursor=state.tool==='eraser'?'none':state.tool==='text'?'text':state.tool==='zoom'?'zoom-in':state.tool==='select'||state.tool==='lasso'?'crosshair':state.tool==='picker'?'copy':'crosshair';
}
function chooseTool(tool){if(activePointerId!==null&&!pendingShape)cancelPointerInteraction();commitText();finishPending();doc.deselect();if(state.tool==='eraser'&&tool!=='eraser')state.size=state.lastBrushSize;else if(state.tool!=='eraser'&&tool==='eraser'){state.lastBrushSize=state.size;state.size=state.eraserSize;}state.tool=tool;$('#size').value=$('#size-number').value=state.size;if(BRUSHES.some(b=>b.id===tool))state.brush=tool;updateToolState();closeMenu();overlay.focus({preventScroll:true});changed();}
function point(e){const r=overlay.getBoundingClientRect();return [(e.clientX-r.left)/state.zoom,(e.clientY-r.top)/state.zoom];}
function box(a,b){return {x:Math.floor(Math.min(a[0],b[0])),y:Math.floor(Math.min(a[1],b[1])),width:Math.max(1,Math.round(Math.abs(b[0]-a[0]))),height:Math.max(1,Math.round(Math.abs(b[1]-a[1])))};}
function pressure(e){return e.pointerType==='pen'?e.pressure:.5;}
function releasePointer(){const pointerId=activePointerId;activePointerId=null;if(pointerId!==null&&overlay.hasPointerCapture(pointerId))overlay.releasePointerCapture(pointerId);}
function cancelPointerInteraction() {
  if(drag?.kind==='pan'){drag=drag.suspendedDrag;releasePointer();changed();return true;}
  const pending=activePointerId!==null||drag||stroke||shapePreview||pendingShape||curve||polygon.length;
  if(!pending)return false;
  stroke?.end();stroke=null;drag=null;shapePreview=null;pendingShape=null;curve=null;polygon=[];
  releasePointer();
  doc.cancel();
  changed();return true;
}
overlay.addEventListener('contextmenu',e=>e.preventDefault());
viewport.addEventListener('scroll',renderEraserCursor,{passive:true});
new ResizeObserver(renderEraserCursor).observe(viewport);
window.addEventListener('resize',renderEraserCursor);
overlay.addEventListener('pointerenter',e=>{hoverClient=[e.clientX,e.clientY];renderEraserCursor();});
overlay.addEventListener('pointerleave',()=>{hoverClient=null;renderEraserCursor();});
const beginPointer=safe(e=>{
  if(e.button>2||activePointerId!==null||canvasResize.candidate)return;
  if(e.currentTarget===selectionRotation)e.preventDefault();
  const p=point(e),secondary=e.button===2,pan=e.button===1||e.altKey;
  const pendingHit=pendingShape&&!pan?hitPendingShape(pendingShape,p,state.zoom):null;
  if(pendingShape&&!pan&&!pendingHit)finishPending();
  activePointerId=e.pointerId;closeMenu();overlay.focus({preventScroll:true});overlay.setPointerCapture(e.pointerId);
  if(pan){drag={kind:'pan',start:[e.clientX,e.clientY],scroll:[viewport.scrollLeft,viewport.scrollTop],suspendedDrag:drag};return;}
  if(pendingHit){drag={kind:'pending-shape',original:pendingShape,hit:pendingHit,start:p};return;}
  if(textEditor){commitText();return;}
  if(!doc.activeLayer.visible&&!['select','lasso','zoom','picker'].includes(state.tool)){toast('Show the active layer before drawing.');return;}
  if(curve){curve.controls.push(p);if(curve.controls.length===2)finishPending();else changed();return;}
  if(state.tool==='polygon'){if(!polygon.length){doc.deselect();doc.begin('Polygon');}polygon.push(p);drag={kind:'polygon',hover:p};changed();return;}
  if(state.tool==='text'){doc.deselect();startText(p);return;}
  if(state.tool==='zoom'){setZoom(state.zoom*(secondary?.5:2));return;}
  if(state.tool==='picker'){const c=doc.composite().getContext('2d').getImageData(Math.max(0,Math.min(doc.width-1,Math.floor(p[0]))),Math.max(0,Math.min(doc.height-1,Math.floor(p[1]))),1,1).data;state[secondary?'secondary':'primary']='#'+[...c].slice(0,3).map(v=>v.toString(16).padStart(2,'0')).join('');updateToolState();return;}
  if(state.tool==='fill'){doc.deselect();doc.fill(Math.floor(p[0]),Math.floor(p[1]),(secondary?state.secondary:state.primary)+Math.round(state.opacity*255).toString(16).padStart(2,'0'),Math.round(state.tolerance*2.55));return;}
  if(['select','lasso'].includes(state.tool)){
    doc.setSelectionTransparency(state.transparentSelection,state.secondary);
    if(doc.selection){const hit=e.currentTarget===selectionRotation?{kind:'rotate'}:doc.hitSelection(p,{zoom:state.zoom});if(hit){if(doc.beginSelectionTransform(hit,p))drag={kind:'selection-transform',hit};return;}doc.deselect();}
    drag={kind:state.tool==='lasso'?'lasso':'select',start:p,current:p,points:[p]};changed();return;
  }
  doc.deselect();doc.begin(label(state.tool));
  if(SHAPES.includes(state.tool)){drag={kind:'shape',start:p,current:p,shift:e.shiftKey};shapePreview=[...p,...p];}
  else{const context=doc.activeLayer.canvas.getContext('2d');stroke=state.tool==='eraser'?createEraserStroke(context,{size:state.size,mode:secondary?'replace':'erase',primary:state.primary,secondary:state.secondary}):createStroke(context,state.tool,{color:secondary?state.secondary:state.primary,secondaryColor:state.secondary,size:state.size,opacity:state.opacity});stroke.move(...p,pressure(e));drag={kind:'stroke'};}
  changed();
});
overlay.addEventListener('pointerdown',beginPointer);
selectionRotation.addEventListener('pointerdown',beginPointer);
overlay.addEventListener('pointermove',safe(e=>{
  if(activePointerId!==null&&e.pointerId!==activePointerId)return;
  const p=point(e);hoverClient=[e.clientX,e.clientY];renderEraserCursor();$('#coordinates').textContent=`${Math.round(p[0])}, ${Math.round(p[1])}px`;
  if(drag?.kind==='pan'){viewport.scrollLeft=drag.scroll[0]+drag.start[0]-e.clientX;viewport.scrollTop=drag.scroll[1]+drag.start[1]-e.clientY;return;}
  if(curve){curve.hover=p;changed();return;}
  if(!drag){const hit=pendingShape?hitPendingShape(pendingShape,p,state.zoom):doc.hitSelection(p,{zoom:state.zoom});if(pendingShape||doc.selection)overlay.style.cursor=hit?.kind==='move'?'move':hit?.kind==='rotate'?'grab':hit?'nwse-resize':'crosshair';return;}
  if(drag.kind==='stroke'){const samples=e.getCoalescedEvents?.();for(const q of samples?.length?samples:[e])stroke.move(...point(q),pressure(q));}
  else if(drag.kind==='pending-shape')pendingShape=transformPendingShape(drag.original,drag.hit,drag.start,p,{constrain:e.shiftKey});
  else if(drag.kind==='selection-transform')doc.updateSelectionTransform(p);
  else if(drag.kind==='shape'){drag.current=p;drag.shift=e.shiftKey;shapePreview=[...drag.start,...p];}
  else if(drag.kind==='select'){drag.current=p;}
  else if(drag.kind==='lasso'){drag.points.push(p);}
  else if(drag.kind==='polygon'){drag.hover=p;}
  changed();
}));
overlay.addEventListener('pointerup',safe(e=>{
  if(e.pointerId!==activePointerId)return;activePointerId=null;
  if(!drag)return;const d=drag;
  if(d.kind==='pan'){drag=d.suspendedDrag;changed();return;}
  if(d.kind==='polygon')return;
  if(d.kind==='stroke'){if(state.tool==='eraser')stroke.move(...point(e));stroke.end();stroke=null;doc.commit();}
  if(d.kind==='shape'){if(d.start[0]===d.current[0]&&d.start[1]===d.current[1])doc.cancel();else if(state.tool==='curve'){curve={start:d.start,end:d.current,controls:[]};}else{pendingShape=createPendingShape(state.tool,d.start,d.current,shapeOptions());}shapePreview=null;}
  if(d.kind==='select'){const r=box(d.start,d.current);if(d.start[0]!==d.current[0]||d.start[1]!==d.current[1])doc.selectRect(r.x,r.y,r.width,r.height);}
  if(d.kind==='lasso'&&d.points.length>2)doc.selectPolygon(d.points);
  if(d.kind==='selection-transform')doc.commit();
  drag=null;changed();
}));
for(const type of ['pointercancel','lostpointercapture'])overlay.addEventListener(type,e=>{if(e.pointerId===activePointerId)cancelPointerInteraction();});
window.addEventListener('blur',()=>{if(activePointerId!==null)cancelPointerInteraction();});
overlay.addEventListener('dblclick',()=>{if(state.tool==='polygon')finishPending();});
function paintDrawingDraft(c){
  if(shapePreview)drawShape(c,state.tool,...shapePreview,shapeOptions());
  if(pendingShape)paintPendingShape(c,pendingShape);
  if(curve)paintCurve(c);
  if(polygon.length)paintPolygon(c,true);
}
function paintCurve(c){
  const controls=[...curve.controls];if(controls.length<2&&curve.hover)controls.push(curve.hover);
  drawShape(c,controls.length?'curve':'line',...curve.start,...curve.end,{...shapeOptions(),constrain:false,controlPoints:controls.map(([x,y])=>({x,y}))});
}
function paintPolygon(c,preview=false){
  const points=preview&&drag?.hover?[...polygon,drag.hover]:polygon;
  if(points.length<2)return;
  drawShape(c,points.length<3?'line':'polygon',...points[0],...points.at(-1),{...shapeOptions(),constrain:false,points:points.map(([x,y])=>({x,y}))});
}
function finishPending(){
  if(pendingShape||curve||polygon.length){drag=null;releasePointer();}
  if(pendingShape){paintPendingShape(doc.activeLayer.canvas.getContext('2d'),pendingShape);pendingShape=null;doc.commit();}
  if(curve){paintCurve(doc.activeLayer.canvas.getContext('2d'));curve=null;doc.commit();}
  if(polygon.length){paintPolygon(doc.activeLayer.canvas.getContext('2d'));polygon=[];drag=null;doc.commit();}changed();
}
function startText(p){
  doc.begin('Text');
  const t=document.createElement('textarea');t.className='text-editor';t.setAttribute('aria-label','Text on canvas');t.spellcheck=false;t.style.left=`${p[0]*state.zoom}px`;t.style.top=`${p[1]*state.zoom}px`;t.style.width=`${Math.min(400,doc.width-p[0])*state.zoom}px`;t.style.minHeight=`${100*state.zoom}px`;stage.append(t);textEditor={el:t,x:p[0],y:p[1]};styleText();t.focus();
}
function styleText(){if(!textEditor)return;Object.assign(textEditor.el.style,{fontFamily:state.font,fontSize:`${state.fontSize*state.zoom}px`,fontWeight:state.bold?'bold':'normal',fontStyle:state.italic?'italic':'normal',textDecoration:state.underline?'underline':'none',color:state.primary,background:state.textBackground?state.secondary:'transparent',textAlign:state.align,lineHeight:'1.2'});}
function commitText(){
  if(!textEditor)return;const {el,x,y}=textEditor;
  if(!el.value.trim()){el.remove();textEditor=null;doc.cancel();return;}
  // Measure the attached editor before removing it. Its browser layout owns
  // wrapping, spacing and alignment in both the preview and the saved pixels.
  const layout=layoutTextEditor(el,{scale:state.zoom}),c=doc.activeLayer.canvas.getContext('2d');
  c.save();try{
    c.font=layout.font;c.direction=layout.direction;c.letterSpacing=layout.letterSpacing;c.wordSpacing=layout.wordSpacing;c.textBaseline='alphabetic';c.textAlign='left';
    if(state.textBackground){c.fillStyle=state.secondary;c.fillRect(x+layout.contentX,y+layout.contentY,layout.width,layout.height);}
    c.fillStyle=state.primary;
    for(const line of layout.lines)for(const run of line.runs){
      c.fillText(run.text,x+run.x,y+run.baseline);
      if(state.underline)c.fillRect(x+run.x,y+run.baseline+Math.max(1,state.fontSize/12),run.width,Math.max(1,state.fontSize/16));
    }
  }finally{c.restore();}
  el.remove();textEditor=null;doc.commit();changed();
}
function setZoom(value){canvasResize.cancel();if(activePointerId!==null)cancelPointerInteraction();commitText();state.zoom=Math.max(.125,Math.min(8,Number(value)));$('#zoom-slider').value=Math.log2(state.zoom);const select=$('#zoom-presets');let option=[...select.options].find(o=>+o.value===state.zoom);if(!option){option=new Option(`${Math.round(state.zoom*100)}%`,String(state.zoom));select.add(option);}select.value=option.value;changed();}
function fit(){setZoom(Math.min(1,(viewport.clientWidth-80)/doc.width,(viewport.clientHeight-60)/doc.height));}
viewport.addEventListener('wheel',e=>{if(e.ctrlKey){e.preventDefault();setZoom(state.zoom*(e.deltaY>0?.9:1.1));}},{passive:false});
viewport.addEventListener('pointerdown',safe(e=>{if(e.target===viewport&&e.button===0&&activePointerId===null){commitText();finishPending();doc.deselect();overlay.focus({preventScroll:true});}}));
$('#zoom-slider').addEventListener('input',e=>setZoom(2**+e.target.value));$('#zoom-presets').addEventListener('change',e=>setZoom(+e.target.value));
function changeSize(value){if(activePointerId!==null&&!pendingShape)cancelPointerInteraction();state.size=Math.round(Math.max(1,Math.min(500,Number(value)||1)));if(state.tool==='eraser')state.eraserSize=state.size;$('#size').value=$('#size-number').value=state.size;updatePendingStyle();}
$('#size').addEventListener('input',e=>changeSize(e.target.value));$('#size-number').addEventListener('change',e=>changeSize(e.target.value));
$('#opacity').addEventListener('input',e=>{state.opacity=+e.target.value/100;$('#opacity-value').value=e.target.value+'%';updatePendingStyle();});$('#tolerance').addEventListener('input',e=>{state.tolerance=+e.target.value;$('#tolerance-value').value=e.target.value+'%';});
$('#outline').addEventListener('change',e=>{state.outline=e.target.value;updatePendingStyle();});$('#shape-fill').addEventListener('change',e=>{state.fillStyle=e.target.value;updatePendingStyle();});
$('#font').addEventListener('change',e=>{state.font=e.target.value;styleText();});$('#font-size').addEventListener('change',e=>{state.fontSize=Math.max(6,Math.min(500,+e.target.value||24));styleText();});$('#text-align').addEventListener('change',e=>{state.align=e.target.value;styleText();});$('#text-background').addEventListener('change',e=>{state.textBackground=e.target.checked;styleText();});
$('#layer-opacity').addEventListener('change',e=>{if(activePointerId!==null)cancelPointerInteraction();commitText();finishPending();doc.setLayer(doc.activeLayerId,{opacity:+e.target.value/100});});
$('#layer-list').addEventListener('dblclick',safe(async e=>{const row=e.target.closest('[data-layer]');if(row){if(activePointerId!==null)cancelPointerInteraction();commitText();finishPending();const l=doc.layers.find(l=>l.id===row.dataset.layer);const values=await dialog('Rename layer',`<label>Name<input name="name" value="${esc(l.name)}" required maxlength="100"></label>`);if(values)doc.setLayer(l.id,{name:values.name});}}));

async function dialog(title,body,submit='OK'){
  closeMenu();const d=$('#dialog');if(d.open)d.close();d.innerHTML=`<form method="dialog"><h2>${esc(title)}</h2><div class="dialog-content">${body}</div><footer><button value="cancel" type="button" id="dialog-cancel">Cancel</button><button value="ok" class="accent" type="submit">${submit}</button></footer></form>`;d.showModal();d.querySelector('#dialog-cancel').onclick=()=>d.close('cancel');
  return new Promise(resolve=>{d.querySelector('form').onsubmit=e=>{e.preventDefault();d.close('ok');};d.addEventListener('close',()=>resolve(d.returnValue==='ok'?Object.fromEntries(new FormData(d.querySelector('form'))):null),{once:true});});
}
function settleForOutput(){commitText();finishPending();doc.commitSelection();}
async function canDiscard(){settleForOutput();if(!doc.dirty)return true;if(window.paintDesktop?.confirmDiscard)return window.paintDesktop.confirmDiscard();return !!await dialog('Unsaved changes','<p>Discard the changes to this image?</p>','Discard');}
async function loadImage(result){if(!result)return;await doc.load({format:PROJECT.format,version:PROJECT.schemaVersion,width:result.canvas.width,height:result.canvas.height,background:null,layers:[{id:'imported',name:'Layer 1',visible:true,opacity:1,png:result.canvas.toDataURL()}],activeLayerId:'imported'});state.name=result.name.replace(/\.[^.]+$/,'');state.project=false;const format=result.format||result.name.split('.').at(-1).toLowerCase();state.format=['tif','tiff'].includes(format)?'tiff':['jpg','jpeg'].includes(format)?'jpeg':['png','webp','bmp','gif'].includes(format)?format:'png';fit();}
let fileOperation = false, documentFile = null;
function rememberDocumentFile(target, format) {
  documentFile = target ? { target, format, generation: doc.captureEditTarget().generation } : null;
}
function currentFileTarget(format) {
  return documentFile?.generation === doc.captureEditTarget().generation && documentFile.format === format ? documentFile.target : undefined;
}
async function withFileOperation(operation) {
  if (fileOperation) { toast('Finish the current file operation first.'); return; }
  fileOperation = true;
  try { return await operation(); } finally { fileOperation = false; }
}
async function openDocument(picker) {
  if (!await canDiscard()) return;
  const target = doc.captureEditTarget(), result = await picker();
  if (!result) return;
  if (!doc.matchesEditTarget(target)) { toast('Open canceled because the drawing changed.'); return; }
  if (!result.data) await loadImage(result);
  else {
    if (result.format === 'paint') doc.loadRaster(result.data);
    else await doc.load(result.data);
    state.name = result.name.replace(/\.[^.]+$/, '');
    state.project = true; state.format = result.format;
    fit();
  }
  rememberDocumentFile(result.targetFormat === state.format ? result.target : undefined, state.format);
}
async function saveDocument(format, name, { saveAs = false } = {}) {
  settleForOutput();
  const target = doc.captureEditTarget(), revision = doc.revision;
  const project = format === 'paint' || format === PROJECT.extension;
  const canMarkSaved = project || (doc.layers.length === 1 && doc.activeLayer.visible && doc.activeLayer.opacity === 1 && !state.project);
  const destination = saveAs ? undefined : currentFileTarget(format);
  const options = { target: destination };
  const receipt = format === 'paint' ? await savePaintFile(doc, name, options) : format === PROJECT.extension ?
    await saveProjectFile(doc.serialize(), name, options) : await saveImageFile(doc.composite(), format, name, options);
  if (!receipt || doc.captureEditTarget().generation !== target.generation) return;
  state.name = receipt.name ? receipt.name.replace(/\.[^.]+$/, '') : name; state.format = format;
  state.project = project;
  rememberDocumentFile(receipt.target, format);
  if (canMarkSaved) doc.markSaved(revision);
  else toast('Image exported. Save a project to preserve editable layers.');
  changed();
}
async function saveAs() {
  settleForOutput();
  const values = await dialog('Save image', `<label>File name<input name="name" value="${esc(state.name)}" required></label><label>File type<select name="format"><option value="png">PNG image (.png)</option><option value="jpeg">JPEG image (.jpg)</option><option value="bmp">Bitmap image (.bmp)</option><option value="webp">WebP image (.webp)</option><option value="gif">GIF image (.gif)</option><option value="tiff">TIFF image (.tiff)</option><option value="paint">Paint project (.paint)</option></select></label><p class="hint">Paint projects preserve visible layers at full opacity. Use Save as project (.sjpaint) to preserve hidden layers or layer opacity.</p>`, 'Save');
  if (values) await saveDocument(values.format, values.name, { saveAs: true });
}
async function colorDialog(which='primary'){
  const values=await dialog('Edit colors',`<div class="color-editor"><input type="color" name="color" value="${state[which]}" aria-label="Color spectrum"><label>Hex<input id="hex" value="${state[which]}" pattern="#[0-9a-fA-F]{6}" maxlength="7"></label></div><p class="hint">Choose a color, or enter its hexadecimal value.</p>`);
  if(values){state[which]=values.color;customColors=[values.color,...customColors.filter(c=>c!==values.color)].slice(0,10);localStorage.setItem('paint-colors',JSON.stringify(customColors));updateToolState();styleText();updatePendingStyle();}
}
$('#dialog').addEventListener('input',e=>{if(e.target.name==='color'&&$('#hex'))$('#hex').value=e.target.value;if(e.target.id==='hex'&&/^#[0-9a-fA-F]{6}$/.test(e.target.value))$('#dialog [name="color"]').value=e.target.value;});
async function resizeDialog(){
  commitText();const geometry=doc.getSelectionGeometry(),w=geometry?Math.round(geometry.frameWidth):doc.width,h=geometry?Math.round(geometry.frameHeight):doc.height;
  const pending=dialog('Resize and skew',`<fieldset><legend>Resize</legend><label>By<select name="unit" id="resize-unit"><option value="pixels">Pixels</option><option value="percent">Percentage</option></select></label><div class="two-columns"><label>Horizontal<input id="resize-width" name="width" type="number" min="1" max="16384" value="${w}" required></label><label>Vertical<input id="resize-height" name="height" type="number" min="1" max="16384" value="${h}" required></label></div><label class="check-label"><input id="aspect" type="checkbox" checked>Maintain aspect ratio</label><label class="check-label"><input name="scale" type="checkbox" checked>Scale image pixels</label></fieldset><fieldset><legend>Skew (degrees)</legend><div class="two-columns"><label>Horizontal<input name="skewX" type="number" min="-80" max="80" value="0"></label><label>Vertical<input name="skewY" type="number" min="-80" max="80" value="0"></label></div></fieldset>`);
  $('#resize-width').oninput=e=>{if($('#aspect').checked)$('#resize-height').value=Math.round(+e.target.value*($('#resize-unit').value==='pixels'?h/w:1));};$('#resize-height').oninput=e=>{if($('#aspect').checked)$('#resize-width').value=Math.round(+e.target.value*($('#resize-unit').value==='pixels'?w/h:1));};$('#resize-unit').onchange=e=>{$('#resize-width').value=e.target.value==='pixels'?w:100;$('#resize-height').value=e.target.value==='pixels'?h:100;};
  const v=await pending;if(v){doc.resize(Math.round(+v.width*(v.unit==='percent'?w/100:1)),Math.round(+v.height*(v.unit==='percent'?h/100:1)),{scale:!!v.scale,skewX:+v.skewX,skewY:+v.skewY});fit();}
}
const actions={
  new:async()=>{if(await canDiscard()){doc.newDocument(1152,648);state.name='Untitled';state.project=false;state.format='png';fit();}},
  open:()=>withFileOperation(()=>openDocument(()=>openImageFile({allowProjects:true}))),
  'open-project':()=>withFileOperation(()=>openDocument(openProjectFile)),
  save:()=>withFileOperation(()=>state.project ? saveDocument(state.format==='paint'?'paint':PROJECT.extension,state.name) : state.name==='Untitled'&&!currentFileTarget(state.format) ? saveAs() : saveDocument(state.format,state.name)),
  'save-as':()=>withFileOperation(saveAs),'save-project':()=>withFileOperation(()=>saveDocument(PROJECT.extension,state.name,{saveAs:true})),
  print:()=>{settleForOutput();return printCanvas(doc.composite());},
  undo:()=>{if(canvasResize.cancel()||cancelPointerInteraction())return;commitText();doc.undo();},redo:()=>{if(textEditor||canvasResize.cancel()||cancelPointerInteraction())return;doc.redo();},
  copy:async()=>{commitText();await copyCanvas(doc.selectionCanvas()||doc.composite({onlyActive:true}));toast('Copied image.');},
  'copy-all':async()=>{await copyCanvas(doc.composite());toast('Copied visible layers.');},
  cut:async()=>{commitText();finishPending();const target=doc.captureEditTarget();await copyCanvas(doc.selectionCanvas()||doc.composite({onlyActive:true}));if(!doc.matchesEditTarget(target)){toast('Image copied. The drawing changed, so nothing was cut.');return;}if(doc.selection)doc.deleteSelection();else doc.clear();toast('Cut image.');},
  paste:async()=>{commitText();finishPending();const target=doc.captureEditTarget();const c=await pasteImage();if(c){if(!doc.matchesEditTarget(target)){toast('Paste canceled because the drawing changed.');return;}doc.pasteCanvas(c);state.tool='select';changed();}},
  'paste-from':async()=>{commitText();finishPending();const target=doc.captureEditTarget();const r=await openImageFile();if(r){if(!doc.matchesEditTarget(target)){toast('Paste canceled because the drawing changed.');return;}doc.pasteCanvas(r.canvas);state.tool='select';changed();}},
  delete:()=>doc.selection?doc.deleteSelection():doc.clear(),'select-all':()=>{chooseTool('select');doc.setSelectionTransparency(state.transparentSelection,state.secondary);doc.selectAll();},deselect:()=>doc.deselect(),
  'invert-selection':()=>doc.invertSelection(),'invert-colors':()=>doc.invertColors(),'transparent-selection':()=>{state.transparentSelection=!state.transparentSelection;doc.setSelectionTransparency(state.transparentSelection,state.secondary);toast(state.transparentSelection?'New selections ignore Color 2.':'New selections include every color.');},
  crop:()=>{doc.crop();fit();},resize:resizeDialog,
  'rotate-menu':e=>showMenu('rotate',e.currentTarget||e.target.closest('button')),'flip-menu':e=>showMenu('flip',e.currentTarget||e.target.closest('button')),
  'rotate-right':()=>doc.rotate(90),'rotate-left':()=>doc.rotate(-90),'rotate-180':()=>doc.rotate(180),
  'rotate-custom':async()=>{const v=await dialog('Custom rotate','<label>Angle in degrees<input name="angle" type="number" min="-360" max="360" step=".1" value="0" required></label>');if(v)doc.rotate(+v.angle);},
  'flip-horizontal':()=>doc.flip(true),'flip-vertical':()=>doc.flip(false),
  layers:()=>{state.layers=!state.layers;$('#layers-panel').hidden=!state.layers;render();},
  'add-layer':()=>doc.addLayer(),'delete-layer':()=>doc.deleteLayer(),'duplicate-layer':()=>doc.duplicateLayer(),'merge-layer':()=>doc.mergeDown(),'layer-up':()=>doc.moveLayer(doc.activeLayerId,1),'layer-down':()=>doc.moveLayer(doc.activeLayerId,-1),
  background:async()=>{const v=await dialog('Canvas background',`<label>Color<input type="color" name="color" value="${doc.background||'#ffffff'}"></label><label class="check-label"><input name="transparent" type="checkbox" ${!doc.background?'checked':''}>Transparent background</label>`);if(v)doc.setBackground(v.transparent?null:v.color);},
  'toggle-background':()=>doc.setBackground(doc.background?null:state.secondary),
  colors:()=>colorDialog(),primary:()=>colorDialog('primary'),secondary:()=>colorDialog('secondary'),
  fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();},
  fit,'zoom-in':()=>setZoom(state.zoom*1.25),'zoom-out':()=>setZoom(state.zoom/1.25),'zoom-100':()=>setZoom(1),grid:()=>{state.grid=!state.grid;changed();},rulers:()=>{state.rulers=!state.rulers;changed();},
  collapse:()=>{document.body.classList.toggle('collapsed');$('.collapse-tools').textContent=document.body.classList.contains('collapsed')?'⌄':'⌃';},
  bold:()=>{state.bold=!state.bold;styleText();$('[data-action="bold"]').classList.toggle('active',state.bold);},italic:()=>{state.italic=!state.italic;styleText();$('[data-action="italic"]').classList.toggle('active',state.italic);},underline:()=>{state.underline=!state.underline;styleText();$('[data-action="underline"]').classList.toggle('active',state.underline);},'commit-text':commitText,
  properties:async()=>{const v=await dialog('Image properties',`<p>${esc(state.name)}<br>${doc.layers.length} layer${doc.layers.length===1?'':'s'}</p><div class="two-columns"><label>Width (pixels)<input name="width" type="number" min="1" max="16384" value="${doc.width}" required></label><label>Height (pixels)<input name="height" type="number" min="1" max="16384" value="${doc.height}" required></label></div><p class="hint">Changes canvas dimensions without scaling the image.</p>`);if(v){doc.resize(+v.width,+v.height,{scale:false,target:'document'});fit();}},
  settings:async()=>{const v=await dialog('Settings',`<label>App theme<select name="theme"><option value="dark" ${state.theme==='dark'?'selected':''}>Dark</option><option value="light" ${state.theme==='light'?'selected':''}>Light</option></select></label><p>${PROJECT.productName} (${PROJECT.shortName})<br>Version ${VERSION}</p><p class="hint">An independent editor for Windows and Linux, built toward Microsoft Paint parity before adding its own features. Projects use .${PROJECT.extension}; older .linuxpaint projects remain readable. Paint .paint projects support full-canvas visible layers; unsupported variants are rejected. Cloud AI services are not connected.</p>`);if(v){state.theme=v.theme;document.documentElement.dataset.theme=v.theme;localStorage.setItem('paint-theme',v.theme);}},
};
const menus={
  file:[['New','new','Ctrl+N'],['Open','open','Ctrl+O'],['Open project','open-project'],null,['Save','save','Ctrl+S'],['Save as','save-as','Ctrl+Shift+S'],['Save as project','save-project'],null,['Print','print','Ctrl+P'],['Image properties','properties','Ctrl+E']],
  edit:[['Undo','undo','Ctrl+Z'],['Redo','redo','Ctrl+Y'],null,['Cut','cut','Ctrl+X'],['Copy','copy','Ctrl+C'],['Copy visible layers','copy-all','Ctrl+Shift+C'],['Paste','paste','Ctrl+V'],['Paste from file','paste-from'],null,['Select all','select-all','Ctrl+A'],['Delete','delete','Delete'],['Invert colors','invert-colors','Ctrl+I']],
  view:[['Zoom in','zoom-in','Ctrl++'],['Zoom out','zoom-out','Ctrl+-'],['100%','zoom-100'],['Fit to window','fit'],['Full screen','fullscreen','F11'],null,['Gridlines','grid'],['Rulers','rulers'],['Layers','layers'],['Collapse toolbar','collapse','Ctrl+F1']],
  selection:[['Rectangular selection','tool:select'],['Free-form selection','tool:lasso'],null,['Select all','select-all'],['Deselect','deselect'],['Invert selection','invert-selection','Ctrl+Shift+I'],['Transparent selection','transparent-selection']],
  rotate:[['Rotate right 90°','rotate-right'],['Rotate left 90°','rotate-left'],['Rotate 180°','rotate-180'],['Custom rotate','rotate-custom']],
  flip:[['Flip horizontal','flip-horizontal'],['Flip vertical','flip-vertical']],
};
// These commands change presentation or pending style, so the shape stays editable.
const pendingCommands=new Set(['undo','redo','colors','primary','secondary','bold','italic','underline','layers','fullscreen','fit','zoom-in','zoom-out','zoom-100','grid','rulers','collapse','settings','rotate-menu','flip-menu']);
async function executeAction(name,event){
  if(!pendingCommands.has(name)){if(activePointerId!==null&&!pendingShape)cancelPointerInteraction();commitText();finishPending();}
  return actions[name]?.(event);
}
function showMenu(name,anchor){
  commitText();const m=$('#menu');if(!m.hidden&&menuAnchor===anchor){closeMenu();return;}if(menuAnchor)menuAnchor.setAttribute('aria-expanded','false');menuAnchor=anchor;anchor.setAttribute('aria-expanded','true');
  const entries=name==='brushes'?BRUSHES.map(b=>[b.label,'tool:'+b.id]):menus[name];m.innerHTML=entries.map(item=>item?`<button type="button" role="menuitem" data-command="${item[1]}"><span>${esc(item[0])}</span><kbd>${item[2]||''}</kbd></button>`:'<hr>').join('');const r=anchor.getBoundingClientRect();m.hidden=false;m.style.left=Math.min(r.left,innerWidth-m.offsetWidth-10)+'px';m.style.top=r.bottom+4+'px';m.querySelector('button')?.focus({preventScroll:true});
}
function closeMenu(){const menu=$('#menu'),anchor=menuAnchor,restore=menu.contains(document.activeElement);menu.hidden=true;menuAnchor=null;if(anchor){anchor.setAttribute('aria-expanded','false');if(restore&&anchor.isConnected)anchor.focus({preventScroll:true});}}
$('#menu').setAttribute('role','menu');
for(const opener of document.querySelectorAll('[data-menu],[data-action="rotate-menu"],[data-action="flip-menu"]')){opener.setAttribute('aria-haspopup','menu');opener.setAttribute('aria-controls','menu');opener.setAttribute('aria-expanded','false');}
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#menu,[data-menu],[data-action="rotate-menu"],[data-action="flip-menu"]'))closeMenu();});
document.addEventListener('focusin',e=>{if(!$('#menu').hidden&&!$('#menu').contains(e.target)&&e.target!==menuAnchor)closeMenu();});
document.addEventListener('click',safe(async e=>{
  const t=e.target.closest('button,[data-layer]');if(!t)return;
  if(t.dataset.tool){chooseTool(t.dataset.tool);return;}
  if(t.dataset.menu){showMenu(t.dataset.menu,t);return;}
  if(t.dataset.command){const cmd=t.dataset.command;closeMenu();if(cmd.startsWith('tool:'))chooseTool(cmd.slice(5));else await executeAction(cmd,e);return;}
  if(t.dataset.color){state.primary=t.dataset.color;updateToolState();styleText();updatePendingStyle();return;}
  if(t.dataset.visible){if(activePointerId!==null)cancelPointerInteraction();commitText();finishPending();const l=doc.layers.find(l=>l.id===t.dataset.visible);doc.setLayer(l.id,{visible:!l.visible});return;}
  if(t.dataset.layerSelect||t.dataset.layer){if(activePointerId!==null)cancelPointerInteraction();commitText();finishPending();doc.selectLayer(t.dataset.layerSelect||t.dataset.layer);return;}
  if(t.dataset.action){const a=t.dataset.action;if(!['commit-text','bold','italic','underline','colors','primary','secondary','redo'].includes(a))commitText();await executeAction(a,{...e,currentTarget:t,target:t});}
}));
document.addEventListener('contextmenu',e=>{const t=e.target.closest('[data-color]');if(t){e.preventDefault();state.secondary=t.dataset.color;updateToolState();styleText();updatePendingStyle();}});
document.addEventListener('keydown',safe(async e=>{
  if($('#dialog').open)return;
  if(e.key==='Escape'&&!$('#menu').hidden){e.preventDefault();closeMenu();return;}
  if(!$('#menu').hidden&&$('#menu').contains(e.target)&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
    e.preventDefault();const buttons=[...$('#menu').querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);
    buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();return;
  }
  const edit=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if(e.key==='Escape'){if(canvasResize.cancel()){e.preventDefault();return;}if(drag?.kind==='pan'){cancelPointerInteraction();e.preventDefault();return;}const canceled=cancelPointerInteraction();if(doc.hasSelectionSession){doc.cancelSelection();e.preventDefault();return;}if(canceled){e.preventDefault();return;}closeMenu();if(textEditor){textEditor.el.remove();textEditor=null;doc.cancel();}doc.deselect();changed();return;}
  const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
  // Save belongs to the document even while a text or numeric field has focus.
  // Editing keys such as Undo, Select All and clipboard shortcuts stay local.
  if(edit&&!(mod&&key==='s'))return;let action;
  if(mod){action=({n:'new',o:'open',s:e.shiftKey?'save-as':'save',z:e.shiftKey?'redo':'undo',y:'redo',c:e.shiftKey?'copy-all':'copy',x:'cut',v:'paste',a:'select-all',p:'print',e:'properties',w:'resize','+':'zoom-in','=':'zoom-in','-':'zoom-out',b:e.shiftKey?'background':undefined,h:e.shiftKey?'toggle-background':undefined,i:e.shiftKey?'invert-selection':'invert-colors',f1:'collapse'})[key];}
  else if(key==='f11')action='fullscreen';else if(key==='delete')action='delete';else if(key==='enter'){if(e.target.closest('button,a[href]'))return;commitText();if(!pendingShape)finishPending();e.preventDefault();return;}
  else if(doc.selection&&['arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();const step=e.shiftKey?10:1;doc.translateSelection(key==='arrowright'?step:key==='arrowleft'?-step:0,key==='arrowdown'?step:key==='arrowup'?-step:0);return;}
  if(action){e.preventDefault();await executeAction(action);}
}));
window.addEventListener('beforeunload',e=>{if(doc.dirty||textEditor?.el.value.trim()||curve||polygon.length||stroke||shapePreview||pendingShape){e.preventDefault();e.returnValue='';}});
viewport.addEventListener('dragover',e=>{e.preventDefault();viewport.classList.add('drop-target');});viewport.addEventListener('dragleave',()=>viewport.classList.remove('drop-target'));
viewport.addEventListener('drop',safe(async e=>{e.preventDefault();viewport.classList.remove('drop-target');const f=e.dataTransfer.files[0];if(f)await withFileOperation(()=>openDocument(()=>isProjectFile(f.name)?readProjectFile(f):readImageFile(f)));}));
const canvasResize=bindCanvasResize({doc,stage,viewport,zoom:()=>state.zoom,canStart:()=>activePointerId===null,prepare:()=>{commitText();finishPending();overlay.focus({preventScroll:true});},changed,reportError:error=>toast(error.message)});
render();requestAnimationFrame(fit);
// Expose the document only in development for focused browser workflow checks.
if(import.meta.env.DEV)window.paintApp={doc,state,actions,setZoom};
