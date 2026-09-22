'use strict';
/* 前端逻辑：上传 / 阈值调节 / 叠加渲染 / 版本管理 / 版本差异比较 */

const $ = (id) => document.getElementById(id);

// ---------- 差异类型（颜色在差异叠加、图例、筛选、统计表中保持一致） ----------
const CHANGE_TYPES = {
  match: { label: '未变', color: '#9fb4c7' },
  split: { label: '拆分', color: '#ffb000' },
  merge: { label: '合并', color: '#b07bff' },
  new:   { label: '新增', color: '#2ee6a8' },
  lost:  { label: '消失', color: '#ff5a5a' },
};
const PREF_KEY = 'mtrv.prefs.v1';

const state = {
  image: null,      // 当前图像元数据
  result: null,     // 审阅模式当前分析结果（未保存或已载入版本）
  versions: [],
  mode: 'review',   // review | diff
  diff: {
    baseV: null,       // 基准版版本号
    compV: null,       // 对比版版本号
    cache: new Map(),  // version -> 完整 {version, params, result}
    seq: 0,            // 异步结果序号，防止乱序覆盖
    data: null,        // computeDiff() 的输出
    error: '',
  },
};

const prefs = loadPrefs();

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
  } catch (_) { return {}; }
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { /* 忽略存储失败 */ }
}

// ---------- 工具 ----------
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

function regionColor(id, alpha = 1) {
  return `hsla(${(id * 47) % 360}, 85%, 55%, ${alpha})`;
}

/** 无向方向差（周期 π），返回度数 ∈ [0, 90]。 */
function orientDeltaDeg(a, b) {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return Math.round(d * 10) / 10;
}

/** 低置信边界占比 = 低置信边界像素 / 全部边界像素。 */
function lowFraction(reg) {
  return reg.boundary.length ? reg.lowBoundary.length / reg.boundary.length : 0;
}

/** 多区域按面积加权的平均方向（倍角圆均值），返回度数 [-90, 90]。 */
function meanOrientationDeg(regs) {
  let s2c = 0, s2s = 0;
  for (const r of regs) {
    const rad = (r.meanOrientationDeg * Math.PI) / 180;
    s2c += Math.cos(2 * rad) * r.areaPx;
    s2s += Math.sin(2 * rad) * r.areaPx;
  }
  return Math.round(((0.5 * Math.atan2(s2s, s2c) * 180) / Math.PI) * 10) / 10;
}

function currentParams() {
  return {
    coherenceThreshold: Number($('ctSlider').value),
    magnitudeThreshold: Number($('mtSlider').value),
    minArea: Number($('maSlider').value),
    lowConfThreshold: Number($('lcSlider').value),
    mergeOrientDeg: Number($('moSlider').value),
  };
}

function setParams(p) {
  if (!p) return;
  if (p.coherenceThreshold != null) $('ctSlider').value = p.coherenceThreshold;
  if (p.magnitudeThreshold != null) $('mtSlider').value = p.magnitudeThreshold;
  if (p.minArea != null) $('maSlider').value = p.minArea;
  if (p.lowConfThreshold != null) $('lcSlider').value = p.lowConfThreshold;
  if (p.mergeOrientDeg != null) $('moSlider').value = p.mergeOrientDeg;
  syncSliderLabels();
}

function syncSliderLabels() {
  $('ctOut').textContent = $('ctSlider').value;
  $('mtOut').textContent = $('mtSlider').value;
  $('maOut').textContent = $('maSlider').value;
  $('lcOut').textContent = $('lcSlider').value;
  $('moOut').textContent = $('moSlider').value;
  $('ovOut').textContent = Number($('overlapSlider').value).toFixed(2);
}

// ---------- 图像列表 ----------
async function refreshImages(selectId = null) {
  const list = await api('/api/images');
  const ul = $('imageList');
  ul.innerHTML = '';
  for (const img of list) {
    const li = document.createElement('li');
    li.dataset.id = img.id;
    li.innerHTML = `#${img.id} ${img.name}<span class="meta">${img.width}×${img.height} · ${img.pixel_scale} µm/px · ${img.created_at}</span>`;
    li.onclick = () => loadImage(img.id);
    if (selectId === img.id) li.classList.add('active');
    ul.appendChild(li);
  }
  if (selectId != null) await loadImage(selectId);
}

