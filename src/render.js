'use strict';
// 方向场可视化：色相 = 局部主方向（180° 周期映射到 360° 色环），
// 饱和度 = 方向一致性，亮度 = 原图灰度。梯度极弱处退化为灰底。
const { PNG } = require('pngjs');

function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function renderOrientationPNG(fields, gray, w, h) {
  const { orient, coherence, magN } = fields;
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (magN[i] < 0.02) {
      const g = Math.max(0, Math.min(255, Math.round(gray[i])));
      png.data[o] = png.data[o + 1] = png.data[o + 2] = g;
    } else {
      const hue = ((orient[i] + Math.PI / 2) / Math.PI) * 360;
      const val = 0.25 + 0.75 * Math.min(1, gray[i] / 255);
      const [r, g, b] = hsv2rgb(hue, Math.min(1, coherence[i]), val);
      png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b;
    }
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

module.exports = { renderOrientationPNG };
