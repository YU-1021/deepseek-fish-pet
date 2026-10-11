/* 文档读取（C3）—— 读 Excel / Word / CSV / 文本
 *
 * 【为什么不需要装任何东西】
 *   先查了环境：★这台机器上没有可用的 Python★ ✗
 *     （python.exe 是 WindowsApps 的 store 占位符，真跑返回 9009 ✓）
 *   于是"包一层 Python"和"接现成的文档处理 MCP server"**两条路都断了** ✗ ——
 *   因为那些库/服务绝大多数是 Python 写的（pdfplumber / python-docx / openpyxl ✓）。
 *   ★但她的 node_modules 里已经有两样关键东西★ ✓✓
 *     · unzipper  —— 而 xlsx/docx 的格式就是 ★zip 里的 XML★ ✓
 *     · xml2js    —— 解析那些 XML ✓
 *   所以读 Excel/Word **零新增依赖**就能做 ✓（也就不用为它引入 MCP 那一整套）✓
 *
 * 【范围与诚实】
 *   · .docx → 抽文字（够"读内容"用；不保留表格结构/样式 —— 那是排版，不是内容）
 *   · .xlsx → 还原成表格（含多 sheet；用字符串池正确解析 ✓）
 *   · .csv/.txt/.md/.json/.log → 当文本读
 *   · ★.pdf → 明确说"读不了"★ —— PDF 不是 zip，要真正的 PDF 解析器 ✗。
 *     不给假答案，并告诉她可行的替代（让主人转格式、或用系统默认程序打开+截图 OCR ✓）
 *   · .doc（老版二进制）/ .xls（老版）→ 同样诚实说不支持 ✓
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_CHARS = 20000;          // 返回上限（够她读内容，不至于把上下文淹掉）

function ext(p) { return path.extname(p).toLowerCase(); }

/* ── 解码 XML 里那几个实体（&amp; 之类）—— 顺序不能错（&amp; 必须最后）── */
function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/* ★ zip entry 的分隔符要容忍两种 ★
   实测（2026-10-03）：PowerShell 的 Compress-Archive 写出的 zip 用的是
   ★反斜杠★（"xl\\worksheets\\sheet1.xml"）✗ —— 而 zip 规范要求正斜杠 ✓。
   真实世界的文件来自各种打包工具，硬要求 / 会莫名其妙读不了 ✓
   → 统一归一化成正斜杠再比 ✓（这个坑是用真实文件测出来的，不是猜的）*/
function normPath(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }

/* 从 zip 里取一个 entry 的文本 */
async function entryText(zip, name) {
  const e = zip.files.find((f) => normPath(f.path) === normPath(name));
  if (!e) return null;
  const buf = await e.buffer();
  return buf.toString('utf8');
}

/* ── docx：抽 <w:t> 的文字，段落之间换行 ── */
async function readDocx(file) {
  const unzipper = require('unzipper');
  const zip = await unzipper.Open.file(file);
  const xml = await entryText(zip, 'word/document.xml');
  if (!xml) return { ok: false, error: 'docx 里没有 word/document.xml —— 这文件可能不是正常的 Word 文档' };
  /* 先按段落切开，再在段内取 <w:t>；顺带处理 tab/br */
  const paras = xml.split(/<w:p[ >]/).slice(1);
  const out = [];
  for (const para of paras) {
    let t = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
    let m;
    while ((m = re.exec(para))) {
      if (m[1] != null) t += unesc(m[1]);
      else if (m[0].indexOf('tab') >= 0) t += '\t';
      else t += '\n';
    }
    if (t.trim()) out.push(t);
  }
  return { ok: true, kind: 'docx', lines: out };
}

/* ── xlsx：字符串池 + 逐 sheet 还原表格 ── */
function colToIndex(ref) {
  const m = String(ref || '').match(/^([A-Z]+)/i);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;   // 0-based
}

