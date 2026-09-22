'use strict';
// 两个已保存分区版本的区域对应（按像素重叠，即时计算，不落库）：
//   1) 由行行程（runs）重建两版本的逐像素区域标签
//   2) 单遍扫描累计 base 区域 × compare 区域的重叠像素数
//   3) 自身像素被另一版本覆盖比例低于重叠阈值的区域 → 新增 / 消失；
//      存活区域之间，重叠占“较小区域”比例 ≥ 阈值的边构成二部图，
//      按重叠量降序贪心归组（始终保持组为 1-1 / 1-n / n-1）：
//        1-1 未变（unchanged）/ 1-n 拆分（split）/ n-1 合并（merge）
//   4) 逐组汇总面积、平均方向（倍角圆均值）、低置信边界占比的变化

function num(v, dflt) {
  const x = Number(v);
  return Number.isFinite(x) ? x : dflt;
}

/** 由区域行行程重建逐像素标签图（背景为 -1）。 */
function labelsFromResult(result) {
  const { width, height, regions } = result;
  const labels = new Int32Array(width * height).fill(-1);
  for (const r of regions) {
    const runs = r.runs;
    for (let i = 0; i < runs.length; i += 3) {
      const row = runs[i] * width;
      for (let x = runs[i + 1]; x <= runs[i + 2]; x++) labels[row + x] = r.id;
    }
  }
  return labels;
}

function lowFracOf(r) {
  return r.boundary && r.boundary.length ? r.lowBoundary.length / r.boundary.length : 0;
}

/** 面积加权的平均方向（°，[-90,90]，无向纹理用倍角向量平均）。 */
function meanOrientDeg(regions) {
  let s2c = 0, s2s = 0, w = 0;
  for (const r of regions) {
    const rad = (num(r.meanOrientationDeg, 0) * Math.PI) / 180;
    s2c += Math.cos(2 * rad) * r.areaPx;
    s2s += Math.sin(2 * rad) * r.areaPx;
    w += r.areaPx;
  }
  if (!w) return null;
  let d = (0.5 * Math.atan2(s2s, s2c) * 180) / Math.PI;
  return Math.round(d * 10) / 10;
}

/** 无向方向差（°，[0,90]）。 */
function orientDeltaDeg(a, b) {
  if (a == null || b == null) return null;
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return Math.round(d * 10) / 10;
}

/** 一侧若干区域的聚合统计。 */
function sideStats(list) {
  if (!list.length) return null;
  let areaPx = 0, bnd = 0, low = 0;
  for (const r of list) {
    areaPx += r.areaPx;
    bnd += r.boundary ? r.boundary.length : 0;
    low += r.lowBoundary ? r.lowBoundary.length : 0;
  }
  return {
    areaPx,
    orientDeg: meanOrientDeg(list),
    lowFrac: bnd ? Math.round((low / bnd) * 10000) / 10000 : 0,
  };
}

function decorate(r) {
  return { ...r, lowFrac: Math.round(lowFracOf(r) * 10000) / 10000 };
}

/**
 * 比较两个 analyze() 结果。opts.overlapThreshold ∈ (0,1)，默认 0.5。
 * 返回 { width,height,overlapThreshold,summary,groups }，
 * groups 中区域对象保留 runs/boundary，供前端逐像素渲染差异叠加。
 */
