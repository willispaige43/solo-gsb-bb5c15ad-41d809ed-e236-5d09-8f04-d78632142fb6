'use strict';
/* 前端逻辑：
   审阅模式：上传 / 阈值调节 / 叠加渲染 / 版本管理
   版本差异模式：选择两个已保存版本，即时计算像素重叠对应关系，
               基准版 / 对比版 / 差异叠加三视图 + 按变化类型筛选统计。
   模式、版本选择与筛选状态持久化到 localStorage，刷新后恢复。 */

const $ = (id) => document.getElementById(id);

const DIFF_TYPES = ['unchanged', 'split', 'merge', 'added', 'removed'];
const TYPE_LABEL = { unchanged: '未变', split: '拆分', merge: '合并', added: '新增', removed: '消失' };
const TYPE_COLOR = {
  unchanged: '#4cd964',
  split: '#ffb02e',
  merge: '#b47bff',
  added: '#39c7ff',
  removed: '#ff5a5a',
};
const PREFS_KEY = 'mt-review-prefs-v1';

const state = {
  image: null,     // 当前图像元数据
  result: null,    // 审阅模式：当前分析结果（未保存或已载入版本）
  versions: [],
  mode: 'review',  // review | diff
  diff: {
    baseVersion: null,
    compareVersion: null,
    data: null,    // 服务器返回的 compare 结果
    filters: { unchanged: true, split: true, merge: true, added: true, removed: true },
  },
};

// ---------- 偏好持久化 ----------
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; }
  catch (_) { return {}; }
}
function savePrefs() {
  const p = loadPrefs();
  Object.assign(p, {
    mode: state.mode,
    imageId: state.image ? state.image.id : null,
    diffView: (document.querySelector('input[name="diffView"]:checked') || {}).value,
    overlapThreshold: Number($('otSlider').value),
    filters: { ...state.diff.filters },
    diffShowBase: $('diffShowBase').checked,
    diffOpacity: Number($('diffOpacity').value),
    diffShowLabel: $('diffShowLabel').checked,
  });
  // 两个版本的选择按图像分别记忆
  p.selectionByImage = p.selectionByImage || {};
  if (state.image) {
    p.selectionByImage[state.image.id] = {
      base: state.diff.baseVersion,
      compare: state.diff.compareVersion,
    };
  }
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { /* 隐私模式等 */ }
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
  $('otOut').textContent = Number($('otSlider').value).toFixed(2);
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
    state.diff.data = null;
    state.diff.baseVersion = null;
    state.diff.compareVersion = null;
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
    $('diffStatsTable').innerHTML = '';
    for (const t of DIFF_TYPES) $('cnt-' + t).textContent = '0';
    $('diffInfo').textContent = '';
    await refreshVersions();
    savePrefs();
    draw();
  } catch (e) { toast(e.message, true); }
}

// ---------- 版本 ----------
async function refreshVersions(selectVersion = null) {
  // 审阅模式下拉
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
  if (selectVersion != null) sel.value = selectVersion;

  // 差异模式两个下拉：尽量保留当前选择，仅在首次/失效时回落到偏好或最新两版
  const vers = state.versions.map((v) => v.version);
  for (const id of ['baseVersionSel', 'compareVersionSel']) {
    const s = $(id);
    const prev = s.value;
    s.innerHTML = '';
    for (const v of state.versions) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = `v${v.version} · ${v.created_at}`;
      s.appendChild(opt);
    }
    s.disabled = state.versions.length < 2;
    if (prev && state.versions.some((v) => String(v.version) === prev)) s.value = prev;
  }
  if (state.diff.baseVersion == null || !vers.includes(state.diff.baseVersion) ||
      state.diff.compareVersion == null || !vers.includes(state.diff.compareVersion)) {
    restoreDiffSelection();
  } else {
    $('baseVersionSel').value = state.diff.baseVersion;
    $('compareVersionSel').value = state.diff.compareVersion;
    if (state.mode === 'diff') scheduleCompare();
  }
}