async function readXlsx(file, wantSheet) {
  const unzipper = require('unzipper');
  const zip = await unzipper.Open.file(file);

  /* ① 字符串池：<si> 里可能有多个 <t>（富文本分段），要拼起来 */
  let shared = [];
  const ssXml = await entryText(zip, 'xl/sharedStrings.xml');
  if (ssXml) {
    const sis = ssXml.split(/<si[ >]/).slice(1);
    shared = sis.map((si) => {
      let t = '';
      const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let m;
      while ((m = re.exec(si))) t += unesc(m[1]);
      return t;
    });
  }

  /* ② 有哪些 sheet（名字从 workbook.xml + rels 取；取不到就退回文件名） */
  const sheetNames = [];
  try {
    const wb = await entryText(zip, 'xl/workbook.xml');
    if (wb) {
      const re = /<sheet[^>]*name="([^"]*)"[^>]*\/?>/g;
      let m;
      while ((m = re.exec(wb))) sheetNames.push(unesc(m[1]));
    }
  } catch (e) {}

  const sheetFiles = zip.files
    .map((f) => normPath(f.path))
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  if (!sheetFiles.length) return { ok: false, error: 'xlsx 里没有 worksheet —— 这文件可能不是正常的 Excel 工作簿' };

  /* ③ 选哪些 sheet */
  let targets = sheetFiles;
  if (wantSheet) {
    const w = String(wantSheet).trim();
    const byName = sheetNames.findIndex((n) => n === w);
    const byNum = /^\d+$/.test(w) ? Number(w) - 1 : -1;
    const idx = byName >= 0 ? byName : byNum;
    if (idx < 0 || idx >= sheetFiles.length) {
      return { ok: false, error: '没有找到叫「' + w + '」的工作表。有的表是：' + sheetNames.map((n, i) => (i + 1) + '.' + n).join('  ') };
    }
    targets = [sheetFiles[idx]];
  }

  const sheets = [];
  for (const sf of targets) {
    const xml = await entryText(zip, sf);
    if (!xml) continue;
    const rows = [];
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const cells = [];
      const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] != null ? cm[1] : cm[3];
        const inner = cm[2] || '';
        const refM = String(attrs || '').match(/r="([A-Z]+\d+)"/i);
        const ci = colToIndex(refM ? refM[1] : '');
        const tM = String(attrs || '').match(/t="([^"]+)"/);
        const type = tM ? tM[1] : '';
        let val = '';
        if (type === 'inlineStr') {
          const re2 = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
          let m2;
          while ((m2 = re2.exec(inner))) val += unesc(m2[1]);
        } else {
          const vm = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
          if (vm) {
            val = type === 's' ? (shared[Number(vm[1])] != null ? shared[Number(vm[1])] : '') : unesc(vm[1]);
          }
        }
        while (cells.length < ci) cells.push('');
        cells[ci] = val;
      }
      if (cells.some((x) => String(x).trim() !== '')) rows.push(cells);
    }
    const si = sheetFiles.indexOf(sf);
    sheets.push({ name: sheetNames[si] || ('sheet' + (si + 1)), rows });
  }
  return { ok: true, kind: 'xlsx', sheets, sheetNames };
}

/* ── 统一入口 ── */
async function read(file, opt) {
  const f = path.resolve(String(file || ''));
  if (!fs.existsSync(f)) return { ok: false, error: '文件不存在：' + f };
  const e = ext(f);
  const sizeMB = Math.round(fs.statSync(f).size / 1024 / 102.4) / 10;

  if (e === '.docx') {
    const r = await readDocx(f);
    if (!r.ok) return r;
    let text = r.lines.join('\n');
    const total = text.length;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    return { ok: true, kind: 'Word (.docx)', text, paragraphs: r.lines.length, chars: total, truncated: total > MAX_CHARS, sizeMB };
  }

  if (e === '.xlsx' || e === '.xlsm') {
    const r = await readXlsx(f, opt && opt.sheet);
    if (!r.ok) return r;
    const parts = [];
    let total = 0;
    for (const s of r.sheets) {
      const body = s.rows.map((row) => row.map((c) => String(c == null ? '' : c)).join('\t')).join('\n');
      total += body.length;
      parts.push('--- 工作表「' + s.name + '」（' + s.rows.length + ' 行）---\n' + body);
    }
    let text = parts.join('\n\n');
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    return {
      ok: true, kind: 'Excel (.xlsx)', text, sheets: r.sheets.map((s) => s.name),
      chars: total, truncated: total > MAX_CHARS, sizeMB,
    };
  }

  if (e === '.csv' || e === '.tsv' || e === '.txt' || e === '.md' || e === '.json' || e === '.log' || e === '.xml' || e === '.yaml' || e === '.yml') {
    let text = fs.readFileSync(f, 'utf8');
    const total = text.length;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
    return { ok: true, kind: '文本 (' + e + ')', text, chars: total, truncated: total > MAX_CHARS, sizeMB };
  }

  if (e === '.pdf') {
    return {
      ok: false, kind: 'PDF',
      error: 'PDF 我读不了 —— ★这不是"打不开"，是"没有解析器"★：'
        + 'PDF 不是 zip+XML，要真正的 PDF 解析库；而这台机器上没有可用的 Python，'
        + '硬做只会给你一堆乱码，不如不给。可行替代：'
        + '① 让主人另存为 txt/docx 再给我；② 或用系统默认程序打开 PDF，然后 screen_look + OCR 读当前页。',
    };
  }

  if (e === '.doc' || e === '.xls') {
    return { ok: false, kind: e, error: '老版 Office 格式（' + e + '）是二进制专有格式，我读不了。让主人另存为 .docx / .xlsx 再试。' };
  }

  return { ok: false, kind: e || '(无扩展名)', error: '我不认识 ' + (e || '这种') + ' 格式，不会瞎猜内容。' };
}

module.exports = { read, readDocx, readXlsx, normPath, MAX_CHARS };
