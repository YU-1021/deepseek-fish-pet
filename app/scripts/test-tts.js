/* TTS 验证（真的联网到微软 Edge 语音，不花钱、不用 key）
 * electron.exe app\scripts\test-tts.js
 */
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const TEST_UD = path.join(process.env.APPDATA, 'dayu-pet-ttstest');
fs.mkdirSync(TEST_UD, { recursive: true });
try { fs.rmSync(path.join(TEST_UD, 'tts-cache'), { recursive: true, force: true }); } catch {}
app.setPath('userData', TEST_UD);

/* MP3 合法性：ID3 头 或 MPEG 帧同步（0xFF Ex/Fx） */
function looksLikeMp3(buf) {
  if (!buf || buf.length < 4) return false;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

app.whenReady().then(async () => {
  const tts = require('../src/tts');
  const out = [];
  const L = (s) => out.push(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, total = 0;
  const check = (n, ok, d) => { total++; if (ok) pass++; L((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '  ' + d : '')); };

  try {
    L('=== 0. 音色/语气表完整性 ===');
    check('音色表非空且都有 id/label', tts.VOICES.length > 0 && tts.VOICES.every((v) => v.id && v.label), tts.VOICES.length + ' 个');
    check('默认音色在表里', !!tts.voiceById(tts.DEFAULT_VOICE) && tts.voiceById(tts.DEFAULT_VOICE).id === tts.DEFAULT_VOICE);
    check('未知音色回退到默认（不崩）', tts.voiceById('not-a-voice').id === tts.DEFAULT_VOICE);
    check('未知语气回退到默认', tts.resolveStyle('nope') === tts.DEFAULT_STYLE);
    check('语气预设值都在合理区间', Object.values(tts.STYLES).every((s) => s.rate > 0.5 && s.rate < 2 && s.pitch > 0.5 && s.pitch < 2),
      JSON.stringify(Object.values(tts.STYLES).map((s) => s.rate + '/' + s.pitch)));

    L('');
    L('=== 1. 空/无效文本应当立刻拒绝（不该发请求）===');
    for (const bad of ['', '   ', null, undefined, '[旁白]', '[only bracket]']) {
      let err = '';
      try { await tts.synthesize(bad); } catch (e) { err = String((e && e.message) || e); }
      check('拒绝 ' + JSON.stringify(String(bad).slice(0, 14)), /没有可朗读的文本/.test(err), err || '（没报错！）');
    }

    L('');
    L('=== 2. 合成一句英文（真联网）===');
    const text = 'Hello there, I am your whale maid.';
    const t0 = Date.now();
    let r1 = null, e1 = '';
    try { r1 = await tts.synthesize(text, { voice: 'en-US-AriaNeural', style: 'tsundere' }); } catch (e) { e1 = String((e && e.message) || e); }
    const ms1 = Date.now() - t0;
    check('合成成功', !!r1, e1 || (ms1 + 'ms'));
    if (r1) {
      const buf = fs.readFileSync(r1.file);
      check('返回 ok / file / url / dataUrl', r1.ok === true && !!r1.file && /^file:/.test(r1.url) && /^data:audio\/mpeg;base64,/.test(r1.dataUrl));
      check('文件真的落盘且是合法 mp3', fs.existsSync(r1.file) && looksLikeMp3(buf), buf.length + ' 字节，头=' + buf.slice(0, 3).toString('latin1'));
      check('音频不是空壳（>2KB）', buf.length > 2048, buf.length + ' 字节');
      check('第一次 cached=false', r1.cached === false);
      check('dataUrl 长度与文件一致（base64 约 4/3）', Math.abs(r1.dataUrl.length - buf.length * 4 / 3) < 200,
        'dataUrl=' + r1.dataUrl.length + ' buf=' + buf.length);
      L('    耗时 ' + ms1 + 'ms  体积 ' + Math.round(buf.length / 1024) + 'KB');
    }

    L('');
    L('=== 3. 同样内容再合成 → 命中缓存（不再联网）===');
    const t1 = Date.now();
    let r2 = null, e2 = '';
    try { r2 = await tts.synthesize(text, { voice: 'en-US-AriaNeural', style: 'tsundere' }); } catch (e) { e2 = String((e && e.message) || e); }
    const ms2 = Date.now() - t1;
    check('第二次成功', !!r2, e2);
    if (r1 && r2) {
      check('cached=true', r2.cached === true);
      check('同一个文件', r2.file === r1.file, path.basename(r2.file));
      check('快得多（缓存生效）', ms2 < Math.max(200, ms1 / 2), ms2 + 'ms vs 首次 ' + ms1 + 'ms');
    }

    L('');
    L('=== 4. 换音色 → 必须是不同的文件/音频（防串音）===');
    let r3 = null, e3 = '';
    try { r3 = await tts.synthesize(text, { voice: 'en-US-GuyNeural', style: 'tsundere' }); } catch (e) { e3 = String((e && e.message) || e); }
    check('换音色成功', !!r3, e3);
    if (r1 && r3) {
      check('文件不同', r3.file !== r1.file, path.basename(r3.file));
      const b1 = fs.readFileSync(r1.file), b3 = fs.readFileSync(r3.file);
      check('音频内容确实不同', b1.length !== b3.length || !b1.equals(b3), b1.length + ' vs ' + b3.length);
    }

    L('');
    L('=== 5. 长文本切分（确定性，不联网）===');
    /* ⚠️ 这里以前写错了期望：多句文本如果**总长不到 180 字**会被合并成一句、
       走单段路径（文件名是 edge- 而不是 mix-）—— 那是**正确行为**，不是 bug。
       所以切分逻辑单独做单元验证，再用一段**真的超过 180 字**的文本测拼接。 */
    const seg = (t) => tts.toSentences(t);
    check('空/纯空白 → 0 段', seg('').length === 0 && seg('   ').length === 0);
    check('短句合成 1 段', seg('Hello there.').length === 1, JSON.stringify(seg('Hello there.')));
    const s2 = seg('One two three. Four five six. Seven eight nine.');
    check('多短句会合并（减少请求数）', s2.length === 1, JSON.stringify(s2));
    const longNoPunct = 'word '.repeat(200).trim();     // 1000 字、无标点
    const s3 = seg(longNoPunct);
    check('★ 无标点超长文本被硬切开（以前整段发出去）', s3.length > 1, s3.length + ' 段，最长 ' + Math.max(...s3.map((x) => x.length)) + ' 字');
    check('每段都不超过上限 ' + tts.MAX_SEG, s3.every((x) => x.length <= tts.MAX_SEG), s3.map((x) => x.length).join(','));
    check('切分不丢内容（拼回来长度一致）', s3.join('').replace(/\s/g, '').length === longNoPunct.replace(/\s/g, '').length,
      s3.join('').replace(/\s/g, '').length + ' vs ' + longNoPunct.replace(/\s/g, '').length);
    const cn = '这是一段完全没有标点的中文长文本'.repeat(20);   // 300 字、无空格
    const s4 = seg(cn);
    check('中文无空格长句也能切开', s4.length > 1 && s4.every((x) => x.length <= tts.MAX_SEG), s4.length + ' 段');
    check('超过 12 段会被截断（防一次请求太多）', seg('word '.repeat(4000)).length <= 12, seg('word '.repeat(4000)).length + ' 段');

    L('');
    L('=== 5b. 真超过 180 字的文本 → 走分段拼接（真联网）===');
    const long = 'The first sentence is here. The second one follows it! And a third? Yes, a third one too. '
      + 'This paragraph keeps going so that the total length comfortably exceeds the one hundred and eighty character limit that triggers splitting.';
    let r4 = null, e4 = '';
    try { r4 = await tts.synthesize(long, { voice: 'en-US-AriaNeural' }); } catch (e) { e4 = String((e && e.message) || e); }
    check('长文本成功', !!r4, e4);
    if (r4) {
      const buf = fs.readFileSync(r4.file);
      check('拼出来的也是合法 mp3', looksLikeMp3(buf) && buf.length > 2048, buf.length + ' 字节');
      check('文件名是 mix-（多段拼接）', /mix-/.test(path.basename(r4.file)), path.basename(r4.file).slice(0, 24));
      check('音色/语速/音调都回传了', r4.voice === 'en-US-AriaNeural' && r4.rate > 0 && r4.pitch > 0,
        'voice=' + r4.voice + ' rate=' + r4.rate + ' pitch=' + r4.pitch);
    }

    L('');
    L('=== 6. 语气预设真的改变了参数 ===');
    const styles = {};
    for (const sid of Object.keys(tts.STYLES)) {
      let r = null;
      try { r = await tts.synthesize('Testing the tone.', { voice: 'en-US-AriaNeural', style: sid }); } catch {}
      styles[sid] = r ? { rate: r.rate, pitch: r.pitch, file: path.basename(r.file) } : null;
    }
    const ok6 = Object.values(styles).every((s) => s) &&
      new Set(Object.values(styles).map((s) => s.rate + '/' + s.pitch)).size === Object.keys(tts.STYLES).length;
    check('4 个语气的 rate/pitch 各不相同', ok6, JSON.stringify(styles));

    L('');
    L('=== 7. 奇怪输入不该崩 ===');
    const weird = [
      ['emoji', 'Hello 🐳🐟 there!'],
      ['中英混排', '你好，I am 大肥鱼。'],
      ['超长单句（无句号）', 'word '.repeat(300)],
      ['特殊字符', 'a & b < c > d "e" \'f\''],
      ['换行/制表', 'line one\nline two\tindented'],
    ];
    for (const [name, t] of weird) {
      let r = null, err = '';
      const t0w = Date.now();
      try { r = await tts.synthesize(t, { voice: 'en-US-AriaNeural' }); } catch (e) { err = String((e && e.message) || e); }
      const okw = !!r && fs.existsSync(r.file) && looksLikeMp3(fs.readFileSync(r.file));
      check(name + ' → 正常合成', okw, okw ? (fs.statSync(r.file).size + ' 字节 / ' + (Date.now() - t0w) + 'ms') : err.slice(0, 80));
    }

    L('');
    L('=== 8. 缓存文件不能被写成半截（原子落盘）===');
    const cacheFiles = fs.readdirSync(path.join(TEST_UD, 'tts-cache'));
    check('缓存目录里没有 .part 残留', !cacheFiles.some((f) => f.endsWith('.part')), cacheFiles.length + ' 个文件');
    const shortOnes = cacheFiles.filter((f) => f.endsWith('.mp3') && fs.statSync(path.join(TEST_UD, 'tts-cache', f)).size < 100);
    check('没有小于 100 字节的残缺缓存', shortOnes.length === 0, shortOnes.slice(0, 3).join(','));

    L('');
    L('=== 9. 并发同一句 → 不互相踩坏 ===');
    let conc = null, cErr = '';
    try {
      conc = await Promise.all([1, 2, 3].map(() => tts.synthesize('Concurrent test sentence.', { voice: 'en-US-AriaNeural' })));
    } catch (e) { cErr = String((e && e.message) || e); }
    check('三个并发都成功', !!conc && conc.every((x) => x && fs.existsSync(x.file)), cErr.slice(0, 80));
    if (conc) {
      const allMp3 = conc.every((x) => looksLikeMp3(fs.readFileSync(x.file)));
      check('并发产出的都是合法 mp3', allMp3);
      const sameFile = new Set(conc.map((x) => x.file)).size;
      check('最终落到同一个缓存文件', sameFile === 1, sameFile + ' 个不同文件');
    }

    L('');
    L('  通过 ' + pass + ' / ' + total);
  } catch (e) {
    crashed = String((e && e.stack) || e);
    L('ERROR: ' + ((e && e.stack) || e));
  }
  console.log(out.join('\n'));
  setTimeout(() => app.exit((pass === total && !crashed) ? 0 : 1), 300);
});
