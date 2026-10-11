/* parseReply 加固的单元验证（不需要 API）：node app\scripts\test-parsereply.js */
const { parseReply } = require('../src/llm');

const CASES = [
  {
    name: '正常回复',
    raw: 'EN: Hello there.\nZH: 你好。\nWORDS: hello=/həˈloʊ/=你好\nMOOD: 平静',
    want: (r) => r.en === 'Hello there.' && r.zh === '你好。' && r.words.length === 1 && !r.action,
  },
  {
    name: '正常 ACTION（行首）',
    raw: 'EN: Let me look.\nZH: 我看一下。\nACTION: list_dir|C:\\deepseek',
    want: (r) => r.action && r.action.tool === 'list_dir' && r.action.arg === 'C:\\deepseek',
  },
  {
    name: '无参数工具（screen_shot）',
    raw: 'EN: Let me see.\nZH: 我看看。\nACTION: screen_shot',
    want: (r) => r.action && r.action.tool === 'screen_shot' && r.action.arg === '',
  },
  {
    /* 这是实测抓到的：模型把历史里的紧凑标记原样吐回来，
       标记和 ACTION 挤在同一行 → 旧代码 startswith 匹配不到，action 丢了，
       那一整行还被当成 en（回复变成一句垃圾） */
    name: '★ 紧凑标记 + 同行 ACTION（实测 bug）',
    raw: '(earlier reply, abridged) ACTION: proj_run|calc/mul.py',
    want: (r) => r.action && r.action.tool === 'proj_run' && r.action.arg === 'calc/mul.py'
      && !/abridged/i.test(r.en),
  },
  {
    name: '★ 标记在前、EN 正常',
    raw: '(earlier reply, abridged) EN: Still working on it.\nZH: 还在弄。',
    want: (r) => r.en === 'Still working on it.' && r.zh === '还在弄。' && !/abridged/i.test(r.en),
  },
  {
    name: '标记单独一行 + 下一行 ACTION',
    raw: '(earlier reply, abridged)\nEN: Next step.\nZH: 下一步。\nACTION: read_file|a.txt',
    want: (r) => r.en === 'Next step.' && r.action && r.action.tool === 'read_file',
  },
  {
    name: '行内 ACTION（前面有说明）',
    raw: 'EN: Writing it now.\nZH: 这就写。\nI will call ACTION: proj_write|calc/mul.py||print(1)',
    want: (r) => r.action && r.action.tool === 'proj_write' && /print\(1\)/.test(r.action.arg),
  },
  {
    name: '完全没有 EN/ZH（兜底不该把动作行当正文）',
    raw: 'ACTION: screen_shot',
    want: (r) => r.action && r.action.tool === 'screen_shot',
  },
];

let pass = 0;
console.log('parseReply 加固验证');
console.log('='.repeat(70));
for (const c of CASES) {
  let ok = false, err = '';
  try {
    const r = parseReply(c.raw);
    ok = !!c.want(r);
    if (!ok) err = ' → ' + JSON.stringify({ en: r.en, zh: r.zh, action: r.action });
  } catch (e) { err = ' → 抛错 ' + e.message; }
  if (ok) pass++;
  console.log((ok ? '  ✅ ' : '  ❌ ') + c.name + err);
}
console.log('='.repeat(70));
console.log('  通过 ' + pass + ' / ' + CASES.length);
process.exit(pass === CASES.length ? 0 : 1);
