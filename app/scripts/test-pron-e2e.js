/* 端到端集成：走**真实生产数据流**验证"像不像"是否指对词
 *   asr.transcribeDetailed() 拿参考句词级时间戳（字段是 {w,from,to}）
 *   → 直接喂 PetDTW.score()（这正是 chat.js 在做的事）
 * 用 dtwtest 的 4 个 wav 当输入：ref / case1(同人同文本) / case2(只换音色) / case3(换掉一个词)
 * electron.exe app\scripts\test-pron-e2e.js
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA, 'dayu-pet'));

function readWav16(p) {
  const b = fs.readFileSync(p);
  let off = 12, dataOff = -1, dataLen = 0, rate = 16000, ch = 1;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 8 + 2); rate = b.readUInt32LE(off + 8 + 4); }
    if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz % 2);
  }
  if (dataOff < 0) throw new Error('没有 data 块: ' + p);
  const n = Math.floor(dataLen / 2 / ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(dataOff + i * 2 * ch) / 32768;
  return { samples: out, sampleRate: rate };
}

app.whenReady().then(async () => {
  const asr = require('../src/asr');
  const config = require('../src/config');
  const DTW = require('../renderer/dtw.js');
  const out = [];
  const L = (s) => out.push(s);
  const D = 'C:/Users/64616/AppData/Local/Temp/dtwtest/';

  let crashed = '';

  try {
    const cfg = config.load();
    const params = cfg.pron;
    L('=== 参数（来自 config.pron，production 用同一份）===');
    L('  threshold=' + params.threshold + '  dropC0=' + params.dropC0
      + '  speechFloorDb=' + params.speechFloorDb + '  cmn=' + params.cmn);

    const ref = readWav16(D + 'ref.wav');
    L('');
    L('=== 第 1 步：asr 拿参考句词级时间戳（生产路径）===');
    const r = await asr.transcribeDetailed(fs.readFileSync(D + 'ref.wav'), cfg.asrModel, { vad: true });
    const words = r.words || [];
    L('  词数 ' + words.length + '　字段名 = ' + Object.keys(words[0] || {}).join(','));
    L('  ' + words.map((w) => w.w + '[' + w.from + '-' + w.to + ']').join(' '));
    const zero = words.filter((w) => !(w.to > w.from)).length;
    L('  零长时间戳的词 = ' + zero + ' / ' + words.length);

    L('');
    L('=== 第 2 步：PetDTW.score()（直接吃上面那组词，字段名不转换）===');
    L('  ' + 'case'.padEnd(8) + 'maxS'.padEnd(9) + 'maxWord'.padEnd(14) + 'flagged  target(practice) S / rank');
    for (const c of ['case1', 'case2', 'case3']) {
      const u = readWav16(D + c + '.wav');
      const res = DTW.score(u.samples, u.sampleRate, ref.samples, ref.sampleRate, words, params);
      const ti = words.findIndex((w) => /^practice$/i.test(w.w));
      const tw = res.words[ti] || {};
      L('  ' + c.padEnd(8) + String(res.maxS).slice(0, 7).padEnd(9)
        + String(res.maxWord).slice(0, 12).padEnd(14)
        + String(res.flagged).padEnd(9)
        + 'S=' + (tw.S != null ? tw.S.toFixed(3) : '-') + ' / rank=' + (tw.rank || '-')
        + (tw.reliable === false ? ' (reliable=false)' : ''));
    }

    L('');
    L('=== 结论 ===');
    const u3 = readWav16(D + 'case3.wav');
    const u2 = readWav16(D + 'case2.wav');
    const r3 = DTW.score(u3.samples, u3.sampleRate, ref.samples, ref.sampleRate, words, params);
    const r2 = DTW.score(u2.samples, u2.sampleRate, ref.samples, ref.sampleRate, words, params);
    const ok3 = r3.flagged && /practice/i.test(String(r3.maxWord));
    const ok2 = !r2.flagged;
    L('  真错词（practice→banana）被指认: ' + (ok3 ? '✅ 对（' + r3.maxWord + ' S=' + r3.maxS.toFixed(2) + '）' : '❌ 错，指成了 ' + r3.maxWord));
    L('  只换音色没有误报: ' + (ok2 ? '✅ 没误报（最大 S=' + r2.maxS.toFixed(2) + ' < ' + params.threshold + '）' : '❌ 误报成 ' + r2.maxWord));
    L('  → 端到端接线: ' + ((ok3 && ok2) ? '✅ 正确' : '❌ 有问题'));
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  app.exit(0);
});
