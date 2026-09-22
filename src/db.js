'use strict';
// SQLite 持久化层（使用 Node 内置 node:sqlite，无需原生编译依赖）
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'app.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS images (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      width         INTEGER NOT NULL,          -- 处理分辨率宽
      height        INTEGER NOT NULL,          -- 处理分辨率高
      orig_width    INTEGER NOT NULL,          -- 原始宽
      orig_height   INTEGER NOT NULL,          -- 原始高
      pixel_scale   REAL NOT NULL DEFAULT 1.0, -- µm / 像素（处理分辨率下）
      file_path     TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS partitions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id   INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      version    INTEGER NOT NULL,             -- 同一图像内递增的版本号
      params     TEXT NOT NULL,                -- JSON：分析阈值参数
      result     TEXT NOT NULL,                -- JSON：分区结果（区域、轮廓、置信度）
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(image_id, version)
    );
  `);
  return db;
}

module.exports = { initDb };