/** 载入图像后，按持久化偏好恢复两个版本选择（缺省时取最新的两个版本）。 */
function restoreDiffSelection() {
  const prefs = loadPrefs();
  const vers = state.versions.map((v) => v.version);
  const savedSel = prefs.selectionByImage && state.image ? prefs.selectionByImage[state.image.id] : null;
  const pick = (want, fallback) =>
    (want != null && vers.includes(Number(want))) ? Number(want) : fallback;
  // 默认基准取较早版本、对比取较新版本；版本列表本身按版本号降序
  const desc = [...vers].sort((a, b) => b - a);
  let b = pick(state.diff.baseVersion ?? (savedSel && savedSel.base), desc[1] ?? desc[0]);
  let c = pick(state.diff.compareVersion ?? (savedSel && savedSel.compare), desc[0]);
  if (b === c && vers.length > 1) c = vers.find((v) => v !== b);
  state.diff.baseVersion = b ?? null;
  state.diff.compareVersion = c ?? null;
  if (b != null) $('baseVersionSel').value = b;
  if (c != null) $('compareVersionSel').value = c;
  if (state.mode === 'diff') scheduleCompare();
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
      await refreshVersions(data.version);
    }
    $('maskInfo').textContent =
      `区域数 ${state.result.regionCount} · 掩膜覆盖率 ${(state.result.maskCoverage * 100).toFixed(1)}%`;
    draw();
    renderStats();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