// ---------- 载入图像 ----------
async function loadImage(id) {
  try {
    state.image = await api(`/api/images/${id}`);
    state.result = null;
    state.diff.cache.clear(); // 版本结果按图像缓存
    state.diff.data = null;
    state.diff.error = '';
    prefs.imageId = id;
    savePrefs();
    document.querySelectorAll('#imageList li').forEach((li) =>
      li.classList.toggle('active', Number(li.dataset.id) === id));

    const { width: w, height: h } = state.image;
    $('stage').style.aspectRatio = `${w} / ${h}`;
    $('placeholder').style.display = 'none';
    $('baseImg').src = `/api/images/${id}/preview.png`;
    $('oriImg').src = `/api/images/${id}/orientation.png`;
    const cv = $('overlay');
    cv.width = w; cv.height = h;
    cv.getContext('2d').clearRect(0, 0, w, h);

    $('scaleEdit').value = state.image.pixel_scale;
    $('analyzeBtn').disabled = false;
    $('saveBtn').disabled = true;
    $('saveScaleBtn').disabled = false;
    $('maskInfo').textContent = '';
    $('statsTable').innerHTML = '';
    await refreshVersions();

    // 恢复该图像保存过的差异选择；无记录时默认取最新两个版本
    const d = prefs.diffByImage && prefs.diffByImage[id];
    state.diff.baseV = d ? d.baseV : null;
    state.diff.compV = d ? d.compV : null;
    syncDiffSelects(true);
    render();
  } catch (e) { toast(e.message, true); }
}

// ---------- 版本 ----------
async function refreshVersions() {
  const sel = $('versionSelect');
  sel.innerHTML = '';
  state.versions = state.image ? await api(`/api/images/${state.image.id}/partitions`) : [];
  for (const v of state.versions) {
    const opt = document.createElement('option');
    opt.value = v.version;
    opt.textContent = `v${v.version} · ${v.created_at}`;
    sel.appendChild(opt);
  }
  const has = state.versions.length > 0;
  sel.disabled = !has;
  $('loadVersionBtn').disabled = !has;
  if (state.mode === 'diff') syncDiffSelects(false);
}

/** 重建差异模式两个版本下拉框，并在必要时修正失效/缺省选择。 */
function syncDiffSelects(allowReset) {
  const versions = state.versions; // 已按版本号降序
  const fill = (sel, val) => {
    sel.innerHTML = '';
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = `v${v.version} · ${v.created_at}`;
      sel.appendChild(opt);
    }
    sel.disabled = versions.length === 0;
    sel.value = val != null && versions.some((v) => v.version === val)
      ? val : (versions.length ? versions[versions.length - 1].version : '');
    return sel.value === '' ? null : Number(sel.value);
  };
  const baseSel = $('baseVersionSelect');
  const compSel = $('compareVersionSelect');
  if (state.diff.baseV == null && state.diff.compV == null && allowReset && versions.length >= 2) {
    // 默认：最新版为对比版，次新版为基准版
    state.diff.baseV = versions[1].version;
    state.diff.compV = versions[0].version;
  }
  state.diff.baseV = fill(baseSel, state.diff.baseV);
  state.diff.compV = fill(compSel, state.diff.compV);
  if (state.diff.baseV != null && state.diff.baseV === state.diff.compV) {
    // 同一版本无法比较：优先把基准版换成更早的一版
    const older = versions.find((v) => v.version !== state.diff.compV);
    state.diff.baseV = older ? older.version : null;
    if (state.diff.baseV != null) baseSel.value = state.diff.baseV;
  }
  saveDiffPrefs();
}

function saveDiffPrefs() {
  if (!state.image) return;
  prefs.diffByImage = prefs.diffByImage || {};
  if (state.diff.baseV == null && state.diff.compV == null) {
    delete prefs.diffByImage[state.image.id];
  } else {
    prefs.diffByImage[state.image.id] = { baseV: state.diff.baseV, compV: state.diff.compV };
  }
  savePrefs();
}

