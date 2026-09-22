'use strict';
// 核心分析管线：
//   1) 高斯去噪 + Sobel 梯度
//   2) 结构张量 → 局部梯度方向场 θ、方向一致性 coherence、归一化梯度强度 magN
//   3) 阈值生成候选纹理掩膜（coherence >= ct 且 magN >= mt）
//   4) 距离变换 + 分水岭浸没，把粘连的候选区域沿脊线拆开
//   5) 小区域合并 / 剔除
//   6) 区域统计 + 边界提取 + 低置信边界标注
const { gaussianBlur } = require('./image');

const SQRT2 = Math.SQRT2;

function num(v, dflt) {
  const x = Number(v);
  return Number.isFinite(x) ? x : dflt;
}

/** Sobel 梯度（边缘复制）。 */
function sobel(src, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const at = (x, y) =>
    src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      gy[i] =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    }
  }
  return { gx, gy };
}

/**
 * 计算方向场（与阈值无关，可缓存复用）：
 *   orient ∈ [-π/2, π/2]  局部主梯度方向（结构张量主方向）
 *   coherence ∈ [0,1]     方向一致性（张量各向异性）
 *   magN ∈ [0,1]          归一化梯度强度
 */
function computeFields(gray, w, h) {
  const smooth = gaussianBlur(gray, w, h, 1.0);
  const { gx, gy } = sobel(smooth, w, h);
  const n = w * h;
  const Jxx = new Float32Array(n);
  const Jxy = new Float32Array(n);
  const Jyy = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Jxx[i] = gx[i] * gx[i];
    Jxy[i] = gx[i] * gy[i];
    Jyy[i] = gy[i] * gy[i];
  }
  const sxx = gaussianBlur(Jxx, w, h, 2.0);
  const sxy = gaussianBlur(Jxy, w, h, 2.0);
  const syy = gaussianBlur(Jyy, w, h, 2.0);
  const orient = new Float32Array(n);
  const coherence = new Float32Array(n);
  const magRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = sxx[i], b = sxy[i], c = syy[i];
    coherence[i] = Math.hypot(a - c, 2 * b) / (a + c + 1e-6);
    orient[i] = 0.5 * Math.atan2(2 * b, a - c);
    magRaw[i] = Math.min(1, Math.hypot(gx[i], gy[i]) / 1020); // Sobel 最大值 ≈ 4*255
  }
  // 梯度强度在纹理尺度上平滑：周期性纹理在条纹过零点处瞬时梯度为零，
  // 直接逐像素阈值会把掩膜切成细条；平滑后阈值才反映“纹理区域”的强度。
  const magN = gaussianBlur(magRaw, w, h, 3.0);
  return { orient, coherence, magN };
}

/** 两遍 Chamfer 距离变换（权重 1 / √2），背景为 0。 */
function distanceTransform(mask, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 1e6 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 1);
      if (y > 0) {
        m = Math.min(m, d[i - w] + 1);
        if (x > 0) m = Math.min(m, d[i - w - 1] + SQRT2);
        if (x < w - 1) m = Math.min(m, d[i - w + 1] + SQRT2);
      }
      d[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
      if (y < h - 1) {
        m = Math.min(m, d[i + w] + 1);
        if (x < w - 1) m = Math.min(m, d[i + w + 1] + SQRT2);
        if (x > 0) m = Math.min(m, d[i + w - 1] + SQRT2);
      }
      d[i] = m;
    }
  }
  return d;
}

/**
 * 分水岭浸没：按距离值从大到小处理掩膜像素。
 * 无已标记邻居 → 新种子（距离局部极大）；一个邻居标签 → 继承；
 * 多个不同标签 → 脊线像素（记入 ridge，防止相邻区域粘连），归入其一继续传播。
 */
function watershed(dist, mask, w, h) {
  const n = w * h;
  const idx = [];
  for (let i = 0; i < n; i++) if (mask[i]) idx.push(i);
  idx.sort((a, b) => dist[b] - dist[a]);
  const labels = new Int32Array(n).fill(-1);
  const ridge = new Set();
  let nextLabel = 0;
  for (const p of idx) {
    const x = p % w, y = (p / w) | 0;
    let found = -1, multi = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const l = labels[yy * w + xx];
        if (l < 0) continue;
        if (found === -1) found = l;
        else if (found !== l) multi = true;
      }
    }
    if (found === -1) labels[p] = nextLabel++;
    else {
      labels[p] = found;
      if (multi) ridge.add(p);
    }
  }
  return { labels, ridge, count: nextLabel };
}

