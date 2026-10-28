/* Baseline JPEG encoder: quantisation = 1, 4:4:4, no remote libraries. */
(function (root) {
  'use strict';
  const META = new Set([0xe1, 0xe2, 0xed, 0xfe]);
  const ZIGZAG = [0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63];
  function segments(bytes) {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('文件不是有效的 JPEG。');
    const out = []; let pos = 2, scanned = false;
    while (pos < bytes.length) {
      const start = pos;
      if (bytes[pos++] !== 255) throw new Error('JPEG 头结构损坏。');
      while (bytes[pos] === 255) pos++;
      if (pos >= bytes.length) throw new Error('JPEG 标记不完整。');
      const marker = bytes[pos++];
      if (marker === 0xda) { scanned = true; break; }
      if (marker === 0xd9) break;
      if (marker === 1 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { out.push({ marker, start, end: pos, payload: pos }); continue; }
      if (pos + 2 > bytes.length) throw new Error('JPEG 段长度不完整。');
      const length = bytes[pos] * 256 + bytes[pos + 1];
      if (length < 2 || pos + length > bytes.length) throw new Error('JPEG 段长度无效。');
      out.push({ marker, start, end: pos + length, payload: pos + 2 }); pos += length;
    }
    if (!scanned) throw new Error('JPEG 缺少图像扫描数据。');
    return out;
  }
  const concat = arrays => {
    const result = new Uint8Array(arrays.reduce((n, bytes) => n + bytes.length, 0));
    let offset = 0; for (const bytes of arrays) { result.set(bytes, offset); offset += bytes.length; } return result;
  };
  function inspect(bytes) {
    const header = segments(bytes), metadata = header.filter(s => META.has(s.marker)).map(s => bytes.slice(s.start, s.end));
    const frame = header.find(s => [0xc0, 0xc1, 0xc2].includes(s.marker));
    if (!frame) throw new Error('暂不支持此 JPEG 编码。');
    const p = frame.payload, height = bytes[p + 1] * 256 + bytes[p + 2], width = bytes[p + 3] * 256 + bytes[p + 4];
    if (!width || !height || bytes[p] !== 8 || bytes[p + 5] !== 3) throw new Error('请使用 8 位、三通道 RGB JPEG 照片。');
    // Removing colour profiles and orientation during decoding keeps encoded RGB
    // channel values and sensor orientation, just like the desktop implementation.
    const pieces = [bytes.subarray(0, 2)]; let cursor = 2;
    for (const s of header) {
      if (s.marker === 0xe1 || s.marker === 0xe2) { pieces.push(bytes.subarray(cursor, s.start)); cursor = s.end; }
    }
    pieces.push(bytes.subarray(cursor));
    let orientation = 1; const exif = {};
    try {
      const app = header.find(s => s.marker === 0xe1 && String.fromCharCode(...bytes.subarray(s.payload, s.payload + 6)) === 'Exif\0\0');
      if (app) {
        const base = app.payload + 6, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), le = bytes[base] === 73;
        const u16 = p => { if (p < base || p + 2 > app.end) throw new Error('EXIF 越界'); return view.getUint16(p, le); };
        const u32 = p => { if (p < base || p + 4 > app.end) throw new Error('EXIF 越界'); return view.getUint32(p, le); };
        const ifd = base + u32(base + 4), count = Math.min(u16(ifd), 1024);
        for (let i = 0; i < count; i++) {
          const entry = ifd + 2 + i * 12, tag = u16(entry), type = u16(entry + 2), length = u32(entry + 4);
          if (tag === 274 && type === 3) orientation = u16(entry + 8);
          if ([271, 272, 305, 306, 315, 33432].includes(tag) && type === 2 && length < 2048) {
            const offset = length <= 4 ? entry + 8 : base + u32(entry + 8);
            if (offset >= base && offset + length <= app.end) exif[tag] = new TextDecoder().decode(bytes.subarray(offset, offset + length)).replace(/\0/g, '').trim();
          }
        }
      }
    } catch (_) { /* Raw EXIF is still retained even if a text field cannot be read. */ }
    return { width, height, metadata, decodeBytes: concat(pieces), orientation, exif };
  }
  class Writer {
    constructor() { this.chunks = []; this.chunk = new Uint8Array(65536); this.position = 0; this.bits = 0; this.bitCount = 0; }
    byte(v) {
      if (this.position === this.chunk.length) { this.chunks.push(this.chunk); this.chunk = new Uint8Array(65536); this.position = 0; }
      this.chunk[this.position++] = v;
    }
    word(v) { this.byte(v >> 8); this.byte(v & 255); }
    marker(v) { this.byte(255); this.byte(v); }
    array(bytes) { for (const value of bytes) this.byte(value); }
    code(value, count) {
      this.bits = (this.bits << count) | (value & ((1 << count) - 1)); this.bitCount += count;
      while (this.bitCount >= 8) {
        this.bitCount -= 8; const value = (this.bits >>> this.bitCount) & 255;
        this.byte(value); if (value === 255) this.byte(0);
      }
      this.bits &= (1 << this.bitCount) - 1;
    }
    finish() {
      if (this.bitCount) this.code((1 << (8 - this.bitCount)) - 1, 8 - this.bitCount);
      this.marker(0xd9); this.chunks.push(this.chunk.subarray(0, this.position)); return concat(this.chunks);
    }
  }
  const BASIS = Array.from({ length: 8 }, (_, k) => Float64Array.from({ length: 8 }, (_, n) => (k === 0 ? 1 / Math.sqrt(8) : 0.5) * Math.cos((2 * n + 1) * k * Math.PI / 16)));
  function dct(block, temp, output) {
    for (let y = 0; y < 8; y++) for (let k = 0; k < 8; k++) {
      const b = BASIS[k], i = y * 8;
      temp[i + k] = block[i] * b[0] + block[i+1] * b[1] + block[i+2] * b[2] + block[i+3] * b[3] + block[i+4] * b[4] + block[i+5] * b[5] + block[i+6] * b[6] + block[i+7] * b[7];
    }
    for (let k = 0; k < 8; k++) for (let x = 0; x < 8; x++) {
      const b = BASIS[k];
      output[k * 8 + x] = Math.round(temp[x]*b[0] + temp[8+x]*b[1] + temp[16+x]*b[2] + temp[24+x]*b[3] + temp[32+x]*b[4] + temp[40+x]*b[5] + temp[48+x]*b[6] + temp[56+x]*b[7]);
    }
  }
  function magnitude(value) { let n = Math.abs(value), size = 0; while (n) { size++; n >>>= 1; } return size; }
  function verify(bytes, metadata, width, height) {
    const header = segments(bytes), actual = header.filter(s => META.has(s.marker)).map(s => bytes.subarray(s.start, s.end));
    if (actual.length !== metadata.length || actual.some((a, i) => a.length !== metadata[i].length || a.some((v, j) => v !== metadata[i][j]))) throw new Error('元数据逐字节校验失败，已取消导出。');
    const frame = header.find(s => s.marker === 0xc0), p = frame && frame.payload;
    if (!frame || bytes[p+1]*256+bytes[p+2] !== height || bytes[p+3]*256+bytes[p+4] !== width || [p+7,p+10,p+13].some(i => bytes[i] !== 0x11)) throw new Error('导出尺寸或 4:4:4 校验失败。');
    const tables = header.filter(s => s.marker === 0xdb);
    if (tables.length !== 1 || bytes[tables[0].payload] !== 0 || bytes.subarray(tables[0].payload+1, tables[0].end).some(v => v !== 1)) throw new Error('JPEG 质量 100 校验失败。');
    return true;
  }
  function encode(pixels, width, height, metadata = [], progress) {
    if (width < 1 || height < 1 || width > 65535 || height > 65535 || pixels.length !== width * height * 4) throw new Error('图像尺寸无效。');
    const writer = new Writer(), ac = [0, 0xf0];
    for (let run = 0; run < 16; run++) for (let size = 1; size <= 10; size++) ac.push(run * 16 + size);
    const acCodes = new Map(ac.map((value, code) => [value, code]));
    writer.marker(0xd8);
    writer.marker(0xe0); writer.word(16); writer.array([74,70,73,70,0,1,1,0,0,1,0,1,0,0]);
    metadata.forEach(bytes => writer.array(bytes));
    writer.marker(0xdb); writer.word(67); writer.byte(0); for (let i = 0; i < 64; i++) writer.byte(1);
    writer.marker(0xc0); writer.word(17); writer.byte(8); writer.word(height); writer.word(width); writer.byte(3);
    for (let i = 1; i <= 3; i++) writer.array([i,0x11,0]);
    // Deliberately simple, valid canonical Huffman codes avoid codec dependencies.
    // DC: 12 symbols of length 4. AC: 162 symbols of length 8. No all-ones code.
    writer.marker(0xc4); writer.word(31); writer.byte(0);
    for (let i = 1; i <= 16; i++) writer.byte(i === 4 ? 12 : 0);
    for (let i = 0; i < 12; i++) writer.byte(i);
    writer.marker(0xc4); writer.word(181); writer.byte(0x10);
    for (let i = 1; i <= 16; i++) writer.byte(i === 8 ? 162 : 0);
    writer.array(ac);
    writer.marker(0xda); writer.word(12); writer.byte(3); writer.array([1,0,2,0,3,0,0,63,0]);
    const blocks = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
    const temp = new Float64Array(64), coefficients = new Int32Array(64), dc = [0,0,0];
    for (let by = 0; by < height; by += 8) {
      for (let bx = 0; bx < width; bx += 8) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const p = (Math.min(by+y,height-1)*width+Math.min(bx+x,width-1))*4, i = y*8+x;
          const r = pixels[p], g = pixels[p+1], b = pixels[p+2];
          blocks[0][i] = 0.299*r + 0.587*g + 0.114*b - 128;
          blocks[1][i] = -0.168736*r - 0.331264*g + 0.5*b;
          blocks[2][i] = 0.5*r - 0.418688*g - 0.081312*b;
        }
        for (let component = 0; component < 3; component++) {
          dct(blocks[component], temp, coefficients);
          const diff = coefficients[0]-dc[component], size = magnitude(diff); dc[component] = coefficients[0];
          writer.code(size,4); if (size) writer.code(diff < 0 ? diff + (1 << size)-1 : diff,size);
          let zeros = 0;
          for (let i = 1; i < 64; i++) {
            const value = coefficients[ZIGZAG[i]];
            if (value === 0) { zeros++; continue; }
            while (zeros >= 16) { writer.code(acCodes.get(0xf0),8); zeros -= 16; }
            const bits = magnitude(value), symbol = zeros*16+bits;
            if (!acCodes.has(symbol)) throw new Error('JPEG 系数超出基线范围。');
            writer.code(acCodes.get(symbol),8); writer.code(value < 0 ? value+(1<<bits)-1 : value,bits); zeros = 0;
          }
          if (zeros) writer.code(acCodes.get(0),8);
        }
      }
      if (progress && (by % 128 === 0 || by + 8 >= height)) progress(Math.min(1,(by+8)/height));
    }
    const bytes = writer.finish(); verify(bytes,metadata,width,height); return bytes;
  }
  // Uncompressed ZIP: one deliberate download for batch output; every JPEG is already compressed.
  const CRC_TABLE = Uint32Array.from({length:256},(_,n)=> { for(let i=0;i<8;i++) n = n&1 ? 0xedb88320^(n>>>1) : n>>>1; return n>>>0; });
  function crc32(bytes) { let crc=0xffffffff; for(const byte of bytes) crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8); return (crc^0xffffffff)>>>0; }
  function zip(files) {
    const local = [], central = []; let offset = 0;
    const header = size => { const bytes=new Uint8Array(size); return [bytes,new DataView(bytes.buffer)]; };
    const now=new Date(), time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1), date=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
    for(const file of files) {
      const name=new TextEncoder().encode(file.name), crc=crc32(file.bytes), size=file.bytes.length;
      if (size>0xffffffff || offset+size+name.length+30>0xffffffff) throw new Error('批量输出超过 ZIP 4 GB 限制，请分批保存。');
      const [l,v]=header(30+name.length); v.setUint32(0,0x04034b50,true); v.setUint16(4,20,true); v.setUint16(6,0x800,true); v.setUint16(10,time,true); v.setUint16(12,date,true); v.setUint32(14,crc,true); v.setUint32(18,size,true); v.setUint32(22,size,true); v.setUint16(26,name.length,true); l.set(name,30);
      const [c,w]=header(46+name.length); w.setUint32(0,0x02014b50,true); w.setUint16(4,20,true); w.setUint16(6,20,true); w.setUint16(8,0x800,true); w.setUint16(12,time,true); w.setUint16(14,date,true); w.setUint32(16,crc,true); w.setUint32(20,size,true); w.setUint32(24,size,true); w.setUint16(28,name.length,true); w.setUint32(42,offset,true); c.set(name,46);
      local.push(l,file.bytes); central.push(c); offset+=l.length+size;
    }
    const centralSize=central.reduce((sum,b)=>sum+b.length,0);
    if(files.length>65535 || offset+centralSize+22>0xffffffff) throw new Error('批量输出过大，请分批保存。');
    const [end,v]=header(22); v.setUint32(0,0x06054b50,true); v.setUint16(8,files.length,true); v.setUint16(10,files.length,true); v.setUint32(12,centralSize,true); v.setUint32(16,offset,true);
    return new Blob([...local,...central,end],{type:'application/zip'});
  }
  root.DustJPEG = { segments, inspect, encode, verify, zip, crc32 };
  if (typeof module !== 'undefined') module.exports=root.DustJPEG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