// ---------- 审阅模式叠加渲染 ----------
function drawRegions(ctx, r, opts = {}) {
  const showFill = opts.fill !== false;
  const showContour = opts.contour !== false;
  const showLow = opts.low !== false;
  const showLabels = opts.labels !== false;
  const cv = ctx.canvas;
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
  if (showLabels) {
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
}

function drawReview() {
  const cv = $('overlay');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  $('baseImg').style.display = $('showBase').checked ? 'block' : 'none';
  $('oriImg').style.display = $('showOri').checked ? 'block' : 'none';
  $('oriImg').style.opacity = $('oriOpacity').value;
  if (state.result) {
    drawRegions(ctx, state.result, {
      fill: $('showFill').checked,
      contour: $('showContour').checked,
      low: $('showLow').checked,
    });
  }
}

// ---------- 差异模式 ----------
function resultFromDiffSide(side) {
  const d = state.diff.data;
  if (!d) return null;
  const regions = d.groups.flatMap((g) => g[side]);
  return { width: d.width, height: d.height, regions };
}

/** 差异叠加逐像素渲染到离屏画布（透明背景，供全局透明度合成）。 */
function rasterizeDiff(groups, w, h) {
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const octx = off.getContext('2d');
  const img = octx.createImageData(w, h);
  const px = img.data;

  const gidB = new Int32Array(w * h).fill(-1);
  const gidC = new Int32Array(w * h).fill(-1);
  groups.forEach((g, gi) => {
    for (const r of g.base) paintRuns(gidB, r.runs, w, gi);
    for (const r of g.compare) paintRuns(gidC, r.runs, w, gi);
  });

  const hex = {
    unchanged: [76, 217, 100],
    split: [255, 176, 46],
    merge: [180, 123, 255],
  };
  const setPx = (i, rgb, a) => {
    const o = i * 4;
    // 每个像素至多被写入一次（两侧分类互斥）
    px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = a;
  };

  for (let i = 0; i < w * h; i++) {
    const b = gidB[i], c = gidC[i];
    if (b < 0 && c < 0) continue;
    if (b >= 0 && c >= 0) {
      const g = groups[b];
      if (!state.diff.filters[g.type]) { setPx(i, [120, 126, 138], 70); continue; }
      setPx(i, hex[g.type] || [120, 126, 138], 235);
    } else if (b >= 0) {
      const g = groups[b];
      // 仅基准版有：消失区域为红；其余表示面积缩小，红色半透明描边
      setPx(i, [255, 90, 90], state.diff.filters[g.type] ? (g.type === 'removed' ? 235 : 140) : 50);
    } else {
      const g = groups[c];
      // 仅对比版有：新增区域为青；其余表示面积扩张，青色半透明描边
      setPx(i, [57, 199, 255], state.diff.filters[g.type] ? (g.type === 'added' ? 235 : 140) : 50);
    }
  }
  octx.putImageData(img, 0, 0);
  return off;
}

function paintRuns(labels, runs, w, value) {
  for (let i = 0; i < runs.length; i += 3) {
    const row = runs[i] * w;
    for (let x = runs[i + 1]; x <= runs[i + 2]; x++) labels[row + x] = value;
  }
}

function groupCentroid(g) {
  let sx = 0, sy = 0, wsum = 0;
  for (const side of ['base', 'compare']) {
    for (const r of g[side]) {
      sx += r.centroid[0] * r.areaPx;
      sy += r.centroid[1] * r.areaPx;
      wsum += r.areaPx;
    }
  }
  return wsum ? [sx / wsum, sy / wsum] : [0, 0];
}

function drawDiff() {
  const cv = $('overlay');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  $('oriImg').style.display = 'none';
  $('baseImg').style.display = $('diffShowBase').checked ? 'block' : 'none';
  const d = state.diff.data;
  if (!d) return;
  const view = (document.querySelector('input[name="diffView"]:checked') || {}).value || 'overlay';

  if (view === 'base' || view === 'compare') {
    const side = view === 'base' ? 'base' : 'compare';
    ctx.globalAlpha = 1;
    drawRegions(ctx, resultFromDiffSide(side), { low: true });
    return;
  }

  // 差异叠加
  const off = rasterizeDiff(d.groups, d.width, d.height);
  ctx.globalAlpha = Number($('diffOpacity').value);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0);
  ctx.globalAlpha = 1;

  // 未变组：基准轮廓实线、对比轮廓白色虚线，凸显边界微调
  for (const g of d.groups) {
    if (g.type !== 'unchanged' || !state.diff.filters.unchanged) continue;
    ctx.fillStyle = TYPE_COLOR.unchanged;
    for (const r of g.base) {
      const b = r.boundary;
      for (let i = 0; i < b.length; i += 2) ctx.fillRect(b[i], b[i + 1], 1, 1);
    }
    ctx.fillStyle = '#ffffff';
    for (const r of g.compare) {
      const b = r.boundary;
      for (let i = 0; i < b.length; i += 4) ctx.fillRect(b[i], b[i + 1], 1, 1);
    }
  }

  if ($('diffShowLabel').checked) {
    const fs = Math.max(11, Math.round(cv.width / 60));
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    d.groups.forEach((g, gi) => {
      if (!state.diff.filters[g.type]) return;
      const [cx, cy] = groupCentroid(g);
      const ids = (arr) => arr.map((r) => '#' + r.id).join(',');
      const label = {
        unchanged: `${ids(g.base)}→${ids(g.compare)}`,
        split: `${ids(g.base)}↘${ids(g.compare)}`,
        merge: `${ids(g.base)}↗${ids(g.compare)}`,
        added: `+${ids(g.compare)}`,
        removed: `−${ids(g.base)}`,
      }[g.type];
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = TYPE_COLOR[g.type];
      ctx.strokeText(label, cx, cy);
      ctx.fillText(label, cx, cy);
    });
  }
}

function draw() {
  if (state.mode === 'diff') drawDiff();
  else drawReview();
}

// ---------- 差异比较请求 ----------
let compareTimer = null;
let compareSeq = 0;
function scheduleCompare() {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(runCompare, 150);
}

