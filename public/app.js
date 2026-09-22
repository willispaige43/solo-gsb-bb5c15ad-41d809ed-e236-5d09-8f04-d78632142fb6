'use strict';
/* 前端逻辑：上传 / 阈值调节 / 叠加渲染 / 版本管理 */

const $ = (id) => document.getElementById(id);

const state = {
  image: null,     // 当前图像元数据
  result: null,    // 当前分析结果（未保存或已载入版本）
  versions: [],
};

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
    draw();
  } catch (e) { toast(e.message, true); }
}

// ---------- 版本 ----------
async function refreshVersions(selectVersion = null) {
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

// ---------- 叠加渲染 ----------
function draw() {
  const cv = $('overlay');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  $('baseImg').style.display = $('showBase').checked ? 'block' : 'none';
  $('oriImg').style.display = $('showOri').checked ? 'block' : 'none';
  $('oriImg').style.opacity = $('oriOpacity').value;
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

// ---------- 统计表 ----------
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

for (const id of ['ctSlider', 'mtSlider', 'maSlider', 'lcSlider', 'moSlider']) {
  $(id).oninput = syncSliderLabels;
}
for (const id of ['showBase', 'showOri', 'showFill', 'showContour', 'showLow', 'oriOpacity']) {
  $(id).oninput = draw;
}

syncSliderLabels();
refreshImages();
