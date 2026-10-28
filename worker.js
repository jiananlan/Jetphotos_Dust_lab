'use strict';
importScripts('core.js', 'jpeg.js');
let image = null;
self.onmessage = function (event) {
  const message = event.data;
  try {
    if (message.type === 'clear') image = null;
    if (message.type === 'load') image = { pixels: message.pixels, width: message.width, height: message.height, token: message.token };
    if (message.type === 'patch' && image && image.token === message.token) {
      for (const tile of message.tiles) for (let row=0;row<tile.h;row++) image.pixels.set(tile.data.subarray(row*tile.w*4,(row+1)*tile.w*4),((tile.y+row)*image.width+tile.x)*4);
    }
    if (message.type === 'dust' && image && image.token === message.token) {
      const pixels = message.region ? DustCore.dustRegion(image.pixels,image.width,image.height,message.width,message.height,message.region,message.settings) : DustCore.dustPreview(image.pixels,image.width,image.height,message.width,message.height,message.settings);
      self.postMessage({type:'dust',token:message.token,id:message.id,width:message.width,height:message.height,region:message.region,pixels},[pixels.buffer]);
    }
    if (message.type === 'encode') {
      const bytes = DustJPEG.encode(message.pixels,message.width,message.height,message.metadata,progress=>self.postMessage({type:'progress',id:message.id,progress}));
      self.postMessage({type:'encoded',id:message.id,bytes},[bytes.buffer]);
    }
  } catch (error) { self.postMessage({type:'error',id:message.id,message:error.message}); }
};
