import './style.css';
import PROJECT from './project-format.json' with { type: 'json' };
import { VERSION } from './version.js';
import { bindCanvasResize } from './canvas-resize.js';
import { PaintDocument } from './engine.js';
import { drawShape } from './shapes.js';
import { createPendingShape, paintPendingShape, hitPendingShape, transformPendingShape } from './pending-shape.js';
import { createStroke, BRUSHES } from './brushes.js';
import { icon, SHAPES } from './icons.js';
import { openImageFile, saveImageFile, openProjectFile, saveProjectFile, readImageFile, readProjectFile, copyCanvas, pasteImage, printCanvas } from './files.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label = (s) => s.replaceAll('-',' ').replace(/^./,c=>c.toUpperCase());
const doc = new PaintDocument(1152,648);
const state = {tool:'brush',brush:'brush',primary:'#000000',secondary:'#ffffff',size:5,opacity:1,tolerance:0,zoom:1,outline:'solid',fillStyle:'none',layers:false,grid:false,rulers:false,name:'Untitled',format:'png',project:false,transparentSelection:false,font:'Arial',fontSize:24,bold:false,italic:false,underline:false,textBackground:false,align:'left',theme:localStorage.getItem('paint-theme')||'dark',lastBrushSize:5};
let drag=null,stroke=null,shapePreview=null,pendingShape=null,curve=null,polygon=[],textEditor=null,raf=0,toastTimer,menuAnchor=null,activePointerId=null;
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
  <div class="contextbar"><span id="tool-label">Brush</span><label>Size <input id="size" type="range" min="1" max="100" value="5"><input id="size-number" type="number" min="1" max="500" value="5" aria-label="Size in pixels"><span>px</span></label><label id="opacity-control">Opacity <input id="opacity" type="range" min="1" max="100" value="100"><output id="opacity-value">100%</output></label><label id="tolerance-control" hidden>Tolerance <input id="tolerance" type="range" min="0" max="100" value="0"><output id="tolerance-value">0%</output></label><div id="text-controls" hidden><select id="font" aria-label="Font"><option>Arial</option><option>Verdana</option><option>Georgia</option><option>Times New Roman</option><option>Courier New</option><option>Trebuchet MS</option><option>serif</option><option>sans-serif</option><option>monospace</option></select><input id="font-size" type="number" min="6" max="500" value="24" aria-label="Font size"><button data-action="bold" title="Bold"><b>B</b></button><button data-action="italic" title="Italic"><i>I</i></button><button data-action="underline" title="Underline"><u>U</u></button><select id="text-align" aria-label="Text alignment"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select><label><input id="text-background" type="checkbox">Opaque</label>${btn('commit-text','Apply text','check')}</div></div>
  <main class="workspace"><div class="viewport" id="viewport"><div class="canvas-stage" id="stage"><canvas id="canvas" aria-label="Drawing canvas"></canvas><canvas id="overlay" aria-label="Drawing interaction surface" tabindex="0"></canvas><div id="canvas-resize-preview" aria-hidden="true" hidden></div>${['nw','n','ne','w','e','sw','s','se'].map(edge=>`<div class="resize-handle" data-handle="${edge}" title="Resize canvas" aria-label="Resize canvas ${edge}"></div>`).join('')}</div></div><aside class="layers-panel" id="layers-panel" hidden><div class="panel-title"><strong>Layers</strong>${btn('layers','Close layers','close')}</div><div class="layer-actions">${btn('add-layer','Add layer','plus')}${btn('duplicate-layer','Duplicate layer','duplicate')}${btn('merge-layer','Merge down','merge')}${btn('delete-layer','Delete layer','trash')}</div><div id="layer-list"></div><div class="layer-controls">${btn('layer-up','Move layer up','up')}${btn('layer-down','Move layer down','down')}<label>Opacity <input type="range" min="0" max="100" id="layer-opacity" value="100"></label></div><button class="background-control" data-action="background"><span id="background-swatch"></span><span>Background</span></button></aside></main>
  <footer class="statusbar"><span id="coordinates">${icon('pencil',14)}<span>Ready</span></span><span id="selection-size"></span><span id="dimensions"></span><span id="document-state"></span><span class="grow"></span>${btn('fit','Fit to window','fit')}<select id="zoom-presets" aria-label="Zoom"><option value=".125">12.5%</option><option value=".25">25%</option><option value=".5">50%</option><option value=".75">75%</option><option value="1" selected>100%</option><option value="1.5">150%</option><option value="2">200%</option><option value="4">400%</option><option value="8">800%</option></select>${btn('zoom-out','Zoom out','minus')}<input id="zoom-slider" type="range" min="-3" max="3" step=".05" value="0" aria-label="Zoom slider">${btn('zoom-in','Zoom in','plus')}</footer>
  <div id="menu" class="menu" hidden></div><div id="toast" role="status" hidden></div><dialog id="dialog"></dialog>`;
const canvas=$('#canvas'),overlay=$('#overlay'),viewport=$('#viewport'),stage=$('#stage'),ctx=canvas.getContext('2d'),oc=overlay.getContext('2d');
const selectionRotation=document.createElement('button');
selectionRotation.id='selection-rotation';selectionRotation.type='button';selectionRotation.title='Rotate selection';selectionRotation.setAttribute('aria-label','Rotate selection');selectionRotation.innerHTML=icon('rotate',12);selectionRotation.hidden=true;stage.append(selectionRotation);
document.documentElement.dataset.theme=state.theme;

function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function safe(fn){return async(...args)=>{try{return await fn(...args);}catch(e){console.error(e);toast(e.message||String(e));}};}
function changed(){if(!raf)raf=requestAnimationFrame(()=>{raf=0;render();});}
doc.addEventListener('change',changed);doc.addEventListener('preview',changed);
function render(){
  if(canvas.width!==doc.width||canvas.height!==doc.height){canvas.width=overlay.width=doc.width;canvas.height=overlay.height=doc.height;}
  doc.renderTo(ctx,{layerPreview:pendingShape?{layerId:doc.activeLayerId,paint:c=>paintPendingShape(c,pendingShape)}:null});
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
  if(shapePreview)drawShape(oc,state.tool,...shapePreview,shapeOptions());
  if(pendingShape)paintPendingShape(oc,pendingShape,{handles:true,pixels:false,zoom:state.zoom});
  if(curve)paintCurve(oc);
  if(polygon.length)paintPolygon(oc,true);
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
  const list=$('#layer-list');list.innerHTML=[...doc.layers].reverse().map(l=>`<div class="layer ${l.id===doc.activeLayerId?'active':''}" data-layer="${esc(l.id)}"><button class="layer-eye" data-visible="${esc(l.id)}" title="${l.visible?'Hide':'Show'} layer">${icon(l.visible?'eye':'hidden',17)}</button><canvas width="66" height="45" data-thumb="${esc(l.id)}"></canvas><span>${esc(l.name)}</span></div>`).join('');
  for(const l of doc.layers){const c=list.querySelector(`[data-thumb="${CSS.escape(l.id)}"]`),cx=c.getContext('2d');const s=Math.min(c.width/doc.width,c.height/doc.height);cx.drawImage(l.canvas,(c.width-doc.width*s)/2,(c.height-doc.height*s)/2,doc.width*s,doc.height*s);}
  $('#layer-opacity').value=Math.round((doc.activeLayer?.opacity??1)*100);$('#background-swatch').style.background=doc.background||'repeating-conic-gradient(#bbb 0 25%,white 0 50%) 0 / 8px 8px';
}
function updateToolState(){
  document.querySelectorAll('[data-tool]').forEach(el=>{const active=el.dataset.tool===state.tool;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
  $('.brush-selector').classList.toggle('active',BRUSHES.some(b=>b.id===state.tool));
  $('#primary').style.background=state.primary;$('#secondary').style.background=state.secondary;
  $('#custom-colors').innerHTML=Array.from({length:10},(_,i)=>`<button style="--swatch:${customColors[i]||'transparent'}" ${customColors[i]?`data-color="${customColors[i]}"`:'data-action="colors"'} aria-label="Custom color ${i+1}" title="${customColors[i]||'Add custom color'}"></button>`).join('');
  $('#tool-label').textContent=BRUSHES.find(b=>b.id===state.tool)?.label||label(state.tool);
  $('#opacity-control').hidden=['select','lasso','picker','zoom','text'].includes(state.tool);
  $('#tolerance-control').hidden=state.tool!=='fill';$('#text-controls').hidden=state.tool!=='text';
  overlay.style.cursor=state.tool==='text'?'text':state.tool==='zoom'?'zoom-in':state.tool==='select'||state.tool==='lasso'?'crosshair':state.tool==='picker'?'copy':'crosshair';
}
function chooseTool(tool){if(activePointerId!==null&&!pendingShape)cancelPointerInteraction();commitText();finishPending();doc.deselect();state.tool=tool;if(BRUSHES.some(b=>b.id===tool))state.brush=tool;updateToolState();closeMenu();overlay.focus({preventScroll:true});changed();}
function point(e){const r=overlay.getBoundingClientRect();return [(e.clientX-r.left)/state.zoom,(e.clientY-r.top)/state.zoom];}
function box(a,b){return {x:Math.floor(Math.min(a[0],b[0])),y:Math.floor(Math.min(a[1],b[1])),width:Math.max(1,Math.round(Math.abs(b[0]-a[0]))),height:Math.max(1,Math.round(Math.abs(b[1]-a[1])))};}
function pressure(e){return e.pointerType==='pen'?e.pressure:.5;}
function releasePointer(){const pointerId=activePointerId;activePointerId=null;if(pointerId!==null&&overlay.hasPointerCapture(pointerId))overlay.releasePointerCapture(pointerId);}
function cancelPointerInteraction() {
  const pending=activePointerId!==null||drag||stroke||shapePreview||pendingShape||curve||polygon.length;
  if(!pending)return false;
  stroke?.end();stroke=null;drag=null;shapePreview=null;pendingShape=null;curve=null;polygon=[];
  releasePointer();
  doc.cancel();
  changed();return true;
}
overlay.addEventListener('contextmenu',e=>e.preventDefault());
const beginPointer=safe(e=>{
  if(e.button>2||activePointerId!==null||canvasResize.candidate)return;
  if(e.currentTarget===selectionRotation)e.preventDefault();
  const p=point(e),secondary=e.button===2,pan=e.button===1||e.altKey;
  const pendingHit=pendingShape&&!pan?hitPendingShape(pendingShape,p,state.zoom):null;
  if(pendingShape&&!pan&&!pendingHit)finishPending();
  activePointerId=e.pointerId;closeMenu();overlay.focus({preventScroll:true});overlay.setPointerCapture(e.pointerId);
  if(e.button===1||e.altKey){drag={kind:'pan',start:[e.clientX,e.clientY],scroll:[viewport.scrollLeft,viewport.scrollTop]};return;}
  if(pendingHit){drag={kind:'pending-shape',original:pendingShape,hit:pendingHit,start:p};return;}
  if(textEditor){commitText();return;}
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
  if(!doc.activeLayer.visible){toast('Show the active layer before drawing.');return;}
  doc.deselect();doc.begin(label(state.tool));
  if(SHAPES.includes(state.tool)){drag={kind:'shape',start:p,current:p,shift:e.shiftKey};shapePreview=[...p,...p];}
  else{stroke=createStroke(doc.activeLayer.canvas.getContext('2d'),state.tool,{color:secondary?state.secondary:state.primary,secondaryColor:state.secondary,size:state.size,opacity:state.opacity});stroke.move(...p,pressure(e));drag={kind:'stroke'};}
  changed();
});
overlay.addEventListener('pointerdown',beginPointer);
selectionRotation.addEventListener('pointerdown',beginPointer);
overlay.addEventListener('pointermove',safe(e=>{
  if(activePointerId!==null&&e.pointerId!==activePointerId)return;
  const p=point(e);$('#coordinates').textContent=`${Math.round(p[0])}, ${Math.round(p[1])}px`;
  if(curve){curve.hover=p;changed();return;}
  if(!drag){const hit=pendingShape?hitPendingShape(pendingShape,p,state.zoom):doc.hitSelection(p,{zoom:state.zoom});if(pendingShape||doc.selection)overlay.style.cursor=hit?.kind==='move'?'move':hit?.kind==='rotate'?'grab':hit?'nwse-resize':'crosshair';return;}
  if(drag.kind==='pan'){viewport.scrollLeft=drag.scroll[0]+drag.start[0]-e.clientX;viewport.scrollTop=drag.scroll[1]+drag.start[1]-e.clientY;return;}
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
  if(d.kind==='polygon')return;
  if(d.kind==='stroke'){stroke.end();stroke=null;doc.commit();}
  if(d.kind==='shape'){if(d.start[0]===d.current[0]&&d.start[1]===d.current[1])doc.cancel();else if(state.tool==='curve'){curve={start:d.start,end:d.current,controls:[]};}else{pendingShape=createPendingShape(state.tool,d.start,d.current,shapeOptions());}shapePreview=null;}
  if(d.kind==='select'){const r=box(d.start,d.current);if(d.start[0]!==d.current[0]||d.start[1]!==d.current[1])doc.selectRect(r.x,r.y,r.width,r.height);}
  if(d.kind==='lasso'&&d.points.length>2)doc.selectPolygon(d.points);
  if(d.kind==='selection-transform')doc.commit();
  drag=null;changed();
}));
for(const type of ['pointercancel','lostpointercapture'])overlay.addEventListener(type,e=>{if(e.pointerId===activePointerId)cancelPointerInteraction();});
window.addEventListener('blur',()=>{if(activePointerId!==null)cancelPointerInteraction();});
overlay.addEventListener('dblclick',()=>{if(state.tool==='polygon')finishPending();});
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
  const t=document.createElement('textarea');t.className='text-editor';t.setAttribute('aria-label','Text on canvas');t.spellcheck=false;t.style.left=`${p[0]*state.zoom}px`;t.style.top=`${p[1]*state.zoom}px`;t.style.width=`${Math.min(400,doc.width-p[0])*state.zoom}px`;t.style.minHeight=`${100*state.zoom}px`;stage.append(t);textEditor={el:t,x:p[0],y:p[1]};styleText();t.focus();
}
function styleText(){if(!textEditor)return;Object.assign(textEditor.el.style,{fontFamily:state.font,fontSize:`${state.fontSize*state.zoom}px`,fontWeight:state.bold?'bold':'normal',fontStyle:state.italic?'italic':'normal',textDecoration:state.underline?'underline':'none',color:state.primary,background:state.textBackground?state.secondary:'transparent',textAlign:state.align,lineHeight:'1.2'});}
function commitText(){
  if(!textEditor)return;const {el,x,y}=textEditor,text=el.value,w=el.clientWidth/state.zoom;el.remove();textEditor=null;if(!text.trim())return;
  doc.begin('Text');const c=doc.activeLayer.canvas.getContext('2d');c.save();c.font=`${state.italic?'italic ':''}${state.bold?'bold ':''}${state.fontSize}px "${state.font}"`;c.textBaseline='top';c.fillStyle=state.primary;c.textAlign=state.align;
  const lines=[];for(const para of text.split('\n')){let line='';for(const word of para.split(' ')){const next=line?line+' '+word:word;if(line&&c.measureText(next).width>w){lines.push(line);line=word;}else line=next;}lines.push(line);}
  if(state.textBackground){c.fillStyle=state.secondary;c.fillRect(x,y,w,lines.length*state.fontSize*1.2);c.fillStyle=state.primary;}
  const tx=x+(state.align==='center'?w/2:state.align==='right'?w:0);lines.forEach((line,i)=>{const ty=y+i*state.fontSize*1.2;c.fillText(line,tx,ty);if(state.underline){const length=c.measureText(line).width;c.fillRect(tx-(state.align==='center'?length/2:state.align==='right'?length:0),ty+state.fontSize,length,Math.max(1,state.fontSize/16));}});c.restore();doc.commit();changed();
}
function setZoom(value){canvasResize.cancel();if(activePointerId!==null)cancelPointerInteraction();commitText();state.zoom=Math.max(.125,Math.min(8,Number(value)));$('#zoom-slider').value=Math.log2(state.zoom);const select=$('#zoom-presets');let option=[...select.options].find(o=>+o.value===state.zoom);if(!option){option=new Option(`${Math.round(state.zoom*100)}%`,String(state.zoom));select.add(option);}select.value=String(state.zoom);changed();}
function fit(){setZoom(Math.min(1,(viewport.clientWidth-80)/doc.width,(viewport.clientHeight-60)/doc.height));}
viewport.addEventListener('wheel',e=>{if(e.ctrlKey){e.preventDefault();setZoom(state.zoom*(e.deltaY>0?.9:1.1));}},{passive:false});
viewport.addEventListener('pointerdown',safe(e=>{if(e.target===viewport&&e.button===0&&activePointerId===null){commitText();finishPending();doc.deselect();overlay.focus({preventScroll:true});}}));
$('#zoom-slider').addEventListener('input',e=>setZoom(2**+e.target.value));$('#zoom-presets').addEventListener('change',e=>setZoom(+e.target.value));
$('#size').addEventListener('input',e=>{state.size=+e.target.value;$('#size-number').value=state.size;updatePendingStyle();});$('#size-number').addEventListener('change',e=>{state.size=Math.max(1,Math.min(500,+e.target.value||1));e.target.value=state.size;$('#size').value=state.size;updatePendingStyle();});
$('#opacity').addEventListener('input',e=>{state.opacity=+e.target.value/100;$('#opacity-value').value=e.target.value+'%';updatePendingStyle();});$('#tolerance').addEventListener('input',e=>{state.tolerance=+e.target.value;$('#tolerance-value').value=e.target.value+'%';});
$('#outline').addEventListener('change',e=>{state.outline=e.target.value;updatePendingStyle();});$('#shape-fill').addEventListener('change',e=>{state.fillStyle=e.target.value;updatePendingStyle();});
$('#font').addEventListener('change',e=>{state.font=e.target.value;styleText();});$('#font-size').addEventListener('change',e=>{state.fontSize=Math.max(6,Math.min(500,+e.target.value||24));styleText();});$('#text-align').addEventListener('change',e=>{state.align=e.target.value;styleText();});$('#text-background').addEventListener('change',e=>{state.textBackground=e.target.checked;styleText();});
$('#layer-opacity').addEventListener('change',e=>{commitText();finishPending();doc.setLayer(doc.activeLayerId,{opacity:+e.target.value/100});});
$('#layer-list').addEventListener('dblclick',safe(async e=>{const row=e.target.closest('[data-layer]');if(row){commitText();finishPending();const l=doc.layers.find(l=>l.id===row.dataset.layer);const values=await dialog('Rename layer',`<label>Name<input name="name" value="${esc(l.name)}" required maxlength="100"></label>`);if(values)doc.setLayer(l.id,{name:values.name});}}));

async function dialog(title,body,submit='OK'){
  closeMenu();const d=$('#dialog');if(d.open)d.close();d.innerHTML=`<form method="dialog"><h2>${esc(title)}</h2><div class="dialog-content">${body}</div><footer><button value="cancel" type="button" id="dialog-cancel">Cancel</button><button value="ok" class="accent" type="submit">${submit}</button></footer></form>`;d.showModal();d.querySelector('#dialog-cancel').onclick=()=>d.close('cancel');
  return new Promise(resolve=>{d.querySelector('form').onsubmit=e=>{e.preventDefault();d.close('ok');};d.addEventListener('close',()=>resolve(d.returnValue==='ok'?Object.fromEntries(new FormData(d.querySelector('form'))):null),{once:true});});
}
function settleForOutput(){commitText();finishPending();doc.commitSelection();}
async function canDiscard(){settleForOutput();if(!doc.dirty)return true;if(window.paintDesktop?.confirmDiscard)return window.paintDesktop.confirmDiscard();return !!await dialog('Unsaved changes','<p>Discard the changes to this image?</p>','Discard');}
async function loadImage(result){if(!result)return;await doc.load({format:PROJECT.format,version:PROJECT.schemaVersion,width:result.canvas.width,height:result.canvas.height,background:null,layers:[{id:'imported',name:'Layer 1',visible:true,opacity:1,png:result.canvas.toDataURL()}],activeLayerId:'imported'});state.name=result.name.replace(/\.[^.]+$/,'');state.project=false;state.format=/\.jpe?g$/i.test(result.name)?'jpeg':'png';fit();}
async function saveAs(){settleForOutput();const values=await dialog('Save image',`<label>File name<input name="name" value="${esc(state.name)}" required></label><label>File type<select name="format"><option value="png">PNG image (.png)</option><option value="jpeg">JPEG image (.jpg)</option><option value="bmp">Bitmap image (.bmp)</option><option value="webp">WebP image (.webp)</option><option value="gif">GIF image (.gif)</option><option value="tiff">TIFF image (.tiff)</option></select></label><p class="hint">Save a project to keep layers editable.</p>`,'Save');if(values){const revision=doc.revision;const ok=await saveImageFile(doc.composite(),values.format,values.name);if(ok){state.name=values.name;state.format=values.format;if(doc.layers.length===1&&doc.activeLayer.visible&&doc.activeLayer.opacity===1&&!state.project)doc.markSaved(revision);else toast('Image exported. Save a project to preserve editable layers.');changed();}}}
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
  open:async()=>{if(await canDiscard())await loadImage(await openImageFile());},
  'open-project':async()=>{if(await canDiscard()){const r=await openProjectFile();if(r){await doc.load(r.data);state.name=r.name.replace(/\.[^.]+$/,'');state.project=true;fit();}}},
  save:async()=>{if(state.project)return actions['save-project']();settleForOutput();if(state.name==='Untitled')return saveAs();const revision=doc.revision;if(await saveImageFile(doc.composite(),state.format,state.name)){if(doc.layers.length===1&&doc.activeLayer.visible&&doc.activeLayer.opacity===1&&!state.project)doc.markSaved(revision);else toast('Image exported. Save a project to preserve editable layers.');changed();}},
  'save-as':saveAs,'save-project':async()=>{settleForOutput();const revision=doc.revision;if(await saveProjectFile(doc.serialize(),state.name)){state.project=true;doc.markSaved(revision);changed();}},
  print:()=>{settleForOutput();return printCanvas(doc.composite());},
  undo:()=>{if(canvasResize.cancel()||cancelPointerInteraction())return;commitText();doc.undo();},redo:()=>{if(canvasResize.cancel()||cancelPointerInteraction())return;doc.redo();},
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
  settings:async()=>{const v=await dialog('Settings',`<label>App theme<select name="theme"><option value="dark" ${state.theme==='dark'?'selected':''}>Dark</option><option value="light" ${state.theme==='light'?'selected':''}>Light</option></select></label><p>${PROJECT.productName} (${PROJECT.shortName})<br>Version ${VERSION}</p><p class="hint">An independent editor for Windows and Linux, built toward Microsoft Paint parity before adding its own features. Projects use .${PROJECT.extension}; older .linuxpaint projects remain readable. Microsoft .paint files and cloud AI services are not connected.</p>`);if(v){state.theme=v.theme;document.documentElement.dataset.theme=v.theme;localStorage.setItem('paint-theme',v.theme);}},
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
  commitText();const m=$('#menu');if(!m.hidden&&menuAnchor===anchor){closeMenu();return;}menuAnchor=anchor;
  const entries=name==='brushes'?BRUSHES.map(b=>[b.label,'tool:'+b.id]):menus[name];m.innerHTML=entries.map(item=>item?`<button data-command="${item[1]}"><span>${esc(item[0])}</span><kbd>${item[2]||''}</kbd></button>`:'<hr>').join('');const r=anchor.getBoundingClientRect();m.hidden=false;m.style.left=Math.min(r.left,innerWidth-m.offsetWidth-10)+'px';m.style.top=r.bottom+4+'px';m.querySelector('button')?.focus({preventScroll:true});
}
function closeMenu(){$('#menu').hidden=true;menuAnchor=null;}
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#menu,[data-menu],[data-action="rotate-menu"],[data-action="flip-menu"]'))closeMenu();});
document.addEventListener('click',safe(async e=>{
  const t=e.target.closest('button,[data-layer]');if(!t)return;
  if(t.dataset.tool){chooseTool(t.dataset.tool);return;}
  if(t.dataset.menu){showMenu(t.dataset.menu,t);return;}
  if(t.dataset.command){const cmd=t.dataset.command;closeMenu();if(cmd.startsWith('tool:'))chooseTool(cmd.slice(5));else await executeAction(cmd,e);return;}
  if(t.dataset.color){state.primary=t.dataset.color;updateToolState();styleText();updatePendingStyle();return;}
  if(t.dataset.visible){commitText();finishPending();const l=doc.layers.find(l=>l.id===t.dataset.visible);doc.setLayer(l.id,{visible:!l.visible});return;}
  if(t.dataset.layer){commitText();finishPending();doc.selectLayer(t.dataset.layer);return;}
  if(t.dataset.action){const a=t.dataset.action;if(a!=='commit-text'&&!['bold','italic','underline'].includes(a))commitText();await executeAction(a,{...e,currentTarget:t,target:t});}
}));
document.addEventListener('contextmenu',e=>{const t=e.target.closest('[data-color]');if(t){e.preventDefault();state.secondary=t.dataset.color;updateToolState();styleText();updatePendingStyle();}});
document.addEventListener('keydown',safe(async e=>{
  if($('#dialog').open)return;
  if(!$('#menu').hidden&&['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
    e.preventDefault();const buttons=[...$('#menu').querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);
    buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();return;
  }
  const edit=/INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
  if(e.key==='Escape'){if(canvasResize.cancel()){e.preventDefault();return;}const canceled=cancelPointerInteraction();if(doc.hasSelectionSession){doc.cancelSelection();e.preventDefault();return;}if(canceled){e.preventDefault();return;}closeMenu();if(textEditor){textEditor.el.remove();textEditor=null;}doc.deselect();changed();return;}
  if(edit)return;const key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;let action;
  if(mod){action=({n:'new',o:'open',s:e.shiftKey?'save-as':'save',z:e.shiftKey?'redo':'undo',y:'redo',c:e.shiftKey?'copy-all':'copy',x:'cut',v:'paste',a:'select-all',p:'print',e:'properties',w:'resize','+':'zoom-in','=':'zoom-in','-':'zoom-out',b:e.shiftKey?'background':undefined,h:e.shiftKey?'toggle-background':undefined,i:e.shiftKey?'invert-selection':'invert-colors',f1:'collapse'})[key];}
  else if(key==='f11')action='fullscreen';else if(key==='delete')action='delete';else if(key==='enter'){commitText();if(!pendingShape)finishPending();e.preventDefault();return;}
  else if(doc.selection&&['arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();const step=e.shiftKey?10:1;doc.translateSelection(key==='arrowright'?step:key==='arrowleft'?-step:0,key==='arrowdown'?step:key==='arrowup'?-step:0);return;}
  if(action){e.preventDefault();await executeAction(action);}
}));
window.addEventListener('beforeunload',e=>{if(doc.dirty||textEditor?.el.value.trim()||curve||polygon.length||stroke||shapePreview||pendingShape){e.preventDefault();e.returnValue='';}});
viewport.addEventListener('dragover',e=>{e.preventDefault();viewport.classList.add('drop-target');});viewport.addEventListener('dragleave',()=>viewport.classList.remove('drop-target'));
viewport.addEventListener('drop',safe(async e=>{e.preventDefault();viewport.classList.remove('drop-target');const f=e.dataTransfer.files[0];if(!f||!await canDiscard())return;if(PROJECT.readableExtensions.includes(f.name.split('.').at(-1).toLowerCase())){const project=await readProjectFile(f);await doc.load(project.data);state.name=project.name.replace(/\.[^.]+$/,'');state.project=true;fit();}else await loadImage(await readImageFile(f));}));
const canvasResize=bindCanvasResize({doc,stage,viewport,zoom:()=>state.zoom,canStart:()=>activePointerId===null,prepare:()=>{commitText();finishPending();overlay.focus({preventScroll:true});},changed,reportError:error=>toast(error.message)});
render();requestAnimationFrame(fit);
// Expose the document only in development for focused browser workflow checks.
if(import.meta.env.DEV)window.paintApp={doc,state,actions,setZoom};