/** 小于 minArea 的区域并入最大的相邻大区域；无大邻居则归为背景。 */
function mergeSmall(labels, w, h, minArea) {
  const sizes = new Map();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l >= 0) sizes.set(l, (sizes.get(l) || 0) + 1);
  }
  const adj = buildAdjacency(labels, w, h);
  const remap = new Map();
  for (const [l, sz] of [...sizes.entries()].sort((a, b) => a[1] - b[1])) {
    if (sz >= minArea) continue;
    let best = -1, bestSize = -1;
    const nb = adj.get(l);
    if (nb) {
      for (const l2 of nb.keys()) {
        const s2 = sizes.get(l2) || 0;
        if (s2 >= minArea && s2 > bestSize) { best = l2; bestSize = s2; }
      }
    }
    remap.set(l, best); // -1 → 背景
  }
  if (!remap.size) return labels;
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    let l = labels[i];
    if (l >= 0) {
      let guard = 0;
      while (remap.has(l) && guard++ < 10000) {
        const nx = remap.get(l);
        if (nx === -1) { l = -1; break; }
        l = nx;
      }
    }
    out[i] = l;
  }
  return out;
}

/** 方向差（无向，周期 π），返回值域 [0, π/2]。 */
function orientDiff(a, b) {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/** 收集区域邻接关系（4 邻域，右/下扫描）。返回 Map(label -> Map(neighbor -> count))。 */
function buildAdjacency(labels, w, h) {
  const adj = new Map();
  const add = (a, b) => {
    let m = adj.get(a);
    if (!m) adj.set(a, (m = new Map()));
    m.set(b, (m.get(b) || 0) + 1);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (l < 0) continue;
      if (x + 1 < w) {
        const l2 = labels[y * w + x + 1];
        if (l2 >= 0 && l2 !== l) { add(l, l2); add(l2, l); }
      }
      if (y + 1 < h) {
        const l2 = labels[(y + 1) * w + x];
        if (l2 >= 0 && l2 !== l) { add(l, l2); add(l2, l); }
      }
    }
  }
  return adj;
}

/**
 * 方向相似区域合并（并查集）：分水岭在非凸掩膜上会产生多个距离极大值，
 * 把同一纹理切成数块；平均方向差小于阈值的相邻区域应并回同一纹理。
 * 按方向差升序贪心合并，合并后方向按倍角向量累计更新。
 */
function mergeByOrientation(labels, w, h, orient, threshRad) {
  const sumC = new Map(), sumS = new Map();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l < 0) continue;
    sumC.set(l, (sumC.get(l) || 0) + Math.cos(2 * orient[i]));
    sumS.set(l, (sumS.get(l) || 0) + Math.sin(2 * orient[i]));
  }
  const meanOf = (l) => 0.5 * Math.atan2(sumS.get(l), sumC.get(l));

  const adj = buildAdjacency(labels, w, h);
  const pairs = [];
  for (const [a, m] of adj) {
    for (const b of m.keys()) {
      if (a < b) pairs.push([orientDiff(meanOf(a), meanOf(b)), a, b]);
    }
  }
  pairs.sort((p, q) => p[0] - q[0]);

  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r);
    let cur = x;
    while (parent.get(cur) !== undefined && parent.get(cur) !== cur) {
      const nx = parent.get(cur);
      parent.set(cur, r);
      cur = nx;
    }
    return r;
  };
  for (const [d, a0, b0] of pairs) {
    if (d >= threshRad) break;
    const a = find(a0), b = find(b0);
    if (a === b) continue;
    if (orientDiff(meanOf(a), meanOf(b)) >= threshRad) continue; // 根已变化，重判
    parent.set(b, a);
    sumC.set(a, sumC.get(a) + sumC.get(b));
    sumS.set(a, sumS.get(a) + sumS.get(b));
  }
  const out = new Int32Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    out[i] = l < 0 ? -1 : find(l);
  }
  return out;
}

/**
 * 完整分析。params:
 *   coherenceThreshold 方向一致性阈值（默认 0.55）
 *   magnitudeThreshold 梯度强度阈值（默认 0.08）
 *   minArea            最小区域面积 px（默认 80）
 *   lowConfThreshold   低置信边界阈值（默认 0.35）
 *   mergeOrientDeg     相邻区域方向差小于该角度则合并（默认 8°）
 */
