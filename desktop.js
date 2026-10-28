/* Desktop shell: mirrors MainWindow, PanelSection, SettingsDialog and TutorialPanel. */
(function () {
  'use strict';
  const $=id=>document.getElementById(id),app=window.DustApp,state=app.state;
  const titles={brush:'仿制图章',dust:'Dust View Setting',export:'保存',info:'照片信息'};
  const panels=()=>Array.from($('editingControls').children),locked=()=>state.busy||!!(state.doc&&state.doc.stroke);
  const popup=$('popupMenu');
  let menuOwner=null,activeMenu=null,menuItems=[],settingsDraft=null,orderSelection=0,tutorialStep=0,tutorialContext='',splitDrag=null;
  const action=(label,run,shortcut='',enabled=true,checked=null)=>({label,run,shortcut,enabled,checked});
  function menus(name) {
    const doc=!!state.doc,available=!locked(),item=app.entry();
    if(name==='file') return [action('导入…',app.open,'Ctrl+O',available),null,action('保存',app.save,'Ctrl+S',doc&&available),action('另存为…',saveAs,'Ctrl+Shift+S',doc&&available),action('保存所选',app.saveSelected,'Ctrl+Shift+Enter',state.entries.some(e=>e.checked)&&available),null,action('关闭当前照片',()=>app.closePhoto(state.index),'Ctrl+W',doc&&available),action('关闭本组照片',app.closeBatch,'',available),action('设置…',openSettings,'Ctrl+,',!state.busy),null,action('退出',async()=>{if(await app.closeBatch()){window.close();if(!window.closed)app.status('已关闭本组照片 · 可关闭此浏览器标签页');}},'Alt+F4',!state.busy)];
    if(name==='edit') return [action('撤销',app.undo,'Ctrl+Z',doc&&available&&state.doc.undoStack.length>0),action('重做',app.redo,'Ctrl+Y',doc&&available&&state.doc.redoStack.length>0),null,action('还原到导入状态',app.reset,'',doc&&available)];
    if(name==='view') return [action('对照',app.toggleCompare,'C',available,state.compare),...(doc&&!state.compare?[action('Dust 查看模式',app.toggleDust,'D',available,state.dustOnly)]:[]),null,action('适合窗口',app.fit,'0',doc&&available),action('100% 像素',app.actualPixels,'1',doc&&available),null,action('缩略图',app.toggleFilmstrip,'Tab',!state.busy,state.filmstrip),action('上一张',app.previous,'Alt+Left',available&&state.index>0),action('下一张',app.next,'Alt+Right',available&&state.index+1<state.entries.length)];
    return [action('入门引导…',showTutorial,'',!state.busy),action('快捷键…',app.showHelp,'',!state.busy),action('关于 Dust Lab',showAbout,'',!state.busy)];
  }
  function closeMenu(focus=false) {
    popup.hidden=true;activeMenu=null;
    if(menuOwner) {menuOwner.setAttribute('aria-expanded','false');if(focus)menuOwner.focus({preventScroll:true});}
    menuOwner=null;
  }
  function showMenu(items,x,y,owner=null,name=null) {
    closeMenu();menuItems=items;menuOwner=owner;activeMenu=name;popup.replaceChildren();
    if(owner)owner.setAttribute('aria-expanded','true');
    for(const item of items) {
      if(!item){const line=document.createElement('div');line.className='menu-separator';line.setAttribute('role','separator');popup.append(line);continue;}
      const button=document.createElement('button');button.type='button';button.setAttribute('role',item.checked===null?'menuitem':'menuitemcheckbox');
      button.setAttribute('aria-label',item.label);if(item.shortcut)button.setAttribute('aria-keyshortcuts',item.shortcut.replace('Ctrl','Control'));
      if(item.checked!==null)button.setAttribute('aria-checked',String(item.checked));button.disabled=!item.enabled;
      const mark=document.createElement('span'),label=document.createElement('span'),shortcut=document.createElement('span');
      mark.className='menu-check';mark.textContent=item.checked?'✓':'';mark.setAttribute('aria-hidden','true');label.textContent=item.label;shortcut.className='menu-shortcut';shortcut.textContent=item.shortcut;shortcut.setAttribute('aria-hidden','true');
      button.append(mark,label,shortcut);button.onclick=()=>{closeMenu();try{Promise.resolve(item.run()).catch(error=>app.showResult('操作未完成',[error.message]));}catch(error){app.showResult('操作未完成',[error.message]);}};popup.append(button);
    }
    popup.hidden=false;popup.style.left=Math.max(0,Math.min(x,innerWidth-popup.offsetWidth-2))+'px';popup.style.top=Math.max(0,Math.min(y,innerHeight-popup.offsetHeight-2))+'px';
    const first=popup.querySelector('button:not(:disabled)');if(first)first.focus({preventScroll:true});
  }
  function topMenu(button) {
    const rect=button.getBoundingClientRect();showMenu(menus(button.dataset.menu),rect.left,rect.bottom,button,button.dataset.menu);
  }
  for(const button of $('menuBar').querySelectorAll('button')) {
    button.onclick=()=>{if(menuOwner===button&&!popup.hidden)closeMenu();else topMenu(button);};
    button.onpointerenter=()=>{if(activeMenu&&menuOwner!==button)topMenu(button);};
  }
  document.addEventListener('pointerdown',event=>{if(!popup.hidden&&!popup.contains(event.target)&&!$('menuBar').contains(event.target))closeMenu();},true);
  document.addEventListener('keydown',event=>{
    if(!popup.hidden) {
      const items=Array.from(popup.querySelectorAll('button:not(:disabled)')),index=items.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();closeMenu(true);}
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopImmediatePropagation();items[(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
      else if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&activeMenu){event.preventDefault();event.stopImmediatePropagation();const top=Array.from($('menuBar').children),i=top.indexOf(menuOwner);topMenu(top[(i+(event.key==='ArrowRight'?1:-1)+top.length)%top.length]);}
      else if(event.key==='Home'||event.key==='End'){event.preventDefault();event.stopImmediatePropagation();items[event.key==='Home'?0:items.length-1]?.focus();}
      else if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopImmediatePropagation();document.activeElement?.click();}
      return;
    }
    if(event.altKey&&!event.ctrlKey&&!event.metaKey) {
      const name={f:'file',e:'edit',v:'view',h:'help'}[event.key.toLowerCase()];
      if(name&&!state.busy&&!document.querySelector('dialog[open]')){event.preventDefault();event.stopImmediatePropagation();topMenu($('menuBar').querySelector('[data-menu='+name+']'));}
    }
  },true);
  function movePanel(key,delta) {
    const order=panels(),from=order.findIndex(p=>p.dataset.panel===key),to=from+delta;
    if(to<0||to>=order.length)return;
    delta<0?order[to].before(order[from]):order[to].after(order[from]);app.persist();refreshTutorial(true);
  }
  for(const panel of panels()) {
    const button=panel.querySelector('.section-menu');
    button.onclick=event=>{event.preventDefault();event.stopPropagation();const r=button.getBoundingClientRect();showMenu([action('上移',()=>movePanel(panel.dataset.panel,-1)),action('下移',()=>movePanel(panel.dataset.panel,1))],r.left,r.bottom);};
    panel.addEventListener('toggle',()=>refreshTutorial(false));
  }
  function setTab(button) {
    const tabs=button.parentElement,container=tabs.parentElement,pages=container.querySelector('.tab-pages');
    for(const tab of tabs.children)tab.setAttribute('aria-selected',String(tab===button));
    for(const page of pages.children)page.hidden=page.id!==button.dataset.tab;
  }
  for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>setTab(button);
  for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>$(button.dataset.close).close();
  for(const dialog of document.querySelectorAll('dialog')) {
    const header=dialog.querySelector('.dialog-titlebar');let drag=null;
    header.onpointerdown=event=>{if(event.button!==0||event.target.closest('button'))return;const r=dialog.getBoundingClientRect();drag={x:event.clientX-r.left,y:event.clientY-r.top};header.setPointerCapture(event.pointerId);event.preventDefault();};
    header.onpointermove=event=>{if(!drag)return;dialog.style.margin='0';dialog.style.inset='auto';dialog.style.left=Math.max(0,Math.min(event.clientX-drag.x,innerWidth-dialog.offsetWidth))+'px';dialog.style.top=Math.max(0,Math.min(event.clientY-drag.y,innerHeight-dialog.offsetHeight))+'px';};
    header.onpointerup=header.onpointercancel=()=>{drag=null;};
    dialog.addEventListener('close',()=>{dialog.style.margin='';dialog.style.inset='';dialog.style.left='';dialog.style.top='';});
  }
  function renderOrder() {
    const host=$('panelOrder');host.replaceChildren();
    settingsDraft.order.forEach((key,index)=>{
      const row=document.createElement('button');row.type='button';row.textContent=titles[key];row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===orderSelection));row.draggable=true;
      row.onclick=()=>{orderSelection=index;renderOrder();};
      row.ondragstart=event=>{event.dataTransfer.setData('text/x-dust-order',String(index));event.dataTransfer.effectAllowed='move';};
      row.ondragover=event=>{if(Array.from(event.dataTransfer.types).includes('text/x-dust-order'))event.preventDefault();};
      row.ondrop=event=>{event.preventDefault();const raw=event.dataTransfer.getData('text/x-dust-order');if(raw==='')return;const from=Number(raw);if(!Number.isInteger(from)||from<0||from>=settingsDraft.order.length)return;const [key]=settingsDraft.order.splice(from,1);settingsDraft.order.splice(index,0,key);orderSelection=index;renderOrder();};
      host.append(row);
    });
  }
  function orderMove(delta) {
    const to=orderSelection+delta;if(to<0||to>=settingsDraft.order.length)return;
    const [key]=settingsDraft.order.splice(orderSelection,1);settingsDraft.order.splice(to,0,key);orderSelection=to;renderOrder();
  }
  $('orderUp').onclick=()=>orderMove(-1);$('orderDown').onclick=()=>orderMove(1);
  $('panelOrder').onkeydown=event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();orderSelection=Math.max(0,Math.min(settingsDraft.order.length-1,orderSelection+(event.key==='ArrowDown'?1:-1)));renderOrder();}};
  function settingsPreview() {
    const folder=$('saveMode').value==='directory',supported=typeof showDirectoryPicker==='function';
    $('folderDisplay').disabled=!folder;$('chooseDirectory').disabled=!folder||!supported;
    $('folderDisplay').value=settingsDraft.directory?settingsDraft.directory.name:'';
    const name=app.entry()?app.entry().file.name.replace(/\.(?:jpe?g|jpe)$/i,''):'IMG_0001';
    $('filenameExample').textContent=name+$('suffixInput').value+'.jpg';
    $('directoryHint').textContent=supported?'网页无法自动获得原照片目录；可下载到本地，或授权指定文件夹。':'此浏览器不支持指定文件夹写入；单张保存为 JPEG，批量下载为 ZIP。';
  }
  function openSettings() {
    if(state.busy||document.querySelector('dialog[open]'))return;
    closeMenu();settingsDraft={order:panels().map(p=>p.dataset.panel),directory:state.directory};orderSelection=0;
    $('saveMode').value=state.saveMode;$('suffixInput').value=state.suffix;$('settingsError').textContent='';
    $('saveMode').querySelector('[value=directory]').disabled=typeof showDirectoryPicker!=='function';
    setTab($('settingsDialog').querySelector('[data-tab=saveSettingsPage]'));renderOrder();settingsPreview();$('settingsDialog').showModal();
  }
  $('saveMode').onchange=settingsPreview;$('suffixInput').oninput=()=>{$('settingsError').textContent='';settingsPreview();};
  $('chooseDirectory').onclick=async()=>{try{settingsDraft.directory=await showDirectoryPicker({mode:'readwrite',id:'jetphotos-dust-export'});settingsPreview();}catch(error){if(error.name!=='AbortError')$('settingsError').textContent=error.message;}};
  $('applySettings').onclick=()=>{
    const suffix=$('suffixInput').value,saveMode=$('saveMode').value;
    if(!DustInteraction.validSuffix(suffix)){$('settingsError').textContent='请输入有效后缀，不能包含路径或文件名禁用字符。';return;}
    if(saveMode==='directory'&&!settingsDraft.directory){$('settingsError').textContent='请选择输出文件夹。';return;}
    for(const key of settingsDraft.order)$('editingControls').append(panels().find(p=>p.dataset.panel===key));
    app.setSettings({suffix,saveMode,directory:settingsDraft.directory});$('settingsDialog').close();refreshTutorial(true);
  };
  async function saveAs() {
    if(!state.doc||locked()||document.querySelector('dialog[open]'))return;
    closeMenu();const item=app.entry(),suggested=item.savedName||DustInteraction.outputName(item.file.name,state.suffix);
    if(typeof showSaveFilePicker==='function') {
      try {
        const handle=await showSaveFilePicker({suggestedName:suggested,types:[{description:'JPEG 照片',accept:{'image/jpeg':['.jpg','.jpeg']}}],excludeAcceptAllOption:true,id:'jp-dust-save-as'});
        if(state.entries.some(source=>source.file.name.toLowerCase()===handle.name.toLowerCase())) {
          if(!await warnOriginal(handle.name))return;
        }
        await app.exportPhotos([item],{filename:handle.name,handle});
      } catch(error){if(error.name!=='AbortError')app.showResult('保存失败',[error.message]);}
      return;
    }
    $('saveAsName').value=suggested;$('saveAsError').textContent='';$('saveAsDialog').showModal();
  }
  function warnOriginal(name) {
    const dialog=$('confirmDialog');$('confirmTitle').textContent='覆盖原片';$('confirmText').textContent='所选文件名与导入的原片相同：\n'+name+'\n如果目标就是原片，继续将覆盖该文件。确定吗？';$('confirmSave').hidden=false;$('confirmSave').textContent='保存';$('confirmDiscard').hidden=true;$('confirmCancel').textContent='取消';dialog.showModal();
    return new Promise(resolve=>{const finish=value=>{dialog.close();dialog.oncancel=null;resolve(value);};$('confirmSave').onclick=()=>finish(true);$('confirmCancel').onclick=dialog.querySelector('.dialog-close').onclick=()=>finish(false);dialog.oncancel=event=>{event.preventDefault();finish(false);};});
  }
  $('saveAsConfirm').onclick=()=>{
    let name=$('saveAsName').value.trim();
    if(!name||/[<>:"/\\|?*\x00-\x1f]/.test(name)||/[. ]$/.test(name)){$('saveAsError').textContent='请输入有效文件名。';return;}
    if(!/\.jpe?g$/i.test(name))name=name.replace(/\.[^.]+$/,'')+'.jpg';
    if(name.length>255){$('saveAsError').textContent='文件名过长。';return;}
    $('saveAsDialog').close();app.exportPhotos([app.entry()],{filename:name});
  };
  function showAbout() {
    if(state.busy||document.querySelector('dialog[open]'))return;
    const information=['JetPhotos Dust Lab · 浏览器版','界面与交互依据 Python 桌面版','运行方式：本地浏览器 / 静态网页','语言：HTML / CSS / JavaScript','图像运算：Canvas / Web Worker','输出：JPEG 100 · 4:4:4','元数据：EXIF / XMP / ICC / IPTC 逐字节校验','文件处理：本地读取 → 本地编辑 → 本地保存','浏览器：'+navigator.userAgent].join('\n');
    $('applicationInfo').textContent=information;setTab($('aboutDialog').querySelector('[data-tab=aboutOverview]'));$('aboutDialog').showModal();
  }
  $('copyInfo').onclick=async()=>{try{await navigator.clipboard.writeText($('applicationInfo').textContent);$('copyInfo').textContent='已复制';setTimeout(()=>{$('copyInfo').textContent='复制应用信息';},1800);}catch(_){const selection=getSelection(),range=document.createRange();setTab($('aboutDialog').querySelector('[data-tab=aboutInformation]'));range.selectNodeContents($('applicationInfo'));selection.removeAllRanges();selection.addRange(range);app.status('请选择并复制应用信息');}};
  function tutorialSteps() {
    const has=!!state.doc,nav=state.filmstrip?'底部缩略图切换照片，勾选决定批量保存范围。':'按 Tab 可显示底部缩略图，Alt+← / → 切换照片。';
    const edit=state.compare?'左侧原色、右侧 Dust。':'当前为单视图：D 切换原色与 Dust，C 切回对照。';
    return [
      ['导入与切换','点击上方“导入”或拖入多张 JPEG。'+(has?nav:'导入后会显示修复面板和底部缩略图。')],
      [has?'检查与修复':'导入后开始修复',has?edit+'Alt 单击或右键取样，再涂过灰尘。[ ] 调笔刷，Ctrl+Z 撤销。Dust View Setting 调整检查效果。':'当前尚未导入照片，右侧面板会暂时隐藏。导入后可在 Dust View Setting 调整预览，再用仿制图章修复灰尘。'],
      [has?'保存照片':'先设置保存方式',has?'Ctrl+S 保存当前，“保存所选”批量输出。默认在下载目录添加 _dustclean 后缀。Dust 调色不会进入输出。':'点击上方“设置”可预先选择输出目录与文件名后缀。导入并修复后，Ctrl+S 保存原色结果；默认添加 _dustclean 后缀。']
    ];
  }
  function refreshTutorial(reanchor=false) {
    const panel=$('tutorialPanel');if(panel.hidden)return;
    const steps=tutorialSteps(),context=!!state.doc+'|'+state.compare+'|'+state.filmstrip;
    $('tutorialStep').textContent='入门 · '+(tutorialStep+1)+' / 3';$('tutorialHeading').textContent=steps[tutorialStep][0];$('tutorialBody').textContent=steps[tutorialStep][1];$('tutorialBack').hidden=tutorialStep===0;$('tutorialNext').textContent=tutorialStep===2?'完成':'下一步';
    for(const target of document.querySelectorAll('.tutorial-target'))target.classList.remove('tutorial-target');
    const target=tutorialStep===0?$('openButton'):tutorialStep===1?(state.doc?document.querySelector('[data-panel=brush]'):$('canvasArea')):(state.doc?$('saveButton'):$('settingsButton'));
    target.classList.add('tutorial-target');
    if(reanchor||context!==tutorialContext) {
      const root=$('appMain').getBoundingClientRect(),w=panel.offsetWidth,h=panel.offsetHeight;let x=18,y=42;
      if(tutorialStep===1&&state.doc){target.querySelector('summary').scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();x=r.left-root.left-w-18;y=r.top-root.top+12;}
      else if(tutorialStep===1){x=(root.width-w)/2;y=48;}
      else if(tutorialStep===2&&state.entries.length&&state.filmstrip){const r=$('filmstrip').getBoundingClientRect();x=18;y=r.top-root.top-h-12;}
      else if(tutorialStep===2){x=root.width-w-18;y=42;}
      panel.style.left=Math.max(8,Math.min(x,root.width-w-8))+'px';panel.style.top=Math.max(8,Math.min(y,root.height-h-8))+'px';
    }
    tutorialContext=context;
  }
  function showTutorial() {
    if(state.busy||document.querySelector('dialog[open]'))return;
    closeMenu();try{localStorage.setItem('jp-dust-tutorial-seen-v2','1');}catch(_){}
    if($('tutorialPanel').hidden)tutorialStep=0;
    $('tutorialPanel').hidden=false;refreshTutorial(true);
  }
  function hideTutorial() {$('tutorialPanel').hidden=true;for(const target of document.querySelectorAll('.tutorial-target'))target.classList.remove('tutorial-target');}
  $('tutorialSkip').onclick=hideTutorial;$('tutorialBack').onclick=()=>{tutorialStep=Math.max(0,tutorialStep-1);refreshTutorial(true);};$('tutorialNext').onclick=()=>{if(tutorialStep===2)hideTutorial();else{tutorialStep++;refreshTutorial(true);}};
  let tutorialDrag=null;
  $('tutorialPanel').onpointerdown=event=>{if(event.button!==0||event.target.closest('button'))return;const r=$('tutorialPanel').getBoundingClientRect();tutorialDrag={x:event.clientX-r.left,y:event.clientY-r.top};event.preventDefault();$('tutorialPanel').setPointerCapture(event.pointerId);$('tutorialPanel').style.cursor='grabbing';};
  $('tutorialPanel').onpointermove=event=>{if(!tutorialDrag)return;const root=$('appMain').getBoundingClientRect(),panel=$('tutorialPanel');panel.style.left=Math.max(8,Math.min(event.clientX-root.left-tutorialDrag.x,root.width-panel.offsetWidth-8))+'px';panel.style.top=Math.max(8,Math.min(event.clientY-root.top-tutorialDrag.y,root.height-panel.offsetHeight-8))+'px';};
  $('tutorialPanel').onpointerup=$('tutorialPanel').onpointercancel=()=>{tutorialDrag=null;$('tutorialPanel').style.cursor='grab';};
  const splitter=$('viewSplitter');splitter.onpointerdown=event=>{if(event.button!==0||locked()||!state.doc||!state.compare)return;event.preventDefault();splitDrag=true;splitter.setPointerCapture(event.pointerId);};
  function setSplit(x){const r=$('canvasArea').getBoundingClientRect(),left=Math.max(220,Math.min(x-r.left,r.width-220));document.documentElement.style.setProperty('--split',(left/r.width*100)+'%');app.resize();app.refreshDust();}
  splitter.onpointermove=event=>{if(splitDrag)setSplit(event.clientX);};splitter.onpointerup=splitter.onpointercancel=()=>{splitDrag=null;};
  splitter.onkeydown=event=>{if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&!locked()){event.preventDefault();const r=splitter.getBoundingClientRect();setSplit(r.left+2+(event.key==='ArrowLeft'?-8:8));}};
  window.addEventListener('resize',()=>{refreshTutorial(true);closeMenu();});
  document.addEventListener('dust:statechange',()=>{for(const button of $('menuBar').children)button.disabled=state.busy;refreshTutorial(false);});
  window.DustDesktop={openSettings,saveAs,showTutorial,thumbnailMenu:(index,x,y)=>showMenu([action('关闭照片',()=>app.closePhoto(index)),action('关闭本组照片',app.closeBatch)],x,y)};
  setTimeout(()=>{let seen=false;try{seen=localStorage.getItem('jp-dust-tutorial-seen-v2')==='1';}catch(_){}if(!seen)showTutorial();},400);
})();
