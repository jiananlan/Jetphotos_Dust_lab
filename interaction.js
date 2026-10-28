/* Shared desktop behaviour, kept independent of browser UI for parity tests. */
(function (root) {
  'use strict';
  const ranges = Object.freeze({brushSize:[4,400],hardness:[0,100],opacity:[1,100],strength:[1,10],detail:[0,200],radius:[1,80],zoom:[2,1600]});
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
  function brushStep(value,direction) { return clamp(value+direction*8,4,400); }
  function fitScale(width,height,panes) { return Math.max(.02,Math.min(...panes.map(p=>Math.min((p.width-48)/width,(p.height-48)/height)))); }
  function zoomAt(view,width,height,size,next,anchor={x:size.width/2,y:size.height/2}) {
    next=clamp(next,.02,16);
    const ox=(size.width-width*view.zoom)/2+view.x,oy=(size.height-height*view.zoom)/2+view.y;
    return {zoom:next,x:anchor.x-(anchor.x-ox)*next/view.zoom-(size.width-width*next)/2,y:anchor.y-(anchor.y-oy)*next/view.zoom-(size.height-height*next)/2,fit:false};
  }
  function wheelFactor(delta,mode) {
    // DOM pixel deltas have the opposite sign to Qt's wheel deltas. Precision
    // touchpad pixels use 40 px per step; line events use the usual three lines.
    const steps=-delta/(mode===1?3:mode===2?1:40);
    return 1.16**clamp(steps,-30,30);
  }
  function validSuffix(value) { return typeof value==='string'&&value.length>0&&value.length<=80&&!!value.trim()&&!/[<>:"/\\|?*\x00-\x1f]/.test(value)&&!/[. ]$/.test(value); }
  function outputName(file,suffix,number='') {
    const tail=suffix+number+'.jpg',stem=file.replace(/\.(?:jpe?g|jpe)$/i,'');
    let name=stem.slice(0,Math.max(0,255-tail.length));
    if(/[\ud800-\udbff]$/.test(name)) name=name.slice(0,-1);
    return name+tail;
  }
  const api={ranges,brushStep,fitScale,zoomAt,wheelFactor,validSuffix,outputName};
  root.DustInteraction=api;
  if(typeof module!=='undefined') module.exports=api;
})(typeof globalThis!=='undefined'?globalThis:this);