// ---------- 分析 ----------
async function runAnalyze(save) {
  if (!state.image) return;
  const btn = save ? $('saveBtn') : $('analyzeBtn');
  btn.disabled = true;
  try {
    const params = currentParams();
    const url = `/api/images/${state.image.id}/${save ? 'partitions' : 'analyze'}`;
    const data = await api(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    state.result = save ? data.result : data;
    $('saveBtn').disabled = false;
    if (save) {
      toast(`已保存版本 v${data.version}`);
      await refreshVersions();
    }
    $('maskInfo').textContent =
      `区域数 ${state.result.regionCount} · 掩膜覆盖率 ${(state.result.maskCoverage * 100).toFixed(1)}%`;
    render();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

// ---------- 模式切换 ----------
function setMode(mode) {
  state.mode = mode;
  $('modeReviewBtn').classList.toggle('active', mode === 'review');
  $('modeDiffBtn').classList.toggle('active', mode === 'diff');
  $('controlsPanel').hidden = mode !== 'review';
  $('diffPanel').hidden = mode !== 'diff';
  $('reviewToggles').hidden = mode !== 'review';
  $('reviewLegend').hidden = mode !== 'review';
  $('diffToggles').hidden = mode !== 'diff';
  $('diffLegend').hidden = mode !== 'diff';
  $('diffFilters').hidden = mode !== 'diff';
  prefs.mode = mode;
  savePrefs();
  if (mode === 'diff') {
    syncDiffSelects(true);
    updateDiff();
  } else {
    render();
  }
}

// ---------- 版本差异 ----------
async function fetchVersion(v) {
  const d = state.diff;
  if (!d.cache.has(v)) {
    d.cache.set(v, await api(`/api/images/${state.image.id}/partitions/${v}`));
  }
  return d.cache.get(v);
}

async function updateDiff() {
  const d = state.diff;
  if (state.mode !== 'diff' || !state.image) return;
  const summary = $('diffSummary');
  const tbl = $('statsTable');
  if (state.versions.length < 2) {
    d.data = null;
    d.error = '该图像保存的分区版本不足 2 个，请先在审阅模式保存至少两个版本。';
    summary.textContent = '';
    tbl.innerHTML = '';
    render();
    return;
  }
  if (d.baseV == null || d.compV == null || d.baseV === d.compV) {
    d.data = null;
    d.error = '';
    render();
    return;
  }
  const seq = ++d.seq;
  summary.textContent = `比较中：v${d.baseV} → v${d.compV} …`;
  try {
    const [base, comp] = await Promise.all([fetchVersion(d.baseV), fetchVersion(d.compV)]);
    if (seq !== d.seq) return; // 已被更新的选择取代
    d.data = computeDiff(base.result, comp.result, Number($('overlapSlider').value));
    d.error = '';
    render();
  } catch (e) {
    if (seq === d.seq) { d.data = null; d.error = e.message; render(); toast(e.message, true); }
  }
}

/**
 * 按像素重叠建立两个版本间的区域对应关系。
 * 阈值 t = 交集面积 / min(两边区域面积)；≥ t 的重叠计为一条对应边
 * （一个区域可保留多条边，以表达一对多 / 多对一），再对二分图取连通分量：
 *   1-1 未变；1-N 拆分；N-1 合并；N-M 重组（两侧分别计入拆分与合并行）；
 *   无边的基准区域=消失，无边的对比区域=新增。
 */
function computeDiff(base, comp, threshold) {
  const w = base.width, h = base.height, n = w * h;
  const bMap = new Map(); // id -> region
  const cMap = new Map();
  for (const reg of base.regions) bMap.set(reg.id, reg);
  for (const reg of comp.regions) cMap.set(reg.id, reg);

  // 分别建立两版的像素标签图，再逐像素统计区域间交集
  const bLab = new Int32Array(n).fill(-1);
  for (const reg of base.regions) {
    for (let k = 0; k < reg.runs.length; k += 3) {
      const y = reg.runs[k], x0 = reg.runs[k + 1], x1 = reg.runs[k + 2];
      for (let p = y * w + x0, end = y * w + x1; p <= end; p++) bLab[p] = reg.id;
    }
  }
  const cLab = new Int32Array(n).fill(-1);
  for (const reg of comp.regions) {
    for (let k = 0; k < reg.runs.length; k += 3) {
      const y = reg.runs[k], x0 = reg.runs[k + 1], x1 = reg.runs[k + 2];
      for (let p = y * w + x0, end = y * w + x1; p <= end; p++) cLab[p] = reg.id;
    }
  }
  // 像素级交集计数：key = bId * 2^32 + cId（区域 id 远小于 2^32，无碰撞）
  const MID = 4294967296;
  const overlaps = new Map();
  for (let p = 0; p < n; p++) {
    const b = bLab[p], c = cLab[p];
    if (b < 0 || c < 0) continue;
    const key = b * MID + c;
    overlaps.set(key, (overlaps.get(key) || 0) + 1);
  }

  // 交叠系数 = 交集 / min(两边面积) ≥ threshold 即建立对应边；
  // 一个区域可保留多条边，以表达一对多 / 多对一
  const edgesByB = new Map();
  for (const [key, cnt] of overlaps) {
    const b = Math.floor(key / MID), c = key % MID;
    const coef = cnt / Math.min(bMap.get(b).areaPx, cMap.get(c).areaPx);
    if (coef < threshold) continue;
    const e = { b, c, overlap: cnt, coef };
    if (!edgesByB.has(b)) edgesByB.set(b, []);
    edgesByB.get(b).push(e);
  }

  // 并查集
  const parent = new Map();
  const keyB = (id) => 'b' + id, keyC = (id) => 'c' + id;
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
  const union = (x, y) => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(ry, rx);
  };
  for (const reg of base.regions) parent.set(keyB(reg.id), keyB(reg.id));
  for (const reg of comp.regions) parent.set(keyC(reg.id), keyC(reg.id));
  for (const [, es] of edgesByB) {
    for (const e of es) { union(keyB(e.b), keyC(e.c)); }
  }

  // 按连通分量收集
  const groups = new Map(); // root -> {b:Set, c:Set}
  const groupFor = (k) => {
    const r = find(k);
    let g = groups.get(r);
    if (!g) { g = { b: new Set(), c: new Set() }; groups.set(r, g); }
    return g;
  };
  for (const id of bMap.keys()) groupFor(keyB(id)).b.add(id);
  for (const id of cMap.keys()) groupFor(keyC(id)).c.add(id);

  const rows = [];
  const paint = new Map(); // 区域 key（b:/c: + id）-> 差异类型
  const counts = { match: 0, split: 0, merge: 0, new: 0, lost: 0 };
  let groupNo = 0;

  for (const g of groups.values()) {
    const nb = g.b.size, nc = g.c.size;
    const gno = ++groupNo;
    if (nb === 1 && nc === 1) {
      const bid = [...g.b][0], cid = [...g.c][0];
      paint.set('b' + bid, 'match');
      paint.set('c' + cid, 'match');
      const edge = (edgesByB.get(bid) || []).find((e) => e.c === cid);
      rows.push({ type: 'match', gno, bIds: [bid], cIds: [cid], overlap: edge ? edge.overlap : 0 });
      counts.match++;
    } else if (nb === 0 && nc === 1) {
      const cid = [...g.c][0];
      paint.set('c' + cid, 'new');
      rows.push({ type: 'new', gno, bIds: [], cIds: [cid] });
      counts.new++;
    } else if (nb === 1 && nc === 0) {
      const bid = [...g.b][0];
      paint.set('b' + bid, 'lost');
      rows.push({ type: 'lost', gno, bIds: [bid], cIds: [] });
      counts.lost++;
    } else {
      // 多对多分量：
      //   1-N → 拆分（基准 1 块 + 对比 N 块均标“拆分”色）
      //   N-1 → 合并（基准 N 块 + 对比 1 块均标“合并”色）
      //   N-M → 重组：两侧各按“自身被拆 / 与它块合并”的角色着色，
      //         基准侧画合并紫、对比侧画拆分橙，并分别计入统计表
      const isSplit = nc >= 2;
      const isMerge = nb >= 2;
      for (const bid of g.b) paint.set('b' + bid, isMerge ? 'merge' : 'split');
      for (const cid of g.c) paint.set('c' + cid, isSplit ? 'split' : 'merge');
      if (isSplit) {
        for (const bid of g.b) {
          rows.push({ type: 'split', gno, bIds: [bid], cIds: [...g.c] });
          counts.split++;
        }
      }
      if (isMerge) {
        for (const cid of g.c) {
          rows.push({ type: 'merge', gno, bIds: [...g.b], cIds: [cid] });
          counts.merge++;
        }
      }
    }
  }

  // 行排序：类型（拆分/合并/未变/新增/消失）→ 组号 → 对比区域最大面积
  const order = { split: 0, merge: 1, match: 2, new: 3, lost: 4 };
  rows.sort((x, y) => order[x.type] - order[y.type] || x.gno - y.gno ||
    Math.max(...x.cIds.map((id) => cMap.get(id)?.areaPx || 0)) -
    Math.max(...y.cIds.map((id) => cMap.get(id)?.areaPx || 0)));

  return { base, comp, w, h, bMap, cMap, rows, paint, counts };
}

// ---------- 渲染总入口 ----------
function render() {
  syncImageLayers();
  const cv = $('overlay');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (state.mode === 'diff') renderDiff(ctx, cv);
  else renderReview(ctx, cv);
  renderStats();
}

function syncImageLayers() {
  const diff = state.mode === 'diff';
  const view = diff ? getDiffView() : null;
  $('baseImg').style.display = (!diff && $('showBase').checked) ||
    (diff && view === 'overlay' && $('diffShowBase').checked) ? 'block' : 'none';
  $('oriImg').style.display = !diff && $('showOri').checked ? 'block' : 'none';
  $('oriImg').style.opacity = $('oriOpacity').value;
}

function getDiffView() {
  const el = document.querySelector('input[name="diffView"]:checked');
  return el ? el.value : 'overlay';
}

// ---------- 审阅模式渲染 ----------
function renderReview(ctx, cv) {
  const r = state.result;
  if (!r) return;

  const showFill = $('showFill').checked;
  const showContour = $('showContour').checked;
  const showLow = $('showLow').checked;

  for (const reg of r.regions) {
    const color = regionColor(reg.id);
    if (showFill) {
      ctx.fillStyle = regionColor(reg.id, 0.25);
      const runs = reg.runs;
      for (let i = 0; i < runs.length; i += 3) {
        ctx.fillRect(runs[i + 1], runs[i], runs[i + 2] - runs[i + 1] + 1, 1);
      }
    }
    if (showContour) {
      ctx.fillStyle = color;
      const b = reg.boundary;
      for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i], b[i + 1], 1, 1);
    }
    if (showLow) {
      ctx.fillStyle = '#ffe600';
      const lb = reg.lowBoundary;
      for (let i = 0; i < lb.length; i += 2) ctx.fillRect(lb[i] - 1, lb[i + 1] - 1, 3, 3);
    }
  }
  // 区域编号标注
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 3;
  ctx.font = `bold ${Math.max(12, Math.round(cv.width / 45))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const reg of r.regions) {
    const [cx, cy] = reg.centroid;
    ctx.strokeText(String(reg.id), cx, cy);
    ctx.fillText(String(reg.id), cx, cy);
  }
}

/** 以单版分区结果绘制（差异模式的“基准版 / 对比版”视图）。 */
function renderSingleVersion(ctx, cv, result, tag) {
  for (const reg of result.regions) {
    ctx.fillStyle = regionColor(reg.id, 0.22);
    for (let i = 0; i < reg.runs.length; i += 3) {
      ctx.fillRect(reg.runs[i + 1], reg.runs[i], reg.runs[i + 2] - reg.runs[i + 1] + 1, 1);
    }
  }
  for (const reg of result.regions) {
    ctx.fillStyle = regionColor(reg.id);
    const b = reg.boundary;
    for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i], b[i + 1], 1, 1);
  }
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 3;
  ctx.font = `bold ${Math.max(12, Math.round(cv.width / 45))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const reg of result.regions) {
    const [cx, cy] = reg.centroid;
    const text = `${tag}${reg.id}`;
    ctx.strokeText(text, cx, cy);
    ctx.fillText(text, cx, cy);
  }
}

