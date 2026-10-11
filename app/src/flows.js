/* 流程库：存/取"确定性流程" + 把真实实现适配成 flow.js 需要的依赖
 *
 * 【为什么单独一个模块，而不是塞进 assistant.js】
 *   assistant.js 已经 975 行，是重构要拆的第一个热点。这个模块用**依赖注入**
 *   把目录、键鼠、抓帧、找图、找字都从外面传进来 —— 因此它**自己不 require electron**，
 *   可以被纯 Node 测试、也能被替换实现。这是 DSH "一个关注点一个模块 + 明确依赖"的轻量版。
 *
 * 【流程存哪】<userData>/flows/<名字>.json，一个流程一个文件（和技能一样，人能直接看/改/分享）
 * 【名字规则】允许中文（桌宠的技能就是这么用的，对用户更自然）；
 *   只挡掉路径分隔符和纯点号，避免越界写到别的目录去。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const flowLib = require('./flow');

function safeFlowName(n) {
  const s = String(n == null ? '' : n).trim();
  if (!s) return '';
  if (/[\\/:*?"<>|]/.test(s)) return '';
  if (s === '.' || s === '..') return '';
  return s.slice(0, 60);
}

function flowsDir(baseDir) { return path.join(baseDir, 'flows'); }

function list(baseDir) {
  const d = flowsDir(baseDir);
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => {
      const name = f.replace(/\.json$/, '');
      let mtime = 0, steps = 0, title = '';
      try {
        const st = fs.statSync(path.join(d, f));
        mtime = st.mtimeMs;
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        steps = (j.steps || []).length;
        title = j.title || '';
      } catch {}
      return { name, steps, title, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function save(baseDir, name, flow) {
  const nm = safeFlowName(name);
  if (!nm) return { ok: false, error: '流程名不合法（不能为空、不能含 \\ / : * ? " < > |）' };
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) return { ok: false, error: '流程至少要有一个步骤' };
  const d = flowsDir(baseDir);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  const obj = { name: nm, title: flow.title || '', note: flow.note || '', savedAt: Date.now(), steps: flow.steps };
  const p = path.join(d, nm + '.json');
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8'); }
  catch (e) { return { ok: false, error: '写入失败：' + e.message }; }
  return { ok: true, path: p, steps: obj.steps.length };
}

function load(baseDir, name) {
  const nm = safeFlowName(name);
  if (!nm) return null;
  try { return JSON.parse(fs.readFileSync(path.join(flowsDir(baseDir), nm + '.json'), 'utf8')); }
  catch { return null; }
}

function del(baseDir, name) {
  const nm = safeFlowName(name);
  if (!nm) return false;
  try { fs.unlinkSync(path.join(flowsDir(baseDir), nm + '.json')); return true; } catch { return false; }
}

/* 把真实实现适配成 flow.js 的依赖形状。
 * dry=true 时**只解析目标、不真的动键鼠** —— 用来"干跑"验证一个流程（很有用：
 * 先确认每一步都找得到目标，再让它真的点）。 */
function makeDeps(o) {
  const dry = !!o.dry;
  const log = o.log || (() => {});
  const noop = async () => {};
  return {
    log,
    capture: async () => o.capture(),
    findTemplate: async (name, dataUrl, roi) => o.findTemplate(name, dataUrl, roi),
    findText: async (text, dataUrl) => o.findText(text, dataUrl),
    click: dry ? noop : async (x, y) => o.input.click(x, y),
    rclick: dry ? noop : async (x, y) => o.input.rclick(x, y),
    move: dry ? noop : async (x, y) => o.input.move(x, y),
    key: dry ? noop : async (k) => o.input.key(k),
    type: dry ? noop : async (t) => o.input.type(t),
    scroll: dry ? noop : async (x, y, d) => o.input.scroll(x, y, d),
  };
}

async function run(baseDir, name, o) {
  const f = load(baseDir, name);
  if (!f) return { ok: false, error: '没有名为「' + name + '」的流程', name: String(name || ''), steps: [], failedAt: -1, needLlm: false };
  const deps = makeDeps(o);
  const report = await flowLib.runFlow(deps, f, {});
  report.dry = !!o.dry;
  return report;
}

module.exports = { list, save, load, del, run, makeDeps, flowsDir, safeFlowName, summarize: flowLib.summarize };