async function runCompare() {
  if (!state.image || state.mode !== 'diff') return;
  const b = state.diff.baseVersion, c = state.diff.compareVersion;
  const info = $('diffInfo');
  if (state.versions.length < 2 || b == null || c == null) {
    state.diff.data = null;
    $('diffStatsTable').innerHTML = '';
    for (const t of DIFF_TYPES) $('cnt-' + t).textContent = '0';
    info.textContent = state.versions.length < 2 ? '（该图像至少需要两个已保存版本）' : '';
    draw();
    return;
  }
  const seq = ++compareSeq;
  info.textContent = '比较中…';
  try {
    const resp = await api(`/api/images/${state.image.id}/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseVersion: b,
        compareVersion: c,
        overlapThreshold: Number($('otSlider').value),
      }),
    });
    if (seq !== compareSeq) return; // 已有更新的比较请求
    state.diff.data = resp.diff;
    renderDiffStats();
    const s = resp.diff.summary;
    info.textContent =
      `v${b} → v${c}（重叠阈值 ${resp.diff.overlapThreshold.toFixed(2)}）：` +
      `未变 ${s.unchanged} · 拆分 ${s.split} · 合并 ${s.merge} · 新增 ${s.added} · 消失 ${s.removed}`;
    draw();
  } catch (e) {
    if (seq !== compareSeq) return;
    state.diff.data = null;
    info.textContent = '';
    draw();
    toast(e.message, true);
  }
}

// ---------- 差异统计表 ----------
function fmt(v, digits = 1) {
  return v == null ? '—' : v.toFixed(digits);
}
function signedFmt(v, digits = 1, suffix = '') {
  if (v == null) return '—';
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}</span>`;
}
function idList(arr) {
  return arr.map((r) => `#${r.id}`).join(', ') || '—';
}

function renderDiffStats() {
  const d = state.diff.data;
  const tbl = $('diffStatsTable');
  if (!d) { tbl.innerHTML = ''; return; }
  for (const t of DIFF_TYPES) $('cnt-' + t).textContent = d.summary[t];

  let html = '<tr><th>类型</th><th>基准区域</th><th>对比区域</th>' +
    '<th>基准面积 (px)</th><th>对比面积 (px)</th><th>面积变化</th>' +
    '<th>方向变化 (°)</th><th>低置信边界占比（基准→对比）</th><th>重叠 (px)</th></tr>';
  for (const g of d.groups) {
    if (!state.diff.filters[g.type]) continue;
    const m = g.metrics;
    const lowText = m.base && m.compare
      ? `${(m.base.lowFrac * 100).toFixed(1)}% → ${(m.compare.lowFrac * 100).toFixed(1)}% ` +
        `(${signedFmt(m.lowDeltaPct, 1, ' pp')})`
      : '—';
    html +=
      `<tr><td><span class="region-chip" style="background:${TYPE_COLOR[g.type]}"></span>${TYPE_LABEL[g.type]}</td>` +
      `<td>${idList(g.base)}</td><td>${idList(g.compare)}</td>` +
      `<td>${m.base ? m.base.areaPx : '—'}</td>` +
      `<td>${m.compare ? m.compare.areaPx : '—'}</td>` +
      `<td>${signedFmt(m.areaDeltaPx, 0, ' px')} ${m.areaDeltaPct == null ? '' : '(' + signedFmt(m.areaDeltaPct, 1, '%') + ')'}</td>` +
      `<td>${fmt(m.orientDeltaDeg, 1)}</td>` +
      `<td>${lowText}</td>` +
      `<td>${g.overlapPx}</td></tr>`;
  }
  tbl.innerHTML = html;
}

// ---------- 审阅模式统计表 ----------
function renderStats() {
  const r = state.result;
  const tbl = $('statsTable');
  if (!r) { tbl.innerHTML = ''; return; }
  const scale = Number($('scaleEdit').value) || state.image.pixel_scale || 1;
  let html = '<tr><th>区域</th><th>面积 (px)</th><th>面积 (µm²)</th><th>质心 (px)</th>' +
    '<th>平均方向 (°)</th><th>平均一致性</th><th>低置信边界占比</th></tr>';
  for (const reg of r.regions) {
    const areaUm2 = reg.areaPx * scale * scale;
    const lowFrac = reg.boundary.length
      ? (reg.lowBoundary.length / reg.boundary.length * 100).toFixed(1) + '%' : '—';
    html += `<tr><td><span class="region-chip" style="background:${regionColor(reg.id)}"></span>#${reg.id}</td>` +
      `<td>${reg.areaPx}</td><td>${areaUm2.toFixed(1)}</td>` +
      `<td>(${reg.centroid[0]}, ${reg.centroid[1]})</td>` +
      `<td>${reg.meanOrientationDeg}</td><td>${reg.meanCoherence}</td><td>${lowFrac}</td></tr>`;
  }
  tbl.innerHTML = html;
}

// ---------- 模式切换 ----------
function setMode(mode) {
  state.mode = mode;
  document.querySelector(`input[name="mode"][value="${mode}"]`).checked = true;
  $('reviewPanel').hidden = mode !== 'review';
  $('reviewToggles').hidden = mode !== 'review';
  $('reviewLegend').hidden = mode !== 'review';
  $('reviewStatsPanel').hidden = mode !== 'review';
  $('diffPanel').hidden = mode !== 'diff';
  $('diffToggles').hidden = mode !== 'diff';
  $('diffStatsPanel').hidden = mode !== 'diff';
  $('viewPanelTitle').textContent = mode === 'diff' ? '④ 版本视图' : '④ 叠加视图';
  if (mode === 'review') {
    $('oriImg').style.display = $('showOri').checked ? 'block' : 'none';
  }
  savePrefs();
  draw();
  if (mode === 'diff') scheduleCompare();
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
    draw();
    renderStats();
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
    renderStats();
    refreshImages(state.image.id);
  } catch (e) { toast(e.message, true); }
};

// 模式
document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.onchange = () => setMode(radio.value);
});
document.querySelectorAll('input[name="diffView"]').forEach((radio) => {
  radio.onchange = () => { savePrefs(); draw(); };
});