/** 把一行行程按给定颜色填充到画布。 */
function fillRuns(ctx, runs, style) {
  ctx.fillStyle = style;
  for (let i = 0; i < runs.length; i += 3) {
    ctx.fillRect(runs[i + 1], runs[i], runs[i + 2] - runs[i + 1] + 1, 1);
  }
}

// ---------- 差异模式渲染 ----------
function renderDiff(ctx, cv) {
  const d = state.diff;
  if (!state.image) return;
  if (state.versions.length < 2) { return; } // 提示文案在统计表区展示
  if (d.baseV == null || d.compV == null || d.baseV === d.compV) return;

  const view = getDiffView();
  if (!d.data) return;

  if (view === 'base') {
    renderSingleVersion(ctx, cv, d.data.base, '');
    return;
  }
  if (view === 'compare') {
    renderSingleVersion(ctx, cv, d.data.comp, '');
    return;
  }

  // 差异叠加：先半透明填充（按类型稳定着色），再描边界
  const { bMap, cMap, paint } = d.data;
  const alpha = $('diffShowBase').checked ? 0.5 : 0.62;
  for (const reg of cMap.values()) {
    const t = paint.get('c' + reg.id) || 'new';
    fillRuns(ctx, reg.runs, CHANGE_TYPES[t].color + alphaToHex(alpha));
  }
  for (const reg of bMap.values()) {
    const t = paint.get('b' + reg.id) || 'lost';
    if (t === 'match') continue; // 未变区域两版重合，避免重复描边
    fillRuns(ctx, reg.runs, CHANGE_TYPES[t].color + alphaToHex(alpha * 0.55));
  }
  // 对比版边界按类型着色；基准版仅描“消失/拆分/合并”边界
  ctx.globalCompositeOperation = 'source-over';
  for (const reg of cMap.values()) {
    ctx.fillStyle = CHANGE_TYPES[paint.get('c' + reg.id) || 'new'].color;
    const b = reg.boundary;
    for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i], b[i + 1], 1, 1);
  }
  for (const reg of bMap.values()) {
    const t = paint.get('b' + reg.id) || 'lost';
    if (t === 'match') continue;
    ctx.fillStyle = CHANGE_TYPES[t].color;
    const b = reg.boundary;
    for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i], b[i + 1], 1, 1);
  }

  // 质心标签：对比版区域用其类型颜色，前缀 ± 区分新增/消失
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 3;
  ctx.font = `bold ${Math.max(11, Math.round(cv.width / 55))}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelFor = (reg, prefix, type) => {
    const [cx, cy] = reg.centroid;
    ctx.fillStyle = CHANGE_TYPES[type].color;
    const text = prefix + reg.id;
    ctx.strokeText(text, cx, cy);
    ctx.fillText(text, cx, cy);
  };
  for (const reg of cMap.values()) {
    const t = paint.get('c' + reg.id) || 'new';
    labelFor(reg, t === 'new' ? '+' : '', t);
  }
  for (const reg of bMap.values()) {
    const t = paint.get('b' + reg.id) || 'lost';
    if (t === 'match') continue;
    labelFor(reg, t === 'lost' ? '−' : '', t);
  }
}

function alphaToHex(a) {
  return Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0');
}

// ---------- 统计表 ----------
function renderStats() {
  const tbl = $('statsTable');
  if (state.mode === 'diff') { renderDiffStats(tbl); return; }
  const r = state.result;
  if (!r) { tbl.innerHTML = ''; return; }
  const scale = Number($('scaleEdit').value) || state.image.pixel_scale || 1;
  let html = '<tr><th>区域</th><th>面积 (px)</th><th>面积 (µm²)</th><th>质心 (px)</th>' +
    '<th>平均方向 (°)</th><th>平均一致性</th><th>低置信边界占比</th></tr>';
  for (const reg of r.regions) {
    const areaUm2 = reg.areaPx * scale * scale;
    const lowFracTxt = reg.boundary.length
      ? (lowFraction(reg) * 100).toFixed(1) + '%' : '—';
    html += `<tr><td><span class="region-chip" style="background:${regionColor(reg.id)}"></span>#${reg.id}</td>` +
      `<td>${reg.areaPx}</td><td>${areaUm2.toFixed(1)}</td>` +
      `<td>(${reg.centroid[0]}, ${reg.centroid[1]})</td>` +
      `<td>${reg.meanOrientationDeg}</td><td>${reg.meanCoherence}</td><td>${lowFracTxt}</td></tr>`;
  }
  tbl.innerHTML = html;
}

