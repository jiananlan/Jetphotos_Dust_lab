/* JetPhotos Dust Lab — browser-local image operations. No dependencies. */
(function (root) {
  'use strict';
  const TILE = 256;
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  // Python / NumPy's round-to-even, including the midpoint CDF lookup table.
  function roundEven(value) {
    const low = Math.floor(value), fraction = value - low;
    return fraction === 0.5 ? low + (low % 2) : Math.round(value);
  }
  function axisWeights(source, target) {
    const ratio = source / target, result = [];
    for (let i = 0; i < target; i++) {
      const weights = [];
      if (ratio >= 1) {
        const start = i * ratio, end = (i + 1) * ratio;
        for (let p = Math.floor(start); p < Math.ceil(end); p++) {
          if (p < source) weights.push([p, (Math.min(end, p + 1) - Math.max(start, p)) / ratio]);
        }
      } else {
        const pos = (i + 0.5) * ratio - 0.5, left = Math.floor(pos), t = pos - left;
        weights.push([clamp(left, 0, source - 1), 1 - t], [clamp(left + 1, 0, source - 1), t]);
      }
      result.push(weights);
    }
    return result;
  }
  function resizeFloat(pixels, width, height, tw, th) {
    const horizontal = axisWeights(width, tw), vertical = axisWeights(height, th);
    const result = new Float32Array(tw * th * 3);
    // One source row at a time keeps large JPEGs from allocating another full image.
    const row = new Float32Array(tw * 3);
    for (let y = 0; y < th; y++) {
      for (const [sy, wy] of vertical[y]) {
        row.fill(0);
        for (let x = 0; x < tw; x++) {
          for (const [sx, wx] of horizontal[x]) {
            const s = (sy * width + sx) * 4, d = x * 3;
            row[d] += pixels[s] * wx;
            row[d + 1] += pixels[s + 1] * wx;
            row[d + 2] += pixels[s + 2] * wx;
          }
        }
        const offset = y * tw * 3;
        for (let i = 0; i < row.length; i++) result[offset + i] += row[i] * wy;
      }
    }
    return result;
  }
  function midpointLUT(values, channel, channels) {
    const histogram = new Uint32Array(4096), count = values.length / channels;
    for (let i = channel; i < values.length; i += channels) histogram[clamp(roundEven(values[i] * 4095 / 255), 0, 4095)]++;
    const lut = new Uint8Array(4096);
    let sum = 0;
    for (let i = 0; i < 4096; i++) {
      sum += histogram[i];
      lut[i] = roundEven(255 * (sum - histogram[i] / 2) / count);
    }
    return lut;
  }
  function reflected(i, length) {
    if (length <= 1) return 0;
    const period = 2 * length - 2;
    i = ((i % period) + period) % period;
    return i < length ? i : period - i;
  }
  function gaussianBlur(values, width, height, sigma) {
    const radius = Math.ceil(sigma * 3), kernel = new Float32Array(radius * 2 + 1);
    let total = 0;
    for (let k = -radius; k <= radius; k++) { const v = Math.exp(-k * k / (2 * sigma * sigma)); kernel[k + radius] = v; total += v; }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= total;
    const temp = new Float32Array(values.length), out = new Float32Array(values.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += values[y * width + reflected(x + k, width)] * kernel[k + radius];
      temp[y * width + x] = sum;
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += temp[reflected(y + k, height) * width + x] * kernel[k + radius];
      out[y * width + x] = sum;
    }
    return out;
  }
  function dustPreview(pixels, width, height, tw, th, settings) {
    const source = resizeFloat(pixels, width, height, tw, th), count = tw * th;
    const strength = clamp(settings.strength / 10, 0, 1), detail = clamp(settings.detail, 0, 2);
    let gray, blur;
    if (!settings.color || detail > 0) {
      gray = new Float32Array(count);
      for (let i = 0; i < count; i++) gray[i] = source[i * 3] * 0.299 + source[i * 3 + 1] * 0.587 + source[i * 3 + 2] * 0.114;
    }
    if (detail > 0) blur = gaussianBlur(gray, tw, th, Math.max(0.25, settings.radius));
    const luts = settings.color ? [0, 1, 2].map(c => midpointLUT(source, c, 3)) : [midpointLUT(gray, 0, 1)];
    const result = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < 3; c++) {
        const value = settings.color ? source[i * 3 + c] : gray[i];
        const mapped = luts[settings.color ? c : 0][clamp(roundEven(value * 4095 / 255), 0, 4095)];
        result[i * 4 + c] = roundEven(value + strength * (mapped - value) + (detail > 0 ? (gray[i] - blur[i]) * detail : 0));
      }
      result[i * 4 + 3] = 255;
    }
    return result;
  }
  function dustRegion(pixels, width, height, tw, th, region, settings) {
    // Compute the histogram for the ENTIRE view at its requested resolution,
    // retaining only visible float pixels. 100% inspection is never downsampled
    // to a thumbnail, and a 24 MP image needs only a few scanlines of scratch RAM.
    const detail = clamp(settings.detail, 0, 2), padding = detail > 0 ? Math.ceil(Math.max(0.25, settings.radius) * 3) : 0;
    const left = Math.max(0, region.x-padding), top = Math.max(0, region.y-padding);
    const right = Math.min(tw, region.x+region.width+padding), bottom = Math.min(th, region.y+region.height+padding);
    const rw=right-left,rh=bottom-top,colors=new Float32Array(rw*rh*3),gray=(!settings.color||detail>0)?new Float32Array(rw*rh):null;
    const histograms=Array.from({length:settings.color?3:1},()=>new Uint32Array(4096));
    const horizontal=axisWeights(width,tw),vertical=axisWeights(height,th),row=new Float32Array(tw*3),partial=new Float32Array(tw*3);
    for(let y=0;y<th;y++) {
      row.fill(0);
      for(const [sy,wy] of vertical[y]) {
        partial.fill(0);
        for(let x=0;x<tw;x++) for(const [sx,wx] of horizontal[x]) {
          const s=(sy*width+sx)*4,d=x*3;
          partial[d]+=pixels[s]*wx; partial[d+1]+=pixels[s+1]*wx; partial[d+2]+=pixels[s+2]*wx;
        }
        for(let i=0;i<row.length;i++) row[i]+=partial[i]*wy;
      }
      for(let x=0;x<tw;x++) {
        const s=x*3,lum=Math.fround(row[s]*0.299+row[s+1]*0.587+row[s+2]*0.114);
        if(settings.color) for(let c=0;c<3;c++) histograms[c][clamp(roundEven(row[s+c]*4095/255),0,4095)]++;
        else histograms[0][clamp(roundEven(lum*4095/255),0,4095)]++;
        if(x>=left&&x<right&&y>=top&&y<bottom) {
          const d=(y-top)*rw+x-left; colors[d*3]=row[s]; colors[d*3+1]=row[s+1]; colors[d*3+2]=row[s+2]; if(gray) gray[d]=lum;
        }
      }
    }
    const luts=histograms.map(hist=> { const lut=new Uint8Array(4096);let sum=0;for(let i=0;i<4096;i++){sum+=hist[i];lut[i]=roundEven(255*(sum-hist[i]/2)/(tw*th));}return lut; });
    const blur=detail>0?gaussianBlur(gray,rw,rh,Math.max(0.25,settings.radius)):null;
    const output=new Uint8ClampedArray(region.width*region.height*4),strength=clamp(settings.strength/10,0,1);
    for(let y=0;y<region.height;y++) for(let x=0;x<region.width;x++) {
      const i=(y+region.y-top)*rw+x+region.x-left,d=(y*region.width+x)*4;
      for(let c=0;c<3;c++) {
        const value=settings.color?colors[i*3+c]:gray[i],mapped=luts[settings.color?c:0][clamp(roundEven(value*4095/255),0,4095)];
        output[d+c]=roundEven(value+strength*(mapped-value)+(blur?(gray[i]-blur[i])*detail:0));
      }
      output[d+3]=255;
    }
    return output;
  }
  class PhotoDocument {
    constructor(width, height, pixels) {
      this.width = width; this.height = height; this.pixels = pixels;
      this.source = null; this.offset = null; this.undoStack = []; this.redoStack = [];
      this.brush = { size: 72, hardness: 72, opacity: 100, aligned: true };
      this.revision = 0; this.savedRevision = 0; this.nextRevision = 1;
      this.view = { zoom: 0, x: 0, y: 0 }; this.stroke = null;
    }
    get dirty() { return this.revision !== this.savedRevision; }
    setSource(x, y) { this.source = [clamp(x, 0, this.width - 1), clamp(y, 0, this.height - 1)]; this.offset = null; }
    captureTile(tx, ty) {
      const key = ty * Math.ceil(this.width / TILE) + tx;
      if (this.stroke.tiles.has(key)) return this.stroke.tiles.get(key);
      const x = tx * TILE, y = ty * TILE, w = Math.min(TILE, this.width - x), h = Math.min(TILE, this.height - y);
      const before = this.readRect(x, y, w, h);
      const tile = { x, y, w, h, before, coverage: new Float32Array(w * h) };
      this.stroke.tiles.set(key, tile);
      return tile;
    }
    readRect(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) data.set(this.pixels.subarray(((y + row) * this.width + x) * 4, ((y + row) * this.width + x + w) * 4), row * w * 4);
      return data;
    }
    writeRect(tile, data) {
      for (let row = 0; row < tile.h; row++) this.pixels.set(data.subarray(row * tile.w * 4, (row + 1) * tile.w * 4), ((tile.y + row) * this.width + tile.x) * 4);
    }
    beginStroke(x, y) {
      if (!this.source) return false;
      if (!this.brush.aligned || !this.offset) this.offset = [this.source[0] - x, this.source[1] - y];
      this.stroke = { tiles: new Map(), offset: this.offset.map(roundEven), last: null };
      this.continueStroke(x, y); return true;
    }
    continueStroke(x, y) {
      if (!this.stroke) return;
      x = clamp(x, 0, this.width - 1); y = clamp(y, 0, this.height - 1);
      const last = this.stroke.last;
      const steps = last ? Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / Math.max(1, this.brush.size * 0.12))) : 1;
      for (let step = 1; step <= steps; step++) this.dab(last ? last[0] + (x - last[0]) * step / steps : x, last ? last[1] + (y - last[1]) * step / steps : y);
      this.stroke.last = [x, y];
    }
    dab(cx, cy) {
      const radius = Math.max(0.5, this.brush.size / 2), [ox, oy] = this.stroke.offset;
      const x0 = Math.max(0, -ox, Math.floor(cx - radius)), y0 = Math.max(0, -oy, Math.floor(cy - radius));
      const x1 = Math.min(this.width, this.width - ox, Math.ceil(cx + radius + 1));
      const y1 = Math.min(this.height, this.height - oy, Math.ceil(cy + radius + 1));
      if (x0 >= x1 || y0 >= y1) return;
      // Snapshot the source before writing, so overlapping source/destination regions are safe.
      const sw = x1 - x0, sample = this.readRect(x0 + ox, y0 + oy, sw, y1 - y0);
      const hard = radius * this.brush.hardness / 100, opacity = this.brush.opacity / 100;
      for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++) {
        for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
          const tile = this.captureTile(tx, ty);
          for (let y = Math.max(y0, tile.y); y < Math.min(y1, tile.y + tile.h); y++) {
            for (let x = Math.max(x0, tile.x); x < Math.min(x1, tile.x + tile.w); x++) {
              const distance = Math.hypot(x - cx, y - cy);
              let mask = hard >= radius - 1e-6 ? Number(distance <= radius) : clamp((radius - distance) / (radius - hard), 0, 1);
              if (hard < radius - 1e-6) mask = mask * mask * (3 - 2 * mask);
              const local = (y - tile.y) * tile.w + x - tile.x, alpha = mask * opacity;
              if (alpha <= tile.coverage[local]) continue;
              tile.coverage[local] = alpha;
              const dest = (y * this.width + x) * 4, src = ((y - y0) * sw + x - x0) * 4;
              for (let c = 0; c < 3; c++) this.pixels[dest + c] = roundEven(tile.before[local * 4 + c] * (1 - alpha) + sample[src + c] * alpha);
            }
          }
        }
      }
    }
    strokeTiles() { return this.stroke ? Array.from(this.stroke.tiles.values()) : []; }
    endStroke(cancel = false) {
      if (!this.stroke) return false;
      const tiles = [];
      for (const tile of this.stroke.tiles.values()) {
        if (cancel) { this.writeRect(tile, tile.before); continue; }
        const after = this.readRect(tile.x, tile.y, tile.w, tile.h);
        if (after.some((value, i) => value !== tile.before[i])) tiles.push({ x: tile.x, y: tile.y, w: tile.w, h: tile.h, before: tile.before, after });
      }
      this.stroke = null;
      if (!tiles.length) return false;
      const previous = this.revision; this.revision = this.nextRevision++;
      this.undoStack.push({ tiles, previous, revision: this.revision }); this.redoStack.length = 0;
      let bytes = this.undoStack.reduce((sum, step) => sum + step.tiles.reduce((n, tile) => n + tile.before.byteLength * 2, 0), 0);
      while ((this.undoStack.length > 40 || bytes > 384 * 1024 * 1024) && this.undoStack.length > 1) {
        bytes -= this.undoStack.shift().tiles.reduce((n, tile) => n + tile.before.byteLength * 2, 0);
      }
      return true;
    }
    undo() {
      const step = this.undoStack.pop(); if (!step) return false;
      for (const tile of step.tiles) this.writeRect(tile, tile.before);
      this.revision = step.previous; this.redoStack.push(step); return true;
    }
    redo() {
      const step = this.redoStack.pop(); if (!step) return false;
      for (const tile of step.tiles) this.writeRect(tile, tile.after);
      this.revision = step.revision; this.undoStack.push(step); return true;
    }
    serialize() { const state = { ...this }; delete state.stroke; return state; }
    static restore(state) { const doc = Object.create(PhotoDocument.prototype); Object.assign(doc, state); doc.stroke = null; return doc; }
  }
  root.DustCore = { clamp, roundEven, resizeFloat, dustPreview, dustRegion, PhotoDocument };
  if (typeof module !== 'undefined') module.exports = root.DustCore;
})(typeof globalThis !== 'undefined' ? globalThis : this);
