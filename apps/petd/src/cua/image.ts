/** 图像后处理：BGRA 截图 → 缩小 RGBA → 画鼠标箭头 → JPEG。 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jpeg: {
  encode(input: { data: Buffer; width: number; height: number }, quality?: number): { data: Buffer; width: number; height: number };
} = require('jpeg-js');

export interface Downscaled {
  rgba: Buffer;
  width: number;
  height: number;
  /** 物理像素 / 截图像素 */
  scale: number;
}

/** 面积平均缩小（块采样）；scale ≥ 1 时只做 BGRA→RGBA。 */
export function downscale(bgra: Buffer, srcW: number, srcH: number, maxW: number, maxH: number): Downscaled {
  const scale = Math.min(1, maxW / srcW, maxH / srcH);
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));
  const rgba = Buffer.alloc(outW * outH * 4);
  const stepX = srcW / outW;
  const stepY = srcH / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * stepY);
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.floor((oy + 1) * stepY)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * stepX);
      const x1 = Math.min(srcW, Math.max(x0 + 1, Math.floor((ox + 1) * stepX)));
      let b = 0;
      let g = 0;
      let r = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let idx = (sy * srcW + x0) * 4;
        for (let sx = x0; sx < x1; sx++) {
          b += bgra[idx]!;
          g += bgra[idx + 1]!;
          r += bgra[idx + 2]!;
          idx += 4;
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      rgba[o] = Math.round(r / n);
      rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n);
      rgba[o + 3] = 255;
    }
  }
  return { rgba, width: outW, height: outH, scale: srcW / outW };
}

/** 经典箭头（12×19），返回每个像素是否为箭头内。 */
const ARROW_POLYGON: Array<[number, number]> = [
  [0, 0],
  [0, 14],
  [4, 11],
  [6, 18],
  [9, 17],
  [7, 10],
  [11, 10],
];

function insideArrow(px: number, py: number): boolean {
  let inside = false;
  for (let i = 0, j = ARROW_POLYGON.length - 1; i < ARROW_POLYGON.length; j = i++) {
    const xi = ARROW_POLYGON[i]![0]!;
    const yi = ARROW_POLYGON[i]![1]!;
    const xj = ARROW_POLYGON[j]![0]!;
    const yj = ARROW_POLYGON[j]![1]!;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 在缩略图上画一个白色黑边箭头（截图本身不含光标）。 */
export function drawCursor(rgba: Buffer, width: number, height: number, cx: number, cy: number): void {
  for (let y = 0; y < 19; y++) {
    for (let x = 0; x < 12; x++) {
      const px = cx + x;
      const py = cy + y;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const inArrow = insideArrow(x, y);
      const edge =
        inArrow &&
        (x === 0 ||
          y === 0 ||
          !insideArrow(x - 1, y) ||
          !insideArrow(x + 1, y) ||
          !insideArrow(x, y - 1) ||
          !insideArrow(x, y + 1));
      if (!inArrow && !edge) continue;
      const o = (py * width + px) * 4;
      if (edge) {
        rgba[o] = 0;
        rgba[o + 1] = 0;
        rgba[o + 2] = 0;
      } else {
        rgba[o] = 255;
        rgba[o + 1] = 255;
        rgba[o + 2] = 255;
      }
      rgba[o + 3] = 255;
    }
  }
}

export function encodeJpeg(rgba: Buffer, width: number, height: number, quality: number): Buffer {
  const out = jpeg.encode({ data: rgba, width, height }, Math.max(1, Math.min(100, quality)));
  return out.data;
}
