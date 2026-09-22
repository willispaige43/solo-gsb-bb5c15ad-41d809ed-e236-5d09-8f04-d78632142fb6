'use strict';
// 生成演示用合成显微纹理图：若干方向 / 周期不同的条纹斑块 + 噪声背景，
// 便于在没有真实样本时立即体验完整分析流程。
function makeDemoImage() {
  const w = 512, h = 512;
  const gray = new Float32Array(w * h);
  const patches = [
    { cx: 150, cy: 150, r: 110, theta: 0.0,           lambda: 9,  contrast: 55 },
    { cx: 375, cy: 140, r: 100, theta: Math.PI / 3,   lambda: 7,  contrast: 50 },
    { cx: 180, cy: 385, r: 120, theta: Math.PI / 2,   lambda: 12, contrast: 45 },
    { cx: 395, cy: 385, r: 95,  theta: -Math.PI / 4,  lambda: 6,  contrast: 60 },
  ];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 120 + (rnd() - 0.5) * 14;
      for (const p of patches) {
        const d = Math.hypot(x - p.cx, y - p.cy);
        if (d >= p.r) continue;
        let t = Math.min(1, Math.max(0, (p.r - d) / 12)); // 软边缘
        t = t * t * (3 - 2 * t);
        const s = Math.sin((2 * Math.PI * (x * Math.cos(p.theta) + y * Math.sin(p.theta))) / p.lambda);
        const tex = 128 + p.contrast * s + (rnd() - 0.5) * 18;
        v = v * (1 - t) + tex * t;
      }
      gray[y * w + x] = Math.min(255, Math.max(0, v));
    }
  }
  return { gray, width: w, height: h };
}

module.exports = { makeDemoImage };