// 差异：版本选择（避免两个下拉相同）
$('baseVersionSel').onchange = () => {
  const v = Number($('baseVersionSel').value);
  if (v === state.diff.compareVersion) {
    const other = state.versions.map((x) => x.version).find((x) => x !== v);
    state.diff.compareVersion = other ?? null;
    if (other != null) $('compareVersionSel').value = other;
  }
  state.diff.baseVersion = v;
  savePrefs();
  scheduleCompare();
};
$('compareVersionSel').onchange = () => {
  const v = Number($('compareVersionSel').value);
  if (v === state.diff.baseVersion) {
    const other = state.versions.map((x) => x.version).find((x) => x !== v);
    state.diff.baseVersion = other ?? null;
    if (other != null) $('baseVersionSel').value = other;
  }
  state.diff.compareVersion = v;
  savePrefs();
  scheduleCompare();
};
$('otSlider').oninput = () => {
  syncSliderLabels();
  savePrefs();
  scheduleCompare();
};
for (const id of ['diffShowBase', 'diffOpacity', 'diffShowLabel']) {
  $(id).oninput = () => { savePrefs(); draw(); };
}
document.querySelectorAll('input[data-dtype]').forEach((cb) => {
  cb.onchange = () => {
    state.diff.filters[cb.dataset.dtype] = cb.checked;
    savePrefs();
    renderDiffStats();
    draw();
  };
});

for (const id of ['ctSlider', 'mtSlider', 'maSlider', 'lcSlider', 'moSlider']) {
  $(id).oninput = syncSliderLabels;
}
for (const id of ['showBase', 'showOri', 'showFill', 'showContour', 'showLow', 'oriOpacity']) {
  $(id).oninput = draw;
}

// ---------- 启动：恢复模式 / 图像 / 版本选择 / 筛选 ----------
(function init() {
  const prefs = loadPrefs();
  syncSliderLabels();
  if (prefs.overlapThreshold != null) $('otSlider').value = prefs.overlapThreshold;
  if (prefs.diffView) {
    const radio = document.querySelector(`input[name="diffView"][value="${prefs.diffView}"]`);
    if (radio) radio.checked = true;
  }
  if (prefs.filters) {
    state.diff.filters = { ...state.diff.filters, ...prefs.filters };
    document.querySelectorAll('input[data-dtype]').forEach((cb) => {
      if (prefs.filters[cb.dataset.dtype] != null) cb.checked = prefs.filters[cb.dataset.dtype];
    });
  }
  if (prefs.diffShowBase != null) $('diffShowBase').checked = prefs.diffShowBase;
  if (prefs.diffOpacity != null) $('diffOpacity').value = prefs.diffOpacity;
  if (prefs.diffShowLabel != null) $('diffShowLabel').checked = prefs.diffShowLabel;
  syncSliderLabels();
  setMode(prefs.mode === 'diff' ? 'diff' : 'review');
  refreshImages(prefs.imageId ?? null);
})();