function analyze(gray, w, h, fields, params = {}) {
  const ct = Math.min(0.99, Math.max(0, num(params.coherenceThreshold, 0.55)));
  const mt = Math.min(1, Math.max(0, num(params.magnitudeThreshold, 0.08)));
  const minArea = Math.max(1, Math.round(num(params.minArea, 80)));
  const lowT = Math.min(1, Math.max(0, num(params.lowConfThreshold, 0.35)));
  const mergeRad = (Math.min(90, Math.max(0, num(params.mergeOrientDeg, 8))) * Math.PI) / 180;
  const n = w * h;
  const { orient, coherence, magN } = fields;

  // 候选纹理掩膜
  const mask = new Uint8Array(n);
  let maskCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (coherence[i] >= ct && magN[i] >= mt) { mask[i] = 1; maskCount++; }
    }
  }

  // 分水岭拆分粘连区域 → 小区域合并 → 方向相似区域并回
  const dist = distanceTransform(mask, w, h);
  const ws = watershed(dist, mask, w, h);
  let labels = mergeSmall(ws.labels, w, h, minArea);
  labels = mergeByOrientation(labels, w, h, orient, mergeRad);

  // 重新编号并收集每区域像素
  const idOf = new Map();
  const pixelsOf = new Map();
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l < 0) continue;
    if (!idOf.has(l)) { idOf.set(l, idOf.size + 1); pixelsOf.set(idOf.get(l), []); }
    pixelsOf.get(idOf.get(l)).push(i);
  }

  // 第一遍：区域统计（面积、质心、平均方向用倍角圆均值、平均一致性）
  const stats = new Map();
  for (const [id, pixels] of pixelsOf) {
    let sx = 0, sy = 0, sc = 0, s2c = 0, s2s = 0;
    for (const p of pixels) {
      sx += p % w; sy += (p / w) | 0; sc += coherence[p];
      s2c += Math.cos(2 * orient[p]); s2s += Math.sin(2 * orient[p]);
    }
    stats.set(id, {
      area: pixels.length,
      cx: sx / pixels.length,
      cy: sy / pixels.length,
      meanCoherence: sc / pixels.length,
      meanOrient: 0.5 * Math.atan2(s2s, s2c),
    });
  }

  // 第二遍：行行程（填充用）、边界与置信度
  const regions = [];
  for (const [id, pixels] of pixelsOf) {
    const st = stats.get(id);
    const runs = [];      // [y, x0, x1, ...]
    const boundary = [];  // [x, y, ...]
    const lowBoundary = [];
    let prevY = -1, prevX = -2;
    for (const p of pixels) {
      const x = p % w, y = (p / w) | 0;
      if (y === prevY && x === prevX + 1) runs[runs.length - 1] = x;
      else runs.push(y, x, x);
      prevY = y; prevX = x;

      // 4 邻域检查边界 + 置信度
      let isB = false, conf = 1;
      for (let k = 0; k < 4; k++) {
        const qx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const qy = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) { isB = true; conf = Math.min(conf, coherence[p]); continue; }
        const ql = labels[qy * w + qx];
        if (ql >= 0 && idOf.get(ql) === id) continue;
        isB = true;
        if (ql < 0) {
          // 与背景交界：置信度 = 局部方向一致性
          conf = Math.min(conf, coherence[p]);
        } else {
          // 与另一区域交界：方向差越小，边界越不可信
          const other = stats.get(idOf.get(ql));
          const dOri = other ? orientDiff(st.meanOrient, other.meanOrient) : Math.PI / 2;
          conf = Math.min(conf, coherence[p] * (dOri / (Math.PI / 2)));
        }
      }
      if (isB) {
        boundary.push(x, y);
        if (conf < lowT) lowBoundary.push(x, y);
      }
    }
    regions.push({
      id,
      areaPx: st.area,
      centroid: [Math.round(st.cx * 10) / 10, Math.round(st.cy * 10) / 10],
      meanOrientationDeg: Math.round(((st.meanOrient * 180) / Math.PI) * 10) / 10,
      meanCoherence: Math.round(st.meanCoherence * 1000) / 1000,
      runs, boundary, lowBoundary,
    });
  }
  regions.sort((a, b) => b.areaPx - a.areaPx);

  return {
    width: w,
    height: h,
    params: {
      coherenceThreshold: ct,
      magnitudeThreshold: mt,
      minArea,
      lowConfThreshold: lowT,
      mergeOrientDeg: Math.round((mergeRad * 180) / Math.PI * 100) / 100,
    },
    regionCount: regions.length,
    maskCoverage: Math.round((maskCount / n) * 10000) / 10000,
    regions,
  };
}

module.exports = { computeFields, analyze };
