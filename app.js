/* All photo data stays in this browser. Static assets only; no fetch/XHR. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), { clamp, PhotoDocument } = DustCore;
  const PREF_KEY = 'jetphotos-dust-desktop-web-v2';
  const state = { entries: [], index: -1, doc: null, compare: true, dustOnly: false, filmstrip: true, busy: false, source: null, pointer: null, space: false, gesture: null, touches: new Map(), renderId: 0, dustTimer: null, frame: null, export: null, directory: null, suffix: '_dustclean', saveMode: 'download', worker: null, dustRegion: null, dustInFlight: false, dustPending: false, jobs: new Map(), nextJob: 0 };
  const settings = { strength: 10, detail: 0, radius: 8, color: true };
  const normalSurface = document.createElement('canvas'), dustSurface = document.createElement('canvas');
  const ctx = normalSurface.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  const dustCtx = dustSurface.getContext('2d');
  const canvases = [$('normalCanvas'), $('dustCanvas')];
  const contexts = canvases.map(canvas => canvas.getContext('2d'));
  const session = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now()) + Math.random();
  let database = null, disposed = false;
  const entry = () => state.entries[state.index];
  const hasDialog = () => !!document.querySelector('dialog[open]');
  function toast(message, error = false) {
    status(message);
    if(error && !hasDialog()) showResult('操作未完成',[message]);
  }
  function status(message) { $('statusText').textContent = message; }
  function safePreferenceRead() { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (_) { return {}; } }
  function persist() {
    const values = {};
    for (const name of ['brushSize','hardness','opacity','strength','detail','radius']) values[name] = Number($(name).value);
    values.aligned = $('aligned').checked; values.color = $('color').checked;
    values.compare = state.compare; values.filmstrip = state.filmstrip; values.suffix = state.suffix; values.saveMode=state.saveMode;
    values.panels = Array.from(document.querySelectorAll('.panel')).map(panel => ({ id: panel.dataset.panel, open: panel.open }));
    try { localStorage.setItem(PREF_KEY, JSON.stringify(values)); } catch (_) { /* Preferences are optional. */ }
  }
  const pref = safePreferenceRead();
  for (const name of ['brushSize','hardness','opacity','strength','detail','radius']) {
    const control = $(name);
    if (Number.isFinite(pref[name])) control.value = clamp(pref[name],Number(control.min),Number(control.max));
  }
  for (const name of ['aligned','color']) if (typeof pref[name] === 'boolean') $(name).checked = pref[name];
  if (typeof pref.compare === 'boolean') state.compare = pref.compare;
  if (typeof pref.filmstrip === 'boolean') state.filmstrip = pref.filmstrip;
  if (DustInteraction.validSuffix(pref.suffix)) state.suffix = pref.suffix;
  if (Array.isArray(pref.panels)) for (const item of pref.panels) {
    const panel = Array.from(document.querySelectorAll('.panel')).find(p => p.dataset.panel === item.id);
    if (panel && typeof item.open === 'boolean') { panel.open = item.open; $('editingControls').append(panel); }
  }
  function openDatabase() {
    return new Promise(resolve => {
      if (!window.indexedDB) { resolve(null); return; }
      let request;
      try { request = indexedDB.open('jp-dust-browser-local',2); } catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => {if(!request.result.objectStoreNames.contains('photos'))request.result.createObjectStore('photos',{keyPath:'key'});if(!request.result.objectStoreNames.contains('preferences'))request.result.createObjectStore('preferences',{keyPath:'key'});};
      request.onsuccess = () => {
        database = request.result;
        const tx = database.transaction('photos','readwrite'), cursor = tx.objectStore('photos').openCursor();
        cursor.onsuccess = () => { const c=cursor.result; if (!c) return; if(c.value.time < Date.now()-86400000) c.delete(); c.continue(); };
        database.onversionchange = () => { database.close(); database = null; };
        if(pref.saveMode==='directory'){
          const saved=database.transaction('preferences','readonly').objectStore('preferences').get('outputDirectory');
          saved.onsuccess=()=>{if(saved.result&&saved.result.handle){state.directory=saved.result.handle;state.saveMode='directory';updateUI();}};
        }
        resolve(database);
      };
      request.onerror = request.onblocked = () => resolve(null);
    });
  }
  const dbReady = openDatabase();
  async function cachePut(item, doc) {
    await dbReady;
    if (!database) { item.memory = doc; return; }
    try {
      await new Promise((resolve,reject) => {
        const tx=database.transaction('photos','readwrite');
        tx.objectStore('photos').put({ key:session+'/'+item.id, time:Date.now(), state:doc.serialize() });
        tx.oncomplete=resolve; tx.onerror=tx.onabort=()=>reject(tx.error);
      });
      item.cached=true; item.memory=null;
    } catch (_) { item.memory=doc; toast('浏览器本地缓存不可用，当前编辑暂存在内存中。'); }
  }
  async function cacheGet(item) {
    if (item.memory) return item.memory;
    if (!item.cached || !database) return null;
    const result=await new Promise((resolve,reject)=> {
      const tx=database.transaction('photos','readonly'), request=tx.objectStore('photos').get(session+'/'+item.id);
      request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);
    });
    if (!result) throw new Error('照片的本地编辑缓存无法读取。请保存其他照片后重新导入。');
    return PhotoDocument.restore(result.state);
  }
  function cacheDelete(item) {
    item.memory=null;
    if (database) { const tx=database.transaction('photos','readwrite'); tx.objectStore('photos').delete(session+'/'+item.id); }
  }
  function createWorker() {
    if (location.protocol === 'file:' || typeof Worker === 'undefined') return;
    try {
      state.worker=new Worker('worker.js');
      state.worker.onmessage=event=> {
        const message=event.data;
        if(message.type==='dust') {
          state.dustInFlight=false;
          if(state.doc && entry().id===message.token && message.id===state.renderId) {
            state.dustRegion=message.region?{...message.region,fullWidth:message.width,fullHeight:message.height}:null;
            dustSurface.width=message.region?message.region.width:message.width; dustSurface.height=message.region?message.region.height:message.height;
            dustCtx.putImageData(new ImageData(message.pixels,dustSurface.width,dustSurface.height),0,0); draw();
          }
          if(state.dustPending) { state.dustPending=false; requestDust(); }
          else $('dustBusy').hidden=true;
        } else if(message.type==='progress') { const job=state.jobs.get(message.id); if(job) job.progress(message.progress); }
        else if(message.type==='encoded' || message.type==='error') {
          const job=state.jobs.get(message.id);
          if(job) { state.jobs.delete(message.id); message.type==='error' ? job.reject(new Error(message.message)) : job.resolve(message.bytes); }
          else if(message.type==='error') { state.dustInFlight=false; $('dustBusy').hidden=true; toast(message.message,true); }
        }
      };
      state.worker.onerror=()=> {
        const failure = new Error('浏览器图像线程意外停止，请重试保存。');
        for (const job of state.jobs.values()) job.reject(failure);
        state.jobs.clear(); state.worker.terminate(); state.worker=null; state.dustInFlight=false; state.dustPending=false;
        $('dustBusy').hidden=true; toast('已切换到兼容模式，图像处理可能需要更长时间。'); requestDust();
      };
    } catch (_) { state.worker=null; }
  }
  createWorker();
  function loadWorker() {
    state.renderId++;
    if(state.worker && state.doc) state.worker.postMessage({type:'load',token:entry().id,pixels:state.doc.pixels,width:state.doc.width,height:state.doc.height});
  }
  function patchWorker(tiles) {
    if(!state.worker || !state.doc) return;
    const patches=tiles.map(tile=>({x:tile.x,y:tile.y,w:tile.w,h:tile.h,data:state.doc.readRect(tile.x,tile.y,tile.w,tile.h)}));
    state.worker.postMessage({type:'patch',token:entry().id,tiles:patches},patches.map(tile=>tile.data.buffer));
  }
  function scheduleDust(delay=70,invalidate=true) {
    if(invalidate) state.renderId++;
    // Throttle rather than debounce: continuous brush motion must still produce
    // diagnostic frames, and intermediate pixel revisions remain useful.
    if(state.dustTimer!==null) return;
    state.dustTimer=setTimeout(()=>{ state.dustTimer=null; requestDust(); },delay); $('dustBusy').hidden=!state.doc;
  }
  function requestDust() {
    if(!state.doc) { $('dustBusy').hidden=true; return; }
    if(!state.compare && !state.dustOnly) { $('dustBusy').hidden=true; return; }
    if(state.dustInFlight) { state.dustPending=true; return; }
    const d=state.doc, scale=Math.min(1, Math.max(0.02,d.view.zoom));
    const width=Math.max(1,Math.round(d.width*scale)), height=Math.max(1,Math.round(d.height*scale));
    let region=null;
    if(Math.max(width,height)>2600) {
      const size=paneSize(),[ox,oy]=origin(size.width,size.height),sx=d.width*d.view.zoom/width,sy=d.height*d.view.zoom/height;
      const x=clamp(Math.floor(-ox/sx)-4,0,width-1),y=clamp(Math.floor(-oy/sy)-4,0,height-1);
      const right=clamp(Math.ceil((size.width-ox)/sx)+4,x+1,width),bottom=clamp(Math.ceil((size.height-oy)/sy)+4,y+1,height);
      region={x,y,width:right-x,height:bottom-y};
    }
    const message={type:'dust',token:entry().id,id:state.renderId,width,height,region,settings:{...settings}};
    $('dustBusy').hidden=false;
    if(state.worker) { state.dustInFlight=true; state.worker.postMessage(message); }
    else {
      try {
        const pixels=region?DustCore.dustRegion(d.pixels,d.width,d.height,width,height,region,settings):DustCore.dustPreview(d.pixels,d.width,d.height,width,height,settings);
        state.dustRegion=region?{...region,fullWidth:width,fullHeight:height}:null;
        dustSurface.width=region?region.width:width; dustSurface.height=region?region.height:height; dustCtx.putImageData(new ImageData(pixels,dustSurface.width,dustSurface.height),0,0); draw();
      } catch(error) { toast('Dust 预览失败：'+error.message,true); }
      $('dustBusy').hidden=true;
    }
  }
  async function decode(item, wantDocument=true) {
    const bytes=new Uint8Array(await item.file.arrayBuffer()), info=DustJPEG.inspect(bytes);
    if(info.width*info.height>80000000) throw new Error('照片超过 8000 万像素，请使用桌面版处理。');
    const blob=new Blob([info.decodeBytes],{type:'image/jpeg'});
    let bitmap;
    if(typeof createImageBitmap==='function') {
      const oriented=info.orientation>=5&&info.orientation<=8,ow=oriented?info.height:info.width,oh=oriented?info.width:info.height,ratio=Math.min(1,160/ow,106/oh);
      bitmap=wantDocument?await createImageBitmap(blob,{imageOrientation:'none',colorSpaceConversion:'none'}):await createImageBitmap(item.file,{imageOrientation:'from-image',colorSpaceConversion:'default',resizeWidth:Math.max(1,Math.round(ow*ratio)),resizeHeight:Math.max(1,Math.round(oh*ratio)),resizeQuality:'high'});
    }
    else {
      const url=URL.createObjectURL(blob);
      try { bitmap=await new Promise((resolve,reject)=> { const image=new Image(); image.onload=()=>resolve(image); image.onerror=()=>reject(new Error('浏览器无法解码此 JPEG。')); image.src=url; }); }
      finally { URL.revokeObjectURL(url); }
    }
    try {
      if(wantDocument&&(bitmap.width!==info.width || bitmap.height!==info.height)) throw new Error('浏览器解码后的尺寸与原图不一致。');
      item.info=info; delete item.info.decodeBytes;
      if(!item.thumbnail&&!wantDocument) {
        const small=document.createElement('canvas'), ratio=Math.min(1,160/bitmap.width,106/bitmap.height);
        small.width=Math.max(1,Math.round(bitmap.width*ratio)); small.height=Math.max(1,Math.round(bitmap.height*ratio));
        small.getContext('2d').drawImage(bitmap,0,0,small.width,small.height); item.thumbnail=small.toDataURL('image/jpeg',0.8);
        small.width=small.height=1;
      }
      if(!wantDocument) return null;
      const surface=document.createElement('canvas'); surface.width=bitmap.width; surface.height=bitmap.height;
      const context=surface.getContext('2d',{willReadFrequently:true,colorSpace:'srgb'}); context.drawImage(bitmap,0,0);
      const doc=new PhotoDocument(info.width,info.height,context.getImageData(0,0,info.width,info.height).data);
      surface.width=surface.height=1; doc.brush=readBrush(); return doc;
    } finally { if(bitmap.close) bitmap.close(); }
  }
  const getDocument=async item=> await cacheGet(item) || await decode(item);
  let thumbnailQueue=[],thumbnailRunning=false;
  async function loadThumbnails() {
    if(thumbnailRunning)return;thumbnailRunning=true;
    try{
      while(thumbnailQueue.length&&!disposed){
        const item=thumbnailQueue.shift();if(!state.entries.includes(item)||item.thumbnail)continue;
        try{await decode(item,false);const tile=Array.from($('thumbnails').children).find(node=>node.dataset.id===item.id);if(tile&&state.entries.includes(item))tile.querySelector('img').src=item.thumbnail;}catch(_){/* The current document reports decode failures; thumbnails remain empty. */}
        await yieldUI();
      }
    }finally{thumbnailRunning=false;}
  }
  async function importFiles(files) {
    if(state.busy || (state.doc && state.doc.stroke) || hasDialog()) return;
    setBusy(true); const errors=[],added=[],candidates=[];
    try {
      for(const file of files) {
        if(!/\.jpe?g$|\.jpe$/i.test(file.name) && file.type!=='image/jpeg') { errors.push(file.name+'：只支持 JPEG'); continue; }
        const existing=state.entries.find(item=>item.file.name===file.name && item.file.size===file.size && item.file.lastModified===file.lastModified);
        if(existing) { candidates.push(existing); continue; }
        const item={id:session+'-'+Math.random().toString(36).slice(2),file,checked:true,dirty:false,cached:false,memory:null,saved:false};
        state.entries.push(item);added.push(item);candidates.push(item);thumbnailQueue.push(item);
      }
      renderThumbnails();
    } finally { setBusy(false); }
    if(candidates.length) { for(const candidate of candidates) { await switchPhoto(state.entries.indexOf(candidate),false); if(entry()===candidate) break; if(candidate.error)errors.push(candidate.file.name+'：'+candidate.error); } }
    else updateUI();
    if(entry()) status(entry().file.name);
    if(errors.length) showResult('部分照片未能导入',errors);
    loadThumbnails();
    $('fileInput').value='';
  }
  async function switchPhoto(index,reportError=true) {
    if(state.busy || (state.doc && state.doc.stroke) || index<0 || index>=state.entries.length || index===state.index) return;
    setBusy(true); const target=state.entries[index]; status('正在打开 '+target.file.name+'…');
    try {
      const next=await getDocument(target);
      if(state.doc && entry()) { syncEntry(); await cachePut(entry(),state.doc); }
      state.index=index; state.doc=next; state.pointer=null; state.source=null; target.error='';
      normalSurface.width=next.width; normalSurface.height=next.height;
      ctx.putImageData(new ImageData(next.pixels,next.width,next.height),0,0);
      dustSurface.width=dustSurface.height=1; state.dustRegion=null; $('emptyState').hidden=true;
      next.brush=readBrush(); state.sourceLabel=next.source?'已取样':'Alt 单击取样'; updateUI(); updateLayout(); resizeCanvases();
      if(!next.view.zoom || next.view.fit) fit(); else draw();
      loadWorker(); scheduleDust(0); renderThumbnails(); updatePhotoInfo();
      status(target.file.name);
    } catch(error) { target.error=error.message; renderThumbnails(); if(reportError)toast('无法打开照片：'+error.message,true); }
    finally { setBusy(false); updateUI(); }
  }
  function setBusy(value) { state.busy=value; document.body.classList.toggle('busy',value); updateUI(); }
  function syncEntry() { if(entry() && state.doc) { entry().dirty=state.doc.dirty; entry().saved=state.doc.savedRevision!==0 || entry().saved; } }
  function updateUI() {
    syncEntry(); const d=state.doc, locked=state.busy||!!(d&&d.stroke), selected=state.entries.filter(item=>item.checked).length;
    document.body.classList.toggle('no-photo',!d);
    $('saveButton').disabled=!d||locked; $('batchButton').disabled=!selected||locked;
    $('openButton').disabled=locked; $('emptyOpenButton').disabled=locked;
    $('undoButton').disabled=!d||locked||!d.undoStack.length; $('redoButton').disabled=!d||locked||!d.redoStack.length;
    $('resetButton').disabled=!d||locked;
    $('selectionText').textContent='已选 '+selected;
    $('selectAll').checked=!!selected&&selected===state.entries.length;
    $('selectAll').indeterminate=selected>0&&selected<state.entries.length;
    $('selectAll').disabled=locked;
    for (const input of $('thumbnails').querySelectorAll('input,button')) input.disabled=locked;
    $('photoIndex').textContent=state.entries.length ? (state.index+1)+' / '+state.entries.length : '0 / 0';
    $('previousButton').disabled=locked||state.index<=0; $('nextButton').disabled=locked||state.index>=state.entries.length-1;
    for(const id of ['zoomIn','zoomOut','zoomInput','fitButton']) $(id).disabled=!d||locked;
    for(const input of $('editingControls').querySelectorAll('input')) input.disabled=!d||state.busy;
    $('compareButton').disabled=locked; $('dustToggle').disabled=!d||state.compare||state.busy; $('dustPanelToggle').disabled=!d||state.compare||state.busy;
    $('sourceHint').textContent=d&&d.source ? (state.sourceLabel||'已取样') : 'Alt 单击取样';
    $('sourceHint').classList.toggle('ready',!!(d&&d.source));
    $('saveSummary').textContent=(state.saveMode==='directory'&&state.directory?state.directory.name:'下载目录')+' · '+state.suffix+'.jpg';
    if(d) $('zoomInput').value=Math.round(d.view.zoom*100);
    document.title=(entry() && entry().dirty?'● ':'')+(entry()?entry().file.name+' — ':'')+'JetPhotos Dust Lab';
    document.dispatchEvent(new CustomEvent('dust:statechange'));
  }
  function renderThumbnails() {
    syncEntry(); const host=$('thumbnails'); host.replaceChildren();
    for(let index=0;index<state.entries.length;index++) {
      const item=state.entries[index], tile=document.createElement('div'); tile.className='thumbnail'+(index===state.index?' active':''); tile.dataset.id=item.id;
      const open=document.createElement('button'); open.type='button'; open.className='thumb-open'; open.title=item.file.name+(item.dirty?' · 有未保存修改':''); open.setAttribute('aria-label','打开 '+item.file.name);
      const img=document.createElement('img'); if(item.thumbnail) img.src=item.thumbnail; img.alt='';
      const name=document.createElement('span'); name.className='thumb-name'; name.textContent=(item.error?'! ':item.dirty?'● ':item.saved?'✓ ':'')+item.file.name;
      open.append(img,name); open.onclick=()=>switchPhoto(index); tile.append(open);
      const check=document.createElement('input'); check.type='checkbox'; check.className='thumb-check'; check.checked=item.checked; check.disabled=state.busy; check.setAttribute('aria-label','选择 '+item.file.name);
      check.onchange=()=>{ item.checked=check.checked; updateUI(); }; tile.append(check);
      const close=document.createElement('button'); close.type='button'; close.className='thumb-close'; close.textContent='×'; close.title='关闭这张照片'; close.setAttribute('aria-label','关闭 '+item.file.name); close.onclick=()=>closePhoto(index); tile.append(close);
      tile.addEventListener('contextmenu',event=>{ event.preventDefault(); if(!state.busy&&!(state.doc&&state.doc.stroke)&&window.DustDesktop) window.DustDesktop.thumbnailMenu(index,event.clientX,event.clientY); });
      host.append(tile);
    }
    $('filmstrip').hidden=!state.entries.length||!state.filmstrip; updateUI();
    const active=host.querySelector('.active'); if(active) active.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function updatePhotoInfo() {
    if(!entry()) { $('fileName').textContent='尚未导入'; $('fileMeta').textContent=''; $('cameraInfo').textContent=''; return; }
    const item=entry(), info=item.info;
    $('fileName').textContent=item.file.name; $('fileName').title=item.file.name;
    $('fileMeta').textContent=info.width+' × '+info.height+' · '+(item.file.size/1048576).toFixed(1)+' MB';
    $('cameraInfo').textContent=[info.exif[271],info.exif[272]].filter(Boolean).join(' ');
  }
  function readBrush() { return {size:Number($('brushSize').value),hardness:Number($('hardness').value),opacity:Number($('opacity').value),aligned:$('aligned').checked}; }
  function updateRange(name) {
    $(name+'Number').value=$(name).value;
    const ratio=(Number($(name).value)-Number($(name).min))/(Number($(name).max)-Number($(name).min)),wrapper=$(name).closest('.value-slider');
    wrapper.style.setProperty('--fill',(ratio*100)+'%');wrapper.style.setProperty('--thumb-left',(7+Math.max(1,wrapper.getBoundingClientRect().width-14)*ratio)+'px');
  }
  function readSettings() { settings.strength=Number($('strength').value); settings.detail=Number($('detail').value)/100; settings.radius=Number($('radius').value); settings.color=$('color').checked; }
  function applyBrushControls(brush) {
    for(const [id,key] of [['brushSize','size'],['hardness','hardness'],['opacity','opacity']]) { $(id).value=brush[key]; updateRange(id); }
    $('aligned').checked=brush.aligned;
  }
  for(const name of ['brushSize','hardness','opacity','strength','detail','radius']) {
    updateRange(name);
    const change=()=> {
      updateRange(name); readSettings(); if(state.doc) state.doc.brush=readBrush();
      if(['strength','detail','radius'].includes(name)) scheduleDust(100); else draw(); persist();
    };
    $(name).addEventListener('input',change);
    let dragging=false;
    const fromPosition=event=>{const r=$(name).getBoundingClientRect(),ratio=clamp((event.clientX-r.left-7)/Math.max(1,r.width-14),0,1);$(name).value=DustCore.roundEven(Number($(name).min)+ratio*(Number($(name).max)-Number($(name).min)));$(name).dispatchEvent(new Event('input'));};
    $(name).addEventListener('pointerdown',event=>{if(event.button!==0||$(name).disabled)return;event.preventDefault();$(name).focus({preventScroll:true});$(name).setPointerCapture(event.pointerId);dragging=true;$(name).closest('.value-slider').classList.add('dragging');fromPosition(event);});
    $(name).addEventListener('pointermove',event=>{if(dragging)fromPosition(event);});
    const release=()=>{dragging=false;$(name).closest('.value-slider').classList.remove('dragging');};$(name).addEventListener('pointerup',release);$(name).addEventListener('pointercancel',release);
    $(name).addEventListener('wheel',event=>{if(document.activeElement===$(name)){event.preventDefault();$(name).value=clamp(Number($(name).value)+(event.deltaY<0?1:-1),Number($(name).min),Number($(name).max));$(name).dispatchEvent(new Event('input'));}},{passive:false});
    const numberChange=commit=>{ const field=$(name+'Number'),value=Number(field.value); if(!commit&&(field.value===''||value<Number($(name).min))) return; $(name).value=Number.isFinite(value)?clamp(value,Number($(name).min),Number($(name).max)):Number($(name).value); change(); };
    $(name+'Number').addEventListener('input',()=>numberChange(false)); $(name+'Number').addEventListener('change',()=>numberChange(true));
  }
  $('aligned').onchange=()=>{ if(state.doc) { state.doc.brush.aligned=$('aligned').checked; if(!$('aligned').checked) state.doc.offset=null; } persist(); draw(); };
  $('color').onchange=()=>{ readSettings(); scheduleDust(); persist(); };
  readSettings();
  for(const panel of document.querySelectorAll('.panel')) {
    panel.addEventListener('toggle',persist);
  }
  function updateLayout() {
    document.body.classList.toggle('single',!state.compare||!state.doc);
    $('compareButton').checked=state.compare; $('dustToggle').checked=state.dustOnly;
    $('dustControl').hidden=state.compare||!state.doc; $('dustPanelToggle').hidden=state.compare;
    $('dustPanelToggle').setAttribute('aria-pressed',String(state.dustOnly));
    $('normalTitle').textContent=!state.compare&&state.dustOnly?'DUST VIEW':'原色';
    $('filmstrip').hidden=!state.entries.length||!state.filmstrip;
  }
  function resizeCanvases() {
    const dpr=Math.min(2,window.devicePixelRatio||1);
    canvases.forEach(canvas=> { const rect=canvas.parentElement.getBoundingClientRect(); canvas.width=Math.max(1,Math.round(rect.width*dpr)); canvas.height=Math.max(1,Math.round(rect.height*dpr)); });
    for(const name of ['brushSize','hardness','opacity','strength','detail','radius']) updateRange(name);
    if(state.doc && state.doc.view.fit) fit(); else draw();
  }
  function paneSize() {
    const rect=canvases[0].getBoundingClientRect(); return {width:rect.width,height:rect.height};
  }
  function origin(width,height) {
    const d=state.doc; return [(width-d.width*d.view.zoom)/2+d.view.x,(height-d.height*d.view.zoom)/2+d.view.y];
  }
  function fit() {
    if(!state.doc||state.doc.stroke) return; const size=paneSize(), d=state.doc;
    if(size.width<5 || size.height<5) return;
    const sizes=(state.compare?canvases:[canvases[0]]).map(c=>{ const r=c.getBoundingClientRect(); return {width:r.width,height:r.height}; });
    d.view.zoom=DustInteraction.fitScale(d.width,d.height,sizes); d.view.x=d.view.y=0; d.view.fit=true;
    updateUI(); draw(); scheduleDust(80);
  }
  function setZoom(value,anchor) {
    if(!state.doc||state.doc.stroke) return; const d=state.doc;
    d.view=DustInteraction.zoomAt(d.view,d.width,d.height,paneSize(),value,anchor); draw(); updateUI(); scheduleDust(24);
  }
  function constrainPan() {
    // Qt permits free panning, including moving the photograph out of view.
  }
  function draw() {
    if(state.frame) return;
    state.frame=requestAnimationFrame(()=>{ state.frame=null; paint(); });
  }
  function paint() {
    for(let index=0;index<2;index++) {
      const canvas=canvases[index], context=contexts[index], rect=canvas.getBoundingClientRect(), width=rect.width,height=rect.height;
      if(!width||!height) continue;
      context.setTransform(canvas.width/width,0,0,canvas.height/height,0,0); context.clearRect(0,0,width,height);
      if(!state.doc) continue;
      const d=state.doc, zoom=d.view.zoom,[ox,oy]=origin(width,height),isDust=index===1||(!state.compare&&state.dustOnly), surface=isDust?dustSurface:normalSurface;
      if(surface.width>1) {
        context.imageSmoothingEnabled=zoom<1; context.imageSmoothingQuality='high';
        if(isDust&&state.dustRegion) {
          const region=state.dustRegion,sx=d.width*zoom/region.fullWidth,sy=d.height*zoom/region.fullHeight;
          context.drawImage(surface,ox+region.x*sx,oy+region.y*sy,region.width*sx,region.height*sy);
        } else context.drawImage(surface,ox,oy,d.width*zoom,d.height*zoom);
        context.strokeStyle='#3b3c40'; context.lineWidth=1; context.strokeRect(ox,oy,d.width*zoom,d.height*zoom);
      }
      if(state.pointer) {
        const x=ox+state.pointer.x*zoom,y=oy+state.pointer.y*zoom,r=d.brush.size*zoom/2;
        context.beginPath(); context.arc(x,y,r,0,Math.PI*2); context.strokeStyle='#000000be'; context.lineWidth=3; context.stroke(); context.strokeStyle='#ffffffe1'; context.lineWidth=1; context.stroke();
        if(r*d.brush.hardness/100<r-2) { context.beginPath(); context.arc(x,y,r*d.brush.hardness/100,0,Math.PI*2); context.setLineDash([1,2]); context.strokeStyle='#ffffff4b'; context.stroke(); context.setLineDash([]); }
      }
      if(d.source&&state.pointer) {
        const source=d.offset?[state.pointer.x+d.offset[0],state.pointer.y+d.offset[1]]:d.source;
        if(source[0]<0||source[1]<0||source[0]>=d.width||source[1]>=d.height) continue;
        const sx=ox+source[0]*zoom,sy=oy+source[1]*zoom;
        context.beginPath(); context.moveTo(sx-8,sy); context.lineTo(sx+8,sy); context.moveTo(sx,sy-8); context.lineTo(sx,sy+8); context.strokeStyle='#000000d2'; context.lineWidth=3; context.stroke(); context.strokeStyle='#e5ae42'; context.lineWidth=1.5; context.stroke();
      }
    }
  }
  function pointFromEvent(event,canvas) {
    const rect=canvas.getBoundingClientRect(),[ox,oy]=origin(rect.width,rect.height),zoom=state.doc.view.zoom;
    return {x:(event.clientX-rect.left-ox)/zoom,y:(event.clientY-rect.top-oy)/zoom,alt:event.altKey};
  }
  function inside(p) { return p.x>=0&&p.y>=0&&p.x<state.doc.width&&p.y<state.doc.height; }
  function updatePixelStatus() {
    if(!state.doc||!state.pointer){$('pixelInfo').textContent='X —   Y —   RGB —';return;}
    const x=Math.floor(state.pointer.x),y=Math.floor(state.pointer.y),i=(y*state.doc.width+x)*4,p=state.doc.pixels;
    $('pixelInfo').textContent='X '+x.toLocaleString('en-US')+'   Y '+y.toLocaleString('en-US')+'   RGB '+p[i]+' '+p[i+1]+' '+p[i+2];
  }
  function syncPixels(tiles) {
    if(!state.doc) return;
    if(tiles && tiles.length) {
      for(const tile of tiles) ctx.putImageData(new ImageData(state.doc.readRect(tile.x,tile.y,tile.w,tile.h),tile.w,tile.h),tile.x,tile.y);
      patchWorker(tiles);
    } else { ctx.putImageData(new ImageData(state.doc.pixels,state.doc.width,state.doc.height),0,0); loadWorker(); }
    draw(); scheduleDust(55,!tiles||!tiles.length);
  }
  function finishGesture(cancel=false) {
    if(state.doc&&state.doc.stroke) {
      const tiles=state.doc.strokeTiles(),changed=state.doc.endStroke(cancel); if(!state.doc.brush.aligned) state.doc.offset=null;
      syncPixels(tiles); renderThumbnails(); if(cancel) status('已取消当前笔划'); else if(changed) status('已修复');
    }
    state.gesture=null; state.touches.clear();canvases.forEach(c=>c.style.cursor='default'); updateUI();
  }
  for(const canvas of canvases) {
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    canvas.addEventListener('pointerdown',event=>{
      if(!state.doc||state.busy||hasDialog()) return;
      event.preventDefault(); canvas.focus({preventScroll:true});
      const point=pointFromEvent(event,canvas); state.pointer=point;
      if(event.pointerType==='touch') {
        state.touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
        if(state.touches.size===2) {
          if(state.doc.stroke) { const tiles=state.doc.strokeTiles(); state.doc.endStroke(true); syncPixels(tiles); }
          const [a,b]=Array.from(state.touches.values()); state.gesture={mode:'pinch',distance:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};
          canvas.setPointerCapture(event.pointerId); return;
        }
      }
      if(event.button===1 || state.space) { state.gesture={mode:'pan',x:event.clientX,y:event.clientY}; canvas.style.cursor='grabbing';canvas.setPointerCapture(event.pointerId); return; }
      if(event.altKey || event.button===2) {
        if(inside(point)) { state.doc.setSource(point.x,point.y); state.sourceLabel='取样 '+Math.floor(point.x)+', '+Math.floor(point.y); updateUI(); draw(); status('已设置仿制源点'); } return;
      }
      if(event.button!==0 || !inside(point)) return;
      if(!state.doc.beginStroke(point.x,point.y)) { status('先按住 Alt 单击，或右键单击天空，设置取样点'); return; }
      state.gesture={mode:'paint',pointer:event.pointerId}; canvas.setPointerCapture(event.pointerId); syncPixels(state.doc.strokeTiles()); updateUI();
    });
    canvas.addEventListener('pointermove',event=>{
      if(!state.doc||state.busy) return;
      if(state.touches.has(event.pointerId)) state.touches.set(event.pointerId,{x:event.clientX,y:event.clientY});
      const gesture=state.gesture;
      if(gesture&&gesture.mode==='pinch'&&state.touches.size===2) {
        const [a,b]=Array.from(state.touches.values()),x=(a.x+b.x)/2,y=(a.y+b.y)/2,distance=Math.hypot(a.x-b.x,a.y-b.y),rect=canvas.getBoundingClientRect();
        setZoom(state.doc.view.zoom*distance/Math.max(1,gesture.distance),{x:x-rect.left,y:y-rect.top});
        state.doc.view.x+=x-gesture.x; state.doc.view.y+=y-gesture.y; gesture.distance=distance; gesture.x=x; gesture.y=y; draw(); return;
      }
      const point=pointFromEvent(event,canvas); state.pointer=inside(point)?point:null;
      if(gesture&&gesture.mode==='pan') {
        state.doc.view.x+=event.clientX-gesture.x; state.doc.view.y+=event.clientY-gesture.y;
        gesture.x=event.clientX; gesture.y=event.clientY; state.doc.view.fit=false; constrainPan();const hover=pointFromEvent(event,canvas);state.pointer=inside(hover)?hover:null;updatePixelStatus();draw(); if(state.dustRegion) scheduleDust(80); return;
      }
      if(gesture&&gesture.mode==='paint'&&gesture.pointer===event.pointerId&&state.pointer) { state.doc.continueStroke(state.pointer.x,state.pointer.y); syncPixels(state.doc.strokeTiles()); }
      updatePixelStatus();
      draw();
    });
    canvas.addEventListener('pointerup',event=>{
      if(canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      state.touches.delete(event.pointerId);
      if(state.gesture&&state.gesture.mode==='pinch'&&state.touches.size) { state.gesture={mode:'touch-end'}; return; }
      finishGesture();
    });
    canvas.addEventListener('pointercancel',()=>finishGesture(true));
    canvas.addEventListener('lostpointercapture',event=>{ if(state.gesture&&state.gesture.mode==='paint'&&state.gesture.pointer===event.pointerId) finishGesture(); });
    canvas.addEventListener('pointerleave',()=>{ if(!state.gesture) { state.pointer=null; draw(); $('pixelInfo').textContent='X —   Y —   RGB —'; } });
    canvas.addEventListener('wheel',event=>{
      if(!state.doc||state.busy||hasDialog()) return; event.preventDefault(); if(state.doc.stroke) return;
      const factor=event.deltaMode===1?18:event.deltaMode===2?300:1,rect=canvas.getBoundingClientRect();
      if(event.ctrlKey||event.metaKey) setZoom(state.doc.view.zoom*DustInteraction.wheelFactor(event.deltaY,event.deltaMode),{x:event.clientX-rect.left,y:event.clientY-rect.top});
      else { const dx=event.shiftKey&&!event.deltaX?event.deltaY:event.deltaX,dy=event.shiftKey&&!event.deltaX?0:event.deltaY; state.doc.view.x-=dx*factor; state.doc.view.y-=dy*factor; state.doc.view.fit=false; constrainPan(); draw(); if(state.dustRegion) scheduleDust(100); }
      const point=pointFromEvent(event,canvas);state.pointer=inside(point)?point:null;updatePixelStatus();draw();
    },{passive:false});
  }
  window.addEventListener('blur',()=>{ state.space=false; finishGesture(); });
  document.addEventListener('visibilitychange',()=>{ if(document.hidden) { state.space=false; finishGesture(); } });
  function historyAction(action) {
    if(!state.doc||state.busy||state.doc.stroke) return;
    if(state.doc[action]()) { syncPixels(); renderThumbnails(); updateUI(); }
  }
  function confirmAction(title,text,save=true) {
    finishGesture(); $('confirmTitle').textContent=title; $('confirmText').textContent=text;
    $('confirmSave').hidden=!save; $('confirmSave').textContent='保存'; $('confirmDiscard').hidden=false; $('confirmCancel').textContent='取消'; $('confirmDiscard').textContent=save?'不保存':'还原';
    $('confirmDialog').showModal();
    return new Promise(resolve=>{
      const dialog=$('confirmDialog');
      const finish=value=>{ dialog.close(); dialog.oncancel=null; resolve(value); };
      dialog.querySelector('.dialog-close').onclick=()=>finish('cancel');
      $('confirmCancel').onclick=()=>finish('cancel'); $('confirmDiscard').onclick=()=>finish('discard'); $('confirmSave').onclick=()=>finish('save');
      dialog.oncancel=event=>{ event.preventDefault(); finish('cancel'); };
    });
  }
  async function closePhoto(index) {
    if(state.busy||(state.doc&&state.doc.stroke)||index<0||index>=state.entries.length||hasDialog()) return; syncEntry();
    const item=state.entries[index];
    if(item.dirty) {
      const answer=await confirmAction('尚未保存','1 张照片有未保存的修改。\n保存修改后再关闭？');
      if(answer==='cancel') return;
      if(answer==='save' && !await exportPhotos([item])) return;
    }
    if(index===state.index && state.entries.length>1) {
      const candidates=[...state.entries.keys()].slice(index+1).concat([...state.entries.keys()].slice(0,index).reverse());
      for(const candidate of candidates) { await switchPhoto(candidate,false); if(entry()!==item) break; }
      if(entry()===item) { showResult('无法切换照片',['其他照片暂时无法打开，当前照片已保留。']); return; }
    }
    cacheDelete(item); state.entries.splice(index,1);
    if(state.index>index) state.index--;
    if(!state.entries.length) {
      state.index=-1; state.doc=null; state.pointer=null; state.renderId++;
      if(state.worker) state.worker.postMessage({type:'clear'});
      normalSurface.width=normalSurface.height=dustSurface.width=dustSurface.height=1;
      $('emptyState').hidden=false; updatePhotoInfo(); status('就绪'); draw();
    }
    renderThumbnails(); updateLayout(); resizeCanvases(); if(state.entries.length) status('已关闭 '+item.file.name);
  }
  async function closeBatch() {
    if(state.busy||(state.doc&&state.doc.stroke)||hasDialog()) return false;
    syncEntry(); const dirty=state.entries.filter(item=>item.dirty);
    if(dirty.length) {
      const promise=confirmAction('尚未保存',dirty.length+' 张照片有未保存的修改。\n保存修改后再关闭？');
      $('confirmSave').textContent=dirty.length===1?'保存':'全部保存';
      const answer=await promise; if(answer==='cancel') return false;
      if(answer==='save'&&!await exportPhotos(dirty)) return false;
    }
    for(const item of state.entries) cacheDelete(item);
    state.entries=[];thumbnailQueue=[];state.index=-1;state.doc=null;state.pointer=null;state.sourceLabel='Alt 单击取样';state.renderId++;
    if(state.worker) state.worker.postMessage({type:'clear'});
    normalSurface.width=normalSurface.height=dustSurface.width=dustSurface.height=1;
    $('emptyState').hidden=false; updatePhotoInfo();renderThumbnails();updateLayout();resizeCanvases();status('就绪');return true;
  }
  async function resetPhoto() {
    if(!state.doc||state.busy||state.doc.stroke) return; const item=entry();
    if(state.doc.dirty) { const answer=await confirmAction('还原所有修改','确定丢弃全部仿制笔划并恢复到刚导入的照片吗？',false); if(answer!=='discard') return; }
    setBusy(true);
    try {
      const previous=state.doc, fresh=await decode(item); fresh.brush=previous.brush; fresh.view=previous.view;
      // A saved edited export differs from the restored source.
      fresh.savedRevision=previous.savedRevision===0?0:-1;
      state.doc=fresh; state.sourceLabel='Alt 单击取样'; cacheDelete(item); syncPixels(); renderThumbnails(); updateUI();
      status('已恢复到导入状态');
    } catch(error) { toast(error.message,true); }
    finally { setBusy(false); }
  }
  function outputName(item) { return DustInteraction.outputName(item.file.name,state.suffix); }
  function uniqueName(name,used) {
    let candidate=name,index=2; while(used.has(candidate.toLocaleLowerCase())) candidate=name.replace(/\.jpg$/i,'_'+index+++'.jpg');
    used.add(candidate.toLocaleLowerCase()); return candidate;
  }
  async function directoryName(name,used) {
    let candidate=uniqueName(name,used),index=2;
    while(true) {
      try { await state.directory.getFileHandle(candidate); candidate=uniqueName(name.replace(/\.jpg$/i,'_'+index+++'.jpg'),used); }
      catch(error) { if(error.name==='NotFoundError') return candidate; throw error; }
    }
  }
  const yieldUI=()=>new Promise(resolve=>setTimeout(resolve,0));
  async function encodeDocument(item,doc,progress) {
    if(state.worker) {
      const id=++state.nextJob;
      return new Promise((resolve,reject)=>{
        state.jobs.set(id,{resolve,reject,progress});
        state.worker.postMessage({type:'encode',id,width:doc.width,height:doc.height,pixels:doc.pixels,metadata:item.info.metadata});
      });
    }
    await yieldUI(); return DustJPEG.encode(doc.pixels,doc.width,doc.height,item.info.metadata,progress);
  }
  function download(blob,name) {
    const url=URL.createObjectURL(blob),link=document.createElement('a'); link.href=url; link.download=name; document.body.append(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  async function exportPhotos(items,options={}) {
    if(state.busy||(state.doc&&state.doc.stroke)||!items.length) return false;
    if(state.saveMode==='directory'&&!options.handle) {
      if(!state.directory) { openSettings(); toast('请先选择用于保存的本地文件夹。'); return false; }
      try {
        const permission=await state.directory.requestPermission({mode:'readwrite'});
        if(permission!=='granted') { toast('未获得所选文件夹的写入权限，请使用本地下载方式。',true); return false; }
      } catch(error) { toast(error.message,true); return false; }
    }
    setBusy(true); const job={cancelled:false,completed:0},results=[],failures=[],used=new Set(state.entries.map(item=>item.file.name.toLocaleLowerCase())); state.export=job;
    const batch=options.batch||items.length>1;
    $('progressTitle').textContent=batch?'保存所选':'保存'; $('progressBar').value=0; $('progressText').textContent='准备保存…'; $('cancelExport').disabled=false; $('cancelExport').textContent='取消'; if(batch)$('progressDialog').showModal();
    const savedItems=[];
    try {
      for(let i=0;i<items.length;i++) {
        if(job.cancelled) break;
        const item=items[i]; $('progressText').textContent=(i+1)+' / '+items.length+' · '+item.file.name;
        $('progressDetail').textContent='正在本地编码原色 JPEG，保留原始元数据…'; await yieldUI();
        try {
          const doc=item===entry()?state.doc:await getDocument(item), revision=doc.revision;
          const bytes=await encodeDocument(item,doc,progress=>{ $('progressBar').value=(i+progress)/items.length; });
          DustJPEG.verify(bytes,item.info.metadata,doc.width,doc.height);
          let name=options.filename||item.savedName||outputName(item),handle=options.handle||item.savedHandle;
          if(handle || state.saveMode==='directory') {
            if(!handle || (items.length>1&&state.entries.some(source=>source.file.name.toLowerCase()===handle.name.toLowerCase()))) {
              if(!state.directory) throw new Error('请选择输出文件夹。');
              if(item.savedName&&item.savedDirectory===state.directory) { name=item.savedName; used.add(name.toLowerCase()); }
              else name=await directoryName(name,used);
              handle=await state.directory.getFileHandle(name,{create:true});
            }
            name=handle.name; const stream=await handle.createWritable();
            try { await stream.write(bytes); await stream.close(); }
            catch(error) { try { await stream.abort(); } catch(_) { /* Preserve the actual failure. */ } throw error; }
          } else { name=uniqueName(name,used); results.push({name,bytes}); }
          savedItems.push({item,doc,revision,name,handle}); job.completed++;
          $('progressBar').value=(i+1)/items.length;
        } catch(error) { item.error=error.message; failures.push(item.file.name+'：'+error.message); }
        await yieldUI();
      }
      if(results.length) {
        $('progressDetail').textContent='元数据校验通过，正在准备本地下载…'; await yieldUI();
        if(items.length===1) download(new Blob([results[0].bytes],{type:'image/jpeg'}),results[0].name);
        else download(DustJPEG.zip(results),'JetPhotos_Dust_Lab_'+new Date().toISOString().slice(0,10)+'.zip');
      }
      for(const {item,doc,revision,name,handle} of savedItems) {
        doc.savedRevision=revision; item.saved=true; item.dirty=doc.dirty; item.error='';item.savedName=name;
        if(handle) { item.savedHandle=handle;item.savedDirectory=state.directory; }
        if(item!==entry()) await cachePut(item,doc);
      }
      const verb=state.saveMode==='directory'||options.handle?'已保存':'已准备下载';
      if(job.cancelled) status('保存已取消，已完成的文件已保留');
      else if(!batch&&savedItems.length) status(verb+' '+savedItems[0].name);
      else status(state.saveMode==='directory'?'所选照片已保存':'所选照片已准备下载');
      if(failures.length) setTimeout(()=>showResult('部分照片保存失败',failures),0);
      return savedItems.length===items.length&&!failures.length&&!job.cancelled;
    } catch(error) { toast('保存失败：'+error.message,true); return false; }
    finally { state.export=null; $('progressDialog').close(); setBusy(false); renderThumbnails(); updateUI(); }
  }
  function cancelExport() {
    if(!state.export) return; state.export.cancelled=true; $('cancelExport').disabled=true; $('cancelExport').textContent='正在取消…'; $('progressDetail').textContent='当前编码完成后停止，已完成的照片仍会保存。';
  }
  $('cancelExport').onclick=cancelExport;
  $('progressDialog').addEventListener('cancel',event=>{ event.preventDefault(); cancelExport(); });
  function showResult(title,messages) {
    $('confirmTitle').textContent=title; $('confirmText').textContent=messages.join('\n'); $('confirmSave').hidden=true; $('confirmDiscard').hidden=true;
    $('confirmCancel').textContent='关闭'; $('confirmDialog').showModal();
    const close=()=>{ $('confirmDialog').close(); $('confirmDiscard').hidden=false; $('confirmCancel').textContent='取消'; $('confirmDialog').oncancel=null; };
    $('confirmCancel').onclick=close; $('confirmDialog').oncancel=event=>{ event.preventDefault(); close(); };
  }
  function openSettings() {
    if(!state.busy&&!hasDialog()&&window.DustDesktop) window.DustDesktop.openSettings();
  }
  $('settingsButton').onclick=openSettings;
  $('outputSettingsButton').onclick=openSettings;
  function showHelp() { if(state.busy||hasDialog()||(state.doc&&state.doc.stroke)) return; $('helpDialog').showModal(); }
  $('closeHelp').onclick=$('helpDone').onclick=()=>$('helpDialog').close();
  const chooseFiles=()=>{ if(!state.busy&&!(state.doc&&state.doc.stroke)&&!hasDialog()) $('fileInput').click(); };
  $('openButton').onclick=$('emptyOpenButton').onclick=chooseFiles;
  $('fileInput').onchange=()=>importFiles(Array.from($('fileInput').files));
  $('saveButton').onclick=()=>entry()&&exportPhotos([entry()]);
  $('batchButton').onclick=()=>exportPhotos(state.entries.filter(item=>item.checked),{batch:true});
  $('undoButton').onclick=()=>historyAction('undo'); $('redoButton').onclick=()=>historyAction('redo');
  $('resetButton').onclick=resetPhoto;
  $('selectAll').onchange=()=>{ if(state.busy) return; state.entries.forEach(item=>item.checked=$('selectAll').checked); renderThumbnails(); };
  $('previousButton').onclick=()=>switchPhoto(state.index-1); $('nextButton').onclick=()=>switchPhoto(state.index+1);
  function toggleCompare() { if(state.busy||(state.doc&&state.doc.stroke)) return; state.compare=!state.compare; updateLayout(); resizeCanvases(); scheduleDust(); persist(); updateUI(); status(!state.doc?'就绪':state.compare?'对照':'单视图 · D 切换 Dust'); }
  function toggleDust() { if(state.busy||!state.doc||state.compare||state.doc.stroke) return; state.dustOnly=!state.dustOnly; updateLayout(); resizeCanvases(); scheduleDust(); updateUI(); status(state.dustOnly?'Dust 查看已开启 · 诊断调色不会进入最终保存':'已返回正常色彩预览'); }
  $('compareButton').onclick=toggleCompare; $('dustToggle').onclick=toggleDust;
  $('dustPanelToggle').onclick=toggleDust;
  function actualPixels() { if(!state.doc||state.doc.stroke) return; state.doc.view={zoom:1,x:0,y:0,fit:false}; updateUI();draw();scheduleDust(24); }
  $('fitButton').onclick=fit;
  $('zoomIn').onclick=()=>state.doc&&setZoom((Math.round(state.doc.view.zoom*100)+1)/100); $('zoomOut').onclick=()=>state.doc&&setZoom((Math.round(state.doc.view.zoom*100)-1)/100);
  $('zoomInput').onchange=()=>setZoom(Number($('zoomInput').value)/100);
  let dragDepth=0;
  document.addEventListener('dragenter',event=>{ if(Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); dragDepth++; if(!state.busy&&!hasDialog()) $('dropOverlay').hidden=false; } });
  document.addEventListener('dragover',event=>{ if(Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect=state.busy?'none':'copy'; } });
  document.addEventListener('dragleave',()=>{ dragDepth=Math.max(0,dragDepth-1); if(!dragDepth) $('dropOverlay').hidden=true; });
  document.addEventListener('drop',event=>{ event.preventDefault(); dragDepth=0; $('dropOverlay').hidden=true; if(event.dataTransfer.files.length) importFiles(Array.from(event.dataTransfer.files)); });
  document.addEventListener('keydown',event=>{
    const tag=event.target.tagName;
    const key=event.key.toLowerCase(),mod=event.ctrlKey||event.metaKey;
    const editing=['SELECT','TEXTAREA'].includes(tag)||(tag==='INPUT'&&!['range','checkbox','file'].includes(event.target.type))||event.target.isContentEditable;
    if(hasDialog()) return;
    if(editing&&!(mod&&['o','s',',','enter','w'].includes(key))) return;
    if(mod&&['o','s','z','y','w',',','enter'].includes(key)) event.preventDefault();
    if(state.busy) return;
    if(mod) {
      if(key==='o') chooseFiles();
      else if(key==='s') { if(event.shiftKey&&window.DustDesktop) window.DustDesktop.saveAs(); else if(entry()) exportPhotos([entry()]); }
      else if(key==='z') historyAction(event.shiftKey?'redo':'undo');
      else if(key==='y') historyAction('redo');
      else if(key===',') openSettings();
      else if(key==='enter'&&event.shiftKey) exportPhotos(state.entries.filter(item=>item.checked),{batch:true});
      else if(key==='w') closePhoto(state.index);
      return;
    }
    if(event.altKey&&key==='arrowleft') { event.preventDefault(); switchPhoto(state.index-1); return; }
    if(event.altKey&&key==='arrowright') { event.preventDefault(); switchPhoto(state.index+1); return; }
    if(key===' '&&state.doc) { event.preventDefault(); state.space=true; canvases.forEach(c=>c.style.cursor='grab'); draw(); }
    else if(key==='c') toggleCompare();
    else if(key==='d') toggleDust();
    else if(key==='0') fit();
    else if(key==='1') actualPixels();
    else if((key==='['||key===']')&&state.doc) { event.preventDefault(); $('brushSize').value=DustInteraction.brushStep(Number($('brushSize').value),key==='['?-1:1); $('brushSize').dispatchEvent(new Event('input')); }
    else if(key==='tab'&&state.entries.length) { event.preventDefault(); state.filmstrip=!state.filmstrip; updateLayout(); resizeCanvases(); persist(); }
    else if(key==='?'||key==='f1') { event.preventDefault(); showHelp(); }
    else if(key==='escape'&&state.doc&&state.doc.stroke) { event.preventDefault(); finishGesture(true); draw(); }
  });
  document.addEventListener('keyup',event=>{ if(event.key===' ') { state.space=false; canvases.forEach(c=>c.style.cursor='default'); draw(); } });
  window.addEventListener('beforeunload',event=>{ finishGesture(); syncEntry(); if(state.entries.some(item=>item.dirty)||state.busy) { event.preventDefault(); event.returnValue=''; } });
  window.addEventListener('pagehide',event=>{
    if(event.persisted) return; disposed=true; clearTimeout(state.dustTimer); if(state.worker) state.worker.terminate();
    if(database) { const tx=database.transaction('photos','readwrite'); for(const item of state.entries) tx.objectStore('photos').delete(session+'/'+item.id); }
  });
  let resizeTimer;
  const observer=new ResizeObserver(()=>{ clearTimeout(resizeTimer); resizeTimer=setTimeout(()=>{ if(!disposed) { resizeCanvases(); scheduleDust(100); } },50); });
  observer.observe($('canvasArea'));
  window.addEventListener('resize',()=>{ clearTimeout(resizeTimer); resizeTimer=setTimeout(()=>{ resizeCanvases(); scheduleDust(100); },60); });
  function saveSettings(values){
    state.suffix=values.suffix;state.saveMode=values.saveMode;state.directory=values.directory;persist();updateUI();
    if(database&&values.directory){try{database.transaction('preferences','readwrite').objectStore('preferences').put({key:'outputDirectory',handle:values.directory});}catch(_){/* Session permission still works if a browser cannot retain the handle. */}}
  }
  window.DustApp={state,entry,open:chooseFiles,save:()=>entry()&&exportPhotos([entry()]),saveSelected:()=>exportPhotos(state.entries.filter(item=>item.checked),{batch:true}),exportPhotos,closePhoto,closeBatch,reset:resetPhoto,undo:()=>historyAction('undo'),redo:()=>historyAction('redo'),toggleCompare,toggleDust,fit,actualPixels,showHelp,status,showResult,persist,updateUI,resize:resizeCanvases,refreshDust:()=>scheduleDust(24),setSettings:saveSettings,toggleFilmstrip:()=>{if(state.busy||(state.doc&&state.doc.stroke))return;state.filmstrip=!state.filmstrip;updateLayout();resizeCanvases();persist();updateUI();},previous:()=>switchPhoto(state.index-1),next:()=>switchPhoto(state.index+1)};
  updateLayout(); updateUI(); resizeCanvases();
})();
