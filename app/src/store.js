/* 通用命名空间存储
 * 每个命名空间 = 一个独立 JSON 文件（%APPDATA%/dayu-pet/memory/<name>.json）。
 * 用独立文件而不是塞进一个大 JSON，是为了让后续新系统（学习/经验记忆等）
 * 各占一个命名空间，互不污染、互不拖累：一个坏了不影响其它的。
 * 写入走「临时文件 + 改名」的原子替换，断电不会写坏原文件。
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const bus = require('./bus');

const dir = () => path.join(app.getPath('userData'), 'memory');
const fileOf = (name) => path.join(dir(), String(name).replace(/[^\w.-]/g, '_') + '.json');

/* 存储层的错误**绝不能静默**：以前读坏文件当空返回、写失败只 return false，
   而调用方几乎都是 load()→改→save()，于是"读坏"会立刻变成"整份数据被清空"。
   现在统一走这里：控制台 + 事件总线（main.js 会写进 debug.log），并且读坏的文件先备份再降级。 */
function warn(msg) {
  try { console.error('[store] ' + msg); } catch {}
  try { bus.emit('store:error', { msg, at: Date.now() }); } catch {}
}

function clone(v) {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function read(name, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(fileOf(name), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return clone(fallback);            // 文件不存在 / 读不到：正常情况，用默认值
  }
  try {
    const v = JSON.parse(raw);
    if (v === null || v === undefined) return clone(fallback);
    return v;
  } catch (e) {
    /* 解析失败 = 文件真的坏了。**先另存一份再降级**：
       调用方随后保存时写的是全新文件，原数据仍留在 .corrupt-* 里可以人工抢救。 */
    try { fs.renameSync(fileOf(name), fileOf(name) + '.corrupt-' + Date.now()); } catch {}
    warn('读取 ' + name + '.json 失败，已把坏文件另存为 .corrupt-* 再降级：' + ((e && e.message) || e));
    return clone(fallback);
  }
}

function write(name, data) {
  const target = fileOf(name);
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      /* 降级路径：Windows 下目标被杀软/索引器占用时 rename 会 EPERM/EBUSY。
         copyFileSync 是**非原子**的，写一半崩溃就留下半截 JSON（下次读取就成了"坏文件"），
         所以先把旧文件备份下来，复制完再删备份；复制本身失败就把备份还原回去。 */
      warn('rename 失败，降级为非原子复制：' + name + ' — ' + ((e && e.message) || e));
      const bak = target + '.bak';
      let hadBak = false;
      try { fs.copyFileSync(target, bak); hadBak = true; } catch {}
      try {
        fs.copyFileSync(tmp, target);
        try { fs.unlinkSync(tmp); } catch {}
        if (hadBak) { try { fs.unlinkSync(bak); } catch {} }
      } catch (e2) {
        if (hadBak) { try { fs.renameSync(bak, target); } catch {} }   // 还原，别留下半截文件
        throw e2;
      }
    }
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    warn('写入 ' + name + '.json 失败：' + ((e && e.message) || e));
    return false;
  }
}

function exists(name) { try { return fs.existsSync(fileOf(name)); } catch { return false; } }

module.exports = { read, write, exists, fileOf, dir };
