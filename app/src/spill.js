/* 大输出 spill（溢出到文件）—— 抄自 DSH 的 dsh-spill-policy
 *
 * 【为什么】原来的做法是"超过上限就硬截断"（main.js 的 READ_CAPS + tokens.clip）：
 *   模型只看到前面一段，**后面有什么、被丢了多少，它完全不知道** ——
 *   于是它既不知道自己漏看了东西，也没办法去把剩下的读回来。
 *
 * 【DSH 怎么做（dsh-spill-policy/lib/index.js:237 / :214 / lib/types/notice.js:26）】
 *   · 超过 maxInlineTokens 就在 tools/post-execute 里把完整内容 `saveText` 到溢出存储；
 *   · 回执里**保留头尾**（retainContent）；
 *   · 尾部追加一行精确提示：`(Omitted N bytes. Full formatted result stored at: <locator>...)`
 *     —— 这里的 N 是**精确字节数**，不是"大概"；
 *   · **saveText 失败时保留原内容，只 warn** —— 宁可回执长一点，也绝不丢数据。
 *
 * 【本模块的取舍】
 *   · 用**字节**做预算（比 token 直观，且不需要分词器）；
 *   · 头尾按**字符**切（中文安全），但省略量按**字节**精确算 —— 两者分开算，别混；
 *   · 完全不依赖 electron / fs 具体实现 —— 只接受一个目录，因此能**纯 Node 测试**。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEF = {
  maxInlineBytes: 8192,   // 超过这个就落盘
  headChars: 4000,        // 回执里保留的开头字符数
  tailChars: 1000,        // 回执里保留的结尾字符数
};

function byteLen(s) { return Buffer.byteLength(String(s == null ? '' : s), 'utf8'); }

/* 把 text 处理成"可以直接进会话的形态"。
 * 返回 { content, spilled, path?, omittedBytes?, warning? }
 * ⚠️ **永远返回可用的 content** —— 落盘失败也返回原文（fail-open），调用方不需要处理"没有内容"的情况。 */
function spill(text, o) {
  const s = String(text == null ? '' : text);
  const opt = Object.assign({}, DEF, o || {});
  const total = byteLen(s);
  if (total <= opt.maxInlineBytes) return { content: s, spilled: false };

  const dir = opt.dir;
  const id = String(opt.id || ('spill-' + Date.now())).replace(/[^\w.-]/g, '_');
  let p = '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    p = path.join(dir, id + '.txt');
    fs.writeFileSync(p, s, 'utf8');
  } catch (e) {
    /* ★ fail-open：落盘失败就原样返回 + 警告，绝不因为"存不下"而丢内容 */
    return { content: s, spilled: false, warning: '溢出文件写入失败，已保留完整内容：' + ((e && e.message) || e) };
  }

  /* 头尾按字符切；如果头尾加起来就超过总额（很短的预算），就只留头 */
  const headChars = Math.min(opt.headChars, s.length);
  const tailChars = Math.max(0, Math.min(opt.tailChars, s.length - headChars));
  const head = s.slice(0, headChars);
  const tail = tailChars > 0 ? s.slice(s.length - tailChars) : '';
  const omittedChars = s.length - head.length - tail.length;
  const omittedBytes = total - byteLen(head) - byteLen(tail);
  const pct = total ? Math.round((omittedBytes / total) * 100) : 0;

  const notice = '\n\n[... 省略 ' + omittedBytes + ' 字节（约 ' + pct + '%，' + omittedChars
    + ' 个字符）。完整内容已存到：' + p + ' —— 需要看被省略的部分就用 read_file 读它 ...]\n\n';

  return {
    content: head + notice + tail,
    spilled: true,
    path: p,
    omittedBytes,
    omittedChars,
    totalBytes: total,
  };
}

/* 给测试和调用方用：清理旧的溢出文件（按天数） */
function prune(dir, days) {
  const d = Number(days) || 7;
  const cut = Date.now() - d * 86400000;
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); n++; } } catch {}
    }
  } catch {}
  return n;
}

module.exports = { spill, prune, byteLen, DEFAULTS: DEF };
