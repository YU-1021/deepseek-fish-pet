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
const fmt = require('./storefmt');

/* 文件比程序新的命名空间（拒绝加载）→ 一律不许写，免得把用户的新数据覆盖成旧格式。
   pendingWrite：读过时发生了迁移 → 标记一下（下次写盘自然落新格式，不必专门改写一次）。 */
const readOnly = new Set();
const pendingWrite = new Set();

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
    /* ⚠️ 这里原来写的是 `if (v === null || v === undefined) return clone(fallback);` —— 把 null 当成"没有数据"。
       实测发现是错的：`ending` 这个命名空间**故意存字面量 null**（memory/index.js 的 END_NS，
       表示"本轮已收尾、没有挂起的事"），session 收尾时也会写 null。
       只有 undefined 才该走 fallback；null 是**真实数据**，必须原样返回。
       （probe-storefmt 的 §D 就是抓这个的：期望读回 null，实际拿到了 fallback。） */
    if (v === undefined) return clone(fallback);
    /* 【格式版本与迁移】见 src/storefmt.js —— C8 当初只给 session 加了版本，
       这里把机制下沉到**所有命名空间**：对象包 version（并按链迁移），
       数组（long/medium/statslog）与标量（ending 的 null）原样通过。 */
    const m = fmt.migrate(String(name), v);
    if (!m.ok) {
      /* 文件比程序还新 → 拒绝加载，并把这个命名空间标成**只读**（绝不写回覆盖）。 */
      readOnly.add(String(name));
      warn('拒绝加载 ' + name + '.json：' + m.error);
      return clone(fallback);
    }
    if (m.migrated) pendingWrite.add(String(name));   // 迁过就标记，下次写盘自动落新格式
    return m.data;
  } catch (e) {
    /* 解析失败 = 文件真的坏了。**先另存一份再降级**：
       调用方随后保存时写的是全新文件，原数据仍留在 .corrupt-* 里可以人工抢救。 */
    try { fs.renameSync(fileOf(name), fileOf(name) + '.corrupt-' + Date.now()); } catch {}
    warn('读取 ' + name + '.json 失败，已把坏文件另存为 .corrupt-* 再降级：' + ((e && e.message) || e));
    return clone(fallback);
  }
}

function write(name, data) {
  /* 兜底：undefined 绝不能写下去（JSON.stringify(undefined) 返回 undefined，
     writeFileSync 会抛类型错误 —— 实测 skillmem.save() 少传一个参数就踩到了）。
     宁可报错拒写，也不要把一份好好的记忆写成坏文件。 */
  if (data === undefined) { warn('拒绝写入 ' + name + '.json：data 是 undefined（调用方少传了参数？）'); return false; }
  /* 该命名空间的文件是"更新版本"写的 → 拒绝写入，绝不覆盖（照 DSH session-format:134 的语义） */
  if (readOnly.has(String(name))) { warn('拒绝写入 ' + name + '.json：该文件版本比本程序新，已标为只读'); return false; }
  const target = fileOf(name);
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(dir(), { recursive: true });
    /* 写盘统一包上格式版本（对象加 version；数组/标量原样）—— 迁移的另一半 */
    fs.writeFileSync(tmp, JSON.stringify(fmt.wrap(String(name), data), null, 2));
    if (pendingWrite.has(String(name))) pendingWrite.delete(String(name));
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

function status() { return { readOnly: Array.from(readOnly), pendingWrite: Array.from(pendingWrite), version: fmt.CURRENT }; }

module.exports = { read, write, exists, fileOf, dir, status };
