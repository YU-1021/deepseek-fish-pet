/* 造"噪声环境"WAV：说话 + 低电平噪声（模拟房间底噪）+ 说话
 * 用来验证 VAD 相对"能量阈值裁剪"的优势：噪声高于阈值时裁剪会失效 */
const fs = require('fs');
const path = require('path');

const src = path.join(process.env.TEMP, 'asr-test.wav');
const dst = path.join(process.env.TEMP, 'asr-noisy.wav');
const b = fs.readFileSync(src);

let off = 12, dataOff = -1, dataLen = 0, rate = 16000, ch = 1;
while (off + 8 <= b.length) {
  const id = b.toString('ascii', off, off + 4);
  const sz = b.readUInt32LE(off + 4);
  if (id === 'fmt ') { ch = b.readUInt16LE(off + 8 + 2); rate = b.readUInt32LE(off + 8 + 4); }
  if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
  off += 8 + sz + (sz % 2);
}
const frame = 2 * ch;
const speech = b.slice(dataOff, dataOff + dataLen);
const half = Math.floor(speech.length / 2 / frame) * frame;

/* 噪声：随机 ±AMP 的 16bit PCM。AMP 取到"远超能量阈值(峰值8%)"的水平，
   让 trimSilence 判定"这是有声内容"从而失效 */
const AMP = 900;
const seg = (secs) => {
  const buf = Buffer.alloc(Math.round(rate * secs) * frame);
  for (let i = 0; i < buf.length; i += frame) {
    const v = Math.round((Math.random() * 2 - 1) * AMP);
    for (let c = 0; c < ch; c++) buf.writeInt16LE(v, i + c * 2);
  }
  return buf;
};
const noiseHead = seg(2), noiseMid = seg(3), noiseTail = seg(2);
const out = Buffer.concat([b.slice(0, dataOff), noiseHead, speech.slice(0, half), noiseMid, speech.slice(half), noiseTail]);
out.writeUInt32LE(out.length - dataOff, dataOff - 4);
out.writeUInt32LE(out.length - 8, 4);
fs.writeFileSync(dst, out);
console.log('产出: asr-noisy.wav  ' + Math.round(out.length / 1024) + 'KB');
console.log('结构: 2s 噪声(±' + AMP + ') + 说话 2.9s + 3s 噪声 + 说话 2.9s + 2s 噪声');
console.log('峰值估算: 噪声 900 vs 语音峰值 —— 噪声约占峰值 ' + AMP + '/32767 = ' + (AMP / 32767 * 100).toFixed(1) + '%，远超能量阈值(峰值8%=' + Math.round(900 / 0.08) + ')，所以只靠幅度是切不掉的');
