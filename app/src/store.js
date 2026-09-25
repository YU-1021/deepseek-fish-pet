/* 通用命名空间存储
 * 每个命名空间 = 一个独立 JSON 文件（%APPDATA%/dayu-pet/memory/<name>.json）。
 * 用独立文件而不是塞进一个大 JSON，是为了让后续新系统（学习/经验记忆等）
 * 各占一个命名空间，互不污染、互不拖累：一个坏了不影响其它的。
 * 写入走「临时文件 + 改名」的原子替换，断电不会写坏原文件。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const dir = () => path.join(app.getPath('userData'), 'memory');
const fileOf = (name) => path.join(dir(), String(name).replace(/[^\w.-]/g, '_') + '.json');

function clone(v) {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function read(name, fallback) {
  try {
    const raw = fs.readFileSync(fileOf(name), 'utf8').replace(/^\uFEFF/, '');
    const v = JSON.parse(raw);
    if (v === null || v === undefined) return clone(fallback);
    return v;
  } catch { return clone(fallback); }
}

function write(name, data) {
  const target = fileOf(name);
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try { fs.renameSync(tmp, target); }
    catch { fs.copyFileSync(tmp, target); try { fs.unlinkSync(tmp); } catch {} }
    return true;
  } catch { return false; }
}

function exists(name) { try { return fs.existsSync(fileOf(name)); } catch { return false; } }

module.exports = { read, write, exists, fileOf, dir };