function fmtPct(v) { return (v * 100).toFixed(1) + '%'; }
function fmtDeltaPct(v) { return (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }
function fmtDelta(v, digits = 1, unit = '') {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + unit;
}

function typeEnabled(type) {
  const cb = document.querySelector(`.type-filter[value="${type}"]`);
  return !cb || cb.checked;
}

function renderDiffStats(tbl) {
  const d = state.diff;
  for (const t of Object.keys(CHANGE_TYPES)) $('cnt-' + t).textContent = d.data ? d.data.counts[t] : 0;

  if (!state.image) { tbl.innerHTML = ''; return; }
  if (state.versions.length < 2 || d.baseV == null || d.compV == null) {
    tbl.innerHTML = `<tr><td class="diff-empty">${d.error || '该图像保存的分区版本不足 2 个，请先在审阅模式保存至少两个版本。'}</td></tr>`;
    $('diffSummary').textContent = state.versions.length < 2 ? '' : '请选择两个不同的版本。';
    return;
  }
  if (!d.data) {
    tbl.innerHTML = '<tr><td class="diff-empty">比较中…</td></tr>';
    return;
  }

  const scale = Number($('scaleEdit').value) || state.image.pixel_scale || 1;
  const { bMap, cMap, rows, counts } = d.data;
  const c = counts;
  $('diffSummary').innerHTML =
    `基准版 <b>v${d.baseV}</b> → 对比版 <b>v${d.compV}</b> · 重叠阈值 <b>${Number($('overlapSlider').value).toFixed(2)}</b>：` +
    `未变 ${c.match} · 拆分组 ${c.split} · 合并组 ${c.merge} · 新增 ${c.new} · 消失 ${c.lost}`;

  let html = '<tr><th>类型</th><th>基准版区域</th><th>对比版区域</th>' +
    '<th>面积变化 (px / µm²)</th><th>方向变化 (°)</th><th>低置信边界占比变化</th><th>像素重叠</th></tr>';
  let shown = 0;
  for (const row of rows) {
    if (!typeEnabled(row.type)) continue;
    shown++;
    html += diffRowHtml(row, scale, bMap, cMap);
  }
  if (!shown) html += '<tr><td class="diff-empty" colspan="7">当前筛选条件下没有对应记录。</td></tr>';
  tbl.innerHTML = html;
}

function diffRowHtml(row, scale, bMap, cMap) {
  const type = CHANGE_TYPES[row.type];
  const typeCell = `<td><span class="type-badge" style="background:${type.color}">${type.label}</span></td>`;
  const bCell = `<td>${row.bIds.map((id) => `<span class="id-chip">#${id}</span>`).join(' ') || '<span class="dim">—</span>'}</td>`;
  const cCell = `<td>${row.cIds.map((id) => `<span class="id-chip">#${id}</span>`).join(' ') || '<span class="dim">—</span>'}</td>`;

  const bRegs = row.bIds.map((id) => bMap.get(id));
  const cRegs = row.cIds.map((id) => cMap.get(id));
  const bArea = bRegs.reduce((s, r) => s + r.areaPx, 0);
  const cArea = cRegs.reduce((s, r) => s + r.areaPx, 0);

  let areaCell = '<td class="dim">—</td>';
  let oriCell = '<td class="dim">—</td>';
  let lowCell = '<td class="dim">—</td>';
  let overlapCell = '<td class="dim">—</td>';

  if (row.type === 'match') {
    const b = bRegs[0], c = cRegs[0];
    const dA = cArea - bArea;
    areaCell = `<td>${bArea} → ${cArea} px（${fmtDeltaPct(bArea ? dA / bArea : 0)}）<br>` +
      `<span class="dim">${(bArea * scale * scale).toFixed(1)} → ${(cArea * scale * scale).toFixed(1)} µm²</span></td>`;
    oriCell = `<td>${b.meanOrientationDeg}° → ${c.meanOrientationDeg}°（Δ ${fmtDelta(orientDeltaDeg(b.meanOrientationDeg, c.meanOrientationDeg), 1, '°')}）</td>`;
    const lb = lowFraction(b), lc = lowFraction(c);
    lowCell = `<td>${fmtPct(lb)} → ${fmtPct(lc)}（${fmtDeltaPct(lc - lb)}）</td>`;
    overlapCell = `<td>${row.overlap.toLocaleString()} px<br><span class="dim">占基准 ${fmtPct(row.overlap / bArea)} · 占对比 ${fmtPct(row.overlap / cArea)}</span></td>`;
  } else if (row.type === 'split') {
    // 一行 = 一个基准区域 → 多个对比区域
    const b = bRegs[0];
    areaCell = `<td>${bArea} → ${cArea} px（合计，${fmtDeltaPct(bArea ? (cArea - bArea) / bArea : 0)}）<br>` +
      `<span class="dim">拆为 ${cRegs.length} 块，单块 ${Math.min(...cRegs.map((r) => r.areaPx))}–${Math.max(...cRegs.map((r) => r.areaPx))} px</span></td>`;
    oriCell = `<td>${b.meanOrientationDeg}° → ${meanOrientationDeg(cRegs)}°（各块加权均值，Δ ${fmtDelta(orientDeltaDeg(b.meanOrientationDeg, meanOrientationDeg(cRegs)), 1, '°')}）</td>`;
    const lb = lowFraction(b), lw = cRegs.reduce((s, r) => s + r.lowBoundary.length, 0),
      bt = cRegs.reduce((s, r) => s + r.boundary.length, 0);
    const lcAvg = bt ? lw / bt : 0;
    lowCell = `<td>${fmtPct(lb)} → ${fmtPct(lcAvg)}（合计边界，${fmtDeltaPct(lcAvg - lb)}）</td>`;
  } else if (row.type === 'merge') {
    // 一行 = 多个基准区域 → 一个对比区域
    const c = cRegs[0];
    areaCell = `<td>${bArea} → ${cArea} px（合计，${fmtDeltaPct(bArea ? (cArea - bArea) / bArea : 0)}）<br>` +
      `<span class="dim">由 ${bRegs.length} 块合并</span></td>`;
    oriCell = `<td>${meanOrientationDeg(bRegs)}° → ${c.meanOrientationDeg}°（各块加权均值，Δ ${fmtDelta(orientDeltaDeg(meanOrientationDeg(bRegs), c.meanOrientationDeg), 1, '°')}）</td>`;
    const lb = (() => { const lw = bRegs.reduce((s, r) => s + r.lowBoundary.length, 0), bt = bRegs.reduce((s, r) => s + r.boundary.length, 0); return bt ? lw / bt : 0; })();
    lowCell = `<td>${fmtPct(lb)} → ${fmtPct(lowFraction(c))}（${fmtDeltaPct(lowFraction(c) - lb)}）</td>`;
  } else if (row.type === 'new') {
    areaCell = `<td class="new-val">+${cArea} px<br><span class="dim">+${(cArea * scale * scale).toFixed(1)} µm²</span></td>`;
    const c = cRegs[0];
    lowCell = `<td class="new-val">— → ${fmtPct(lowFraction(c))}</td>`;
  } else if (row.type === 'lost') {
    const b = bRegs[0];
    areaCell = `<td class="lost-val">−${bArea} px<br><span class="dim">−${(bArea * scale * scale).toFixed(1)} µm²</span></td>`;
    lowCell = `<td class="lost-val">${fmtPct(lowFraction(b))} → —</td>`;
  }

  return `<tr class="row-${row.type}">${typeCell}${bCell}${cCell}${areaCell}${oriCell}${lowCell}${overlapCell}</tr>`;
}

// ---------- 事件绑定 ----------
$('uploadBtn').onclick = async () => {
  const f = $('fileInput').files[0];
  if (!f) return toast('请先选择图像文件', true);
  try {
    const img = await api('/api/images', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(f.name),
        'X-Pixel-Scale': $('pixelScaleInput').value || '1',
      },
      body: f,
    });
    toast(`已上传 #${img.id} ${img.name}`);
    await refreshImages(img.id);
  } catch (e) { toast(e.message, true); }
};

