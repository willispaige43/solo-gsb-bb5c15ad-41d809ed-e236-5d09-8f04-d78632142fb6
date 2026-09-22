'use strict';
// 图像解码 / 灰度化 / 缩放 / 高斯滤波 / PNG 编码（纯 JS，无原生依赖）
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const MAX_DIM = 1024; // 处理分辨率上限（最长边）

/** 解码 PNG / JPEG 为灰度 Float32Array（0..255）。彩色图按 ITU-R 601 亮度转换。 */
function decodeToGray(buf) {
  let width, height, data;
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    ({ width, height, data } = png);
  } else if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const j = jpeg.decode(buf, { maxMemoryUsageInMB: 1024, formatAsRGBA: true });
    if (!j || !j.data) throw new Error('JPEG 解码失败');
    ({ width, height, data } = j);
  } else {
    throw new Error('仅支持 PNG 或 JPEG 图像');
  }
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { gray, width, height };
}

/** 双线性缩放，使最长边不超过 maxDim。返回 scale = 原图边长 / 新边长（>=1）。 */
function resizeToMax(gray, w, h, maxDim = MAX_DIM) {
  const m = Math.max(w, h);
  if (m <= maxDim) return { gray, width: w, height: h, scale: 1 };
  const s = maxDim / m;
  const nw = Math.max(1, Math.round(w * s));
  const nh = Math.max(1, Math.round(h * s));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1.001, Math.max(0, (y + 0.5) / s - 0.5));
    const y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1.001, Math.max(0, (x + 0.5) / s - 0.5));
      const x0 = Math.floor(sx), fx = sx - x0;
      const i00 = y0 * w + x0, i10 = i00 + 1, i01 = i00 + w, i11 = i01 + 1;
      out[y * nw + x] =
        gray[i00] * (1 - fx) * (1 - fy) + gray[i10] * fx * (1 - fy) +
        gray[i01] * (1 - fx) * fy + gray[i11] * fx * fy;
    }
  }
  return { gray: out, width: nw, height: nh, scale: 1 / s };
}

function gaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, r };
}

function blurPass(src, w, h, k, r, horizontal) {
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        let xx = x, yy = y;
        if (horizontal) xx = Math.min(w - 1, Math.max(0, x + t));
        else yy = Math.min(h - 1, Math.max(0, y + t));
        acc += k[t + r] * src[yy * w + xx];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

/** 可分离高斯模糊（边缘钳制）。 */
function gaussianBlur(src, w, h, sigma) {
  const { k, r } = gaussianKernel(sigma);
  return blurPass(blurPass(src, w, h, k, r, true), w, h, k, r, false);
}

/** 灰度数组编码为 PNG Buffer。 */
function encodeGrayPNG(gray, w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    const o = i * 4;
    png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

module.exports = { decodeToGray, resizeToMax, gaussianBlur, encodeGrayPNG, MAX_DIM };
