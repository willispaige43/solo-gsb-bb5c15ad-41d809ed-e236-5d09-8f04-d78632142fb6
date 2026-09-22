'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { initDb } = require('./src/db');
const { decodeToGray, resizeToMax, encodeGrayPNG, MAX_DIM } = require('./src/image');
const { computeFields, analyze } = require('./src/analysis');
const { renderOrientationPNG } = require('./src/render');
const { makeDemoImage } = require('./src/demo');

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = initDb(DATA_DIR);
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 内存缓存：灰度矩阵 / 方向场 / 渲染 PNG ----
const grayCache = new Map();  // id -> {gray,w,h}
const fieldCache = new Map(); // id -> fields
const pngCache = new Map();   // key -> Buffer

const qImage = db.prepare('SELECT * FROM images WHERE id = ?');
const qImages = db.prepare('SELECT id, name, width, height, orig_width, orig_height, pixel_scale, created_at FROM images ORDER BY id DESC');
const insImage = db.prepare('INSERT INTO images (name, width, height, orig_width, orig_height, pixel_scale, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)');
const updScale = db.prepare('UPDATE images SET pixel_scale = ? WHERE id = ?');
const qMaxVersion = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM partitions WHERE image_id = ?');
const insPartition = db.prepare('INSERT INTO partitions (image_id, version, params, result) VALUES (?, ?, ?, ?)');
const qVersions = db.prepare('SELECT version, params, created_at FROM partitions WHERE image_id = ? ORDER BY version DESC');
const qPartition = db.prepare('SELECT version, params, result, created_at FROM partitions WHERE image_id = ? AND version = ?');

function getImageOr404(id, res) {
  const img = qImage.get(Number(id));
  if (!img) res.status(404).json({ error: '图像不存在' });
  return img;
}

function loadGray(img) {
  let e = grayCache.get(img.id);
  if (!e) {
    const buf = fs.readFileSync(img.file_path);
    const dec = decodeToGray(buf);
    const rs = resizeToMax(dec.gray, dec.width, dec.height, MAX_DIM);
    e = { gray: rs.gray, w: rs.width, h: rs.height };
    grayCache.set(img.id, e);
  }
  return e;
}

function getFields(img) {
  let f = fieldCache.get(img.id);
  if (!f) {
    const { gray, w, h } = loadGray(img);
    f = computeFields(gray, w, h);
    fieldCache.set(img.id, f);
  }
  return f;
}

function registerImage(name, fileBuf, pixelScale) {
  const dec = decodeToGray(fileBuf);
  const rs = resizeToMax(dec.gray, dec.width, dec.height, MAX_DIM);
  const effScale = pixelScale * rs.scale; // 换算到处理分辨率
  const filePath = path.join(UPLOAD_DIR, crypto.randomUUID() + '.img');
  fs.writeFileSync(filePath, fileBuf);
  const info = insImage.run(name, rs.width, rs.height, dec.width, dec.height, effScale, filePath);
  grayCache.set(Number(info.lastInsertRowid), { gray: rs.gray, w: rs.width, h: rs.height });
  return qImage.get(Number(info.lastInsertRowid));
}

const asyncWrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || '服务器内部错误' });
  }
};

// ---- API ----

// 上传图像（原始字节流，文件名与像素尺度走请求头）
app.post('/api/images', express.raw({ type: () => true, limit: '25mb' }), asyncWrap((req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: '请求体为空' });
  let name = '未命名';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || '未命名')).slice(0, 200); } catch (_) { /* 保留默认名 */ }
  const pixelScale = Math.max(1e-6, Number(req.headers['x-pixel-scale']) || 1);
  const img = registerImage(name, req.body, pixelScale);
  res.json(img);
}));

// 生成演示图像
app.post('/api/demo', asyncWrap((req, res) => {
  const { gray, width, height } = makeDemoImage();
  const png = encodeGrayPNG(gray, width, height);
  const img = registerImage('演示样本（合成纹理）', png, 0.5);
  res.json(img);
}));

app.get('/api/images', asyncWrap((req, res) => res.json(qImages.all())));

app.get('/api/images/:id', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (img) res.json(img);
}));

// 更新像素尺度（µm/px，处理分辨率下）
app.patch('/api/images/:id', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  const s = Number(req.body && req.body.pixelScale);
  if (!Number.isFinite(s) || s <= 0) return res.status(400).json({ error: 'pixelScale 必须为正数' });
  updScale.run(s, img.id);
  res.json(qImage.get(img.id));
}));

// 处理分辨率下的灰度预览图
app.get('/api/images/:id/preview.png', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  const key = 'preview:' + img.id;
  let buf = pngCache.get(key);
  if (!buf) {
    const { gray, w, h } = loadGray(img);
    buf = encodeGrayPNG(gray, w, h);
    pngCache.set(key, buf);
  }
  res.type('png').send(buf);
}));

// 方向场渲染图（与阈值无关）
app.get('/api/images/:id/orientation.png', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  const key = 'orient:' + img.id;
  let buf = pngCache.get(key);
  if (!buf) {
    const { gray, w, h } = loadGray(img);
    buf = renderOrientationPNG(getFields(img), gray, w, h);
    pngCache.set(key, buf);
  }
  res.type('png').send(buf);
}));

// 按当前阈值分析（不落库）
app.post('/api/images/:id/analyze', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  const { gray, w, h } = loadGray(img);
  res.json(analyze(gray, w, h, getFields(img), req.body || {}));
}));

// 分析并保存为下一个版本
app.post('/api/images/:id/partitions', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  const { gray, w, h } = loadGray(img);
  const result = analyze(gray, w, h, getFields(img), req.body || {});
  const version = qMaxVersion.get(img.id).v + 1;
  insPartition.run(img.id, version, JSON.stringify(result.params), JSON.stringify(result));
  res.json({ version, result });
}));

// 版本列表
app.get('/api/images/:id/partitions', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  res.json(qVersions.all(img.id).map((r) => ({ ...r, params: JSON.parse(r.params) })));
}));

// 读取指定版本
app.get('/api/images/:id/partitions/:version', asyncWrap((req, res) => {
  const img = getImageOr404(req.params.id, res);
  if (!img) return;
  const row = qPartition.get(img.id, Number(req.params.version));
  if (!row) return res.status(404).json({ error: '版本不存在' });
  res.json({ version: row.version, created_at: row.created_at, params: JSON.parse(row.params), result: JSON.parse(row.result) });
}));

app.listen(PORT, () => {
  console.log(`显微图像纹理分区审阅台已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