$('demoBtn').onclick = async () => {
  try {
    const img = await api('/api/demo', { method: 'POST' });
    toast('已生成演示图像');
    await refreshImages(img.id);
  } catch (e) { toast(e.message, true); }
};

$('analyzeBtn').onclick = () => runAnalyze(false);
$('saveBtn').onclick = () => runAnalyze(true);

$('loadVersionBtn').onclick = async () => {
  const v = $('versionSelect').value;
  if (!v || !state.image) return;
  try {
    const data = await api(`/api/images/${state.image.id}/partitions/${v}`);
    state.result = data.result;
    setParams(data.params);
    $('saveBtn').disabled = false;
    $('maskInfo').textContent =
      `已载入 v${data.version} · 区域数 ${data.result.regionCount} · 掩膜覆盖率 ${(data.result.maskCoverage * 100).toFixed(1)}%`;
    render();
  } catch (e) { toast(e.message, true); }
};

$('saveScaleBtn').onclick = async () => {
  if (!state.image) return;
  try {
    state.image = await api(`/api/images/${state.image.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pixelScale: Number($('scaleEdit').value) }),
    });
    toast('像素尺度已更新');
    render();
  } catch (e) { toast(e.message, true); }
};

// 模式切换
$('modeReviewBtn').onclick = () => setMode('review');
$('modeDiffBtn').onclick = () => setMode('diff');

// 差异控件
$('baseVersionSelect').onchange = () => {
  state.diff.baseV = Number($('baseVersionSelect').value);
  syncDiffSelects(false); // 防止基准/对比选成同一版本
  saveDiffPrefs();
  updateDiff();
};
$('compareVersionSelect').onchange = () => {
  state.diff.compV = Number($('compareVersionSelect').value);
  syncDiffSelects(false);
  saveDiffPrefs();
  updateDiff();
};
$('overlapSlider').oninput = () => {
  syncSliderLabels();
  prefs.overlap = Number($('overlapSlider').value);
  savePrefs();
  updateDiff();
};
document.querySelectorAll('input[name="diffView"]').forEach((el) => {
  el.onchange = () => {
    prefs.diffView = getDiffView();
    savePrefs();
    render();
  };
});
$('diffShowBase').onchange = () => {
  prefs.diffShowBase = $('diffShowBase').checked;
  savePrefs();
  render();
};
document.querySelectorAll('.type-filter').forEach((cb) => {
  cb.onchange = () => {
    prefs.typeFilters = [...document.querySelectorAll('.type-filter')]
      .reduce((acc, x) => (acc[x.value] = x.checked, acc), {});
    savePrefs();
    renderStats();
  };
});

for (const id of ['ctSlider', 'mtSlider', 'maSlider', 'lcSlider', 'moSlider']) {
  $(id).oninput = syncSliderLabels;
}
for (const id of ['showBase', 'showOri', 'showFill', 'showContour', 'showLow', 'oriOpacity']) {
  $(id).oninput = render;
}
$('scaleEdit').onchange = renderStats;

// ---------- 启动：恢复刷新前的模式、阈值、视图、筛选与版本选择 ----------
(async function boot() {
  syncSliderLabels();
  if (prefs.overlap != null) $('overlapSlider').value = prefs.overlap;
  if (prefs.diffView) {
    const radio = document.querySelector(`input[name="diffView"][value="${prefs.diffView}"]`);
    if (radio) radio.checked = true;
  }
  $('diffShowBase').checked = !!prefs.diffShowBase;
  if (prefs.typeFilters) {
    for (const cb of document.querySelectorAll('.type-filter')) {
      if (prefs.typeFilters[cb.value] != null) cb.checked = prefs.typeFilters[cb.value];
    }
  }
  syncSliderLabels();

  await refreshImages();
  // 载入刷新前查看的图像（loadImage 会恢复该图像保存的版本选择）
  if (prefs.imageId && (!state.image || state.image.id !== prefs.imageId)) {
    const exists = document.querySelector(`#imageList li[data-id="${prefs.imageId}"]`);
    if (exists) await loadImage(Number(prefs.imageId));
  }
  setMode(prefs.mode === 'diff' ? 'diff' : 'review');
})();