function compareRegions(base, compare, opts = {}) {
  if (!base || !compare) throw new Error('缺少待比较的分区结果');
  if (base.width !== compare.width || base.height !== compare.height) {
    throw new Error('两个版本的图像尺寸不一致，无法逐像素比较');
  }
  const threshold = Math.min(0.95, Math.max(0.05, num(opts.overlapThreshold, 0.5)));
  const w = base.width, h = base.height;

  const baseRegions = new Map(base.regions.map((r) => [r.id, r]));
  const compRegions = new Map(compare.regions.map((r) => [r.id, r]));

  const lb = labelsFromResult(base);
  const lc = labelsFromResult(compare);

  // 重叠矩阵：baseId -> Map(compId -> pixels)
  const overlap = new Map();
  const totalB = new Map(), totalC = new Map();
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const b = lb[i], c = lc[i];
    if (b < 0 || c < 0) continue;
    let m = overlap.get(b);
    if (!m) overlap.set(b, (m = new Map()));
    m.set(c, (m.get(c) || 0) + 1);
    totalB.set(b, (totalB.get(b) || 0) + 1);
    totalC.set(c, (totalC.get(c) || 0) + 1);
  }

  // 覆盖率不足的区域直接判为消失 / 新增，不参与建图
  const aliveB = new Set(), aliveC = new Set();
  for (const r of base.regions) {
    if ((totalB.get(r.id) || 0) >= threshold * r.areaPx) aliveB.add(r.id);
  }
  for (const r of compare.regions) {
    if ((totalC.get(r.id) || 0) >= threshold * r.areaPx) aliveC.add(r.id);
  }

  // 显著重叠边（占较小区域比例 ≥ 阈值），按重叠量降序贪心归组
  const edges = [];
  for (const [b, m] of overlap) {
    for (const [c, o] of m) {
      if (!aliveB.has(b) || !aliveC.has(c)) continue;
      const denom = Math.min(baseRegions.get(b).areaPx, compRegions.get(c).areaPx);
      if (denom > 0 && o / denom >= threshold) edges.push({ b, c, o });
    }
  }
  edges.sort((e1, e2) => e2.o - e1.o);

  const groups = [];
  const groupOfB = new Map(), groupOfC = new Map();
  for (const { b, c, o } of edges) {
    const gb = groupOfB.get(b), gc = groupOfC.get(c);
    if (gb != null && gc != null) continue; // 跨组的多对多边：保持已确定的主对应
    if (gb == null && gc == null) {
      const g = { bases: new Set([b]), comps: new Set([c]), overlapPx: o };
      groups.push(g);
      groupOfB.set(b, g);
      groupOfC.set(c, g);
    } else if (gb != null) {
      // 只允许 1-n（一个 base 对多个 compare），否则跳过该边
      if (gb.bases.size === 1 && !groupOfC.has(c)) {
        gb.comps.add(c);
        gb.overlapPx += o;
        groupOfC.set(c, gb);
      }
    } else {
      // 只允许 n-1（多个 base 对一个 compare）
      if (gc.comps.size === 1 && !groupOfB.has(b)) {
        gc.bases.add(b);
        gc.overlapPx += o;
        groupOfB.set(b, gc);
      }
    }
  }
  for (const id of aliveB) if (!groupOfB.has(id)) groups.push({ bases: new Set([id]), comps: new Set(), overlapPx: 0 });
  for (const id of aliveC) if (!groupOfC.has(id)) groups.push({ bases: new Set(), comps: new Set([id]), overlapPx: 0 });

  // 定型 + 指标
  const out = [];
  for (const g of groups) {
    const bl = [...g.bases].map((id) => baseRegions.get(id));
    const cl = [...g.comps].map((id) => compRegions.get(id));
    let type;
    if (bl.length === 1 && cl.length === 1) type = 'unchanged';
    else if (bl.length === 1 && cl.length > 1) type = 'split';
    else if (bl.length > 1 && cl.length === 1) type = 'merge';
    else continue; // 理论上不会出现（建图时已约束）
    // 组内全部区域对的重叠总和（含非显著边，统计展示用）
    let ov = 0;
    for (const r of bl) {
      const m = overlap.get(r.id);
      if (!m) continue;
      for (const c of cl) ov += m.get(c.id) || 0;
    }
    const sb = sideStats(bl), sc = sideStats(cl);
    out.push({
      type,
      base: bl.map(decorate),
      compare: cl.map(decorate),
      overlapPx: ov,
      metrics: {
        base: sb,
        compare: sc,
        areaDeltaPx: sb && sc ? sc.areaPx - sb.areaPx : null,
        areaDeltaPct: sb && sc && sb.areaPx ? Math.round(((sc.areaPx - sb.areaPx) / sb.areaPx) * 1000) / 10 : null,
        orientDeltaDeg: sb && sc ? orientDeltaDeg(sb.orientDeg, sc.orientDeg) : null,
        lowDeltaPct: sb && sc ? Math.round((sc.lowFrac - sb.lowFrac) * 10000) / 100 : null, // 百分点
      },
    });
  }
  // 消失 / 新增
  for (const r of base.regions) {
    if (!aliveB.has(r.id)) {
      out.push({ type: 'removed', base: [decorate(r)], compare: [], overlapPx: 0, metrics: { base: sideStats([r]), compare: null, areaDeltaPx: null, areaDeltaPct: null, orientDeltaDeg: null, lowDeltaPct: null } });
    }
  }
  for (const r of compare.regions) {
    if (!aliveC.has(r.id)) {
      out.push({ type: 'added', base: [], compare: [decorate(r)], overlapPx: 0, metrics: { base: null, compare: sideStats([r]), areaDeltaPx: null, areaDeltaPct: null, orientDeltaDeg: null, lowDeltaPct: null } });
    }
  }

  const summary = { unchanged: 0, split: 0, merge: 0, added: 0, removed: 0 };
  for (const g of out) summary[g.type]++;
  // 稳定排序：类型固定顺序，组内按面积降序
  const order = { unchanged: 0, split: 1, merge: 2, added: 3, removed: 4 };
  out.sort((a, b) => {
    if (order[a.type] !== order[b.type]) return order[a.type] - order[b.type];
    const aa = (a.metrics.base || a.metrics.compare).areaPx;
    const bb = (b.metrics.base || b.metrics.compare).areaPx;
    return bb - aa;
  });

  return { width: w, height: h, overlapThreshold: threshold, summary, groups: out };
}

module.exports = { compareRegions };
