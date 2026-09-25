/* 隐藏窗口里的屏幕捕获页：主进程用 executeJavaScript 驱动它
 *   __startStream(sourceId) -> 拉桌面视频流，等第一帧可画
 *   __grabFrame()           -> 把当前帧画进 canvas 返回 jpeg dataURL
 */
let stream = null, video = null, canvas = null, ctx = null;

window.__startStream = async (sourceId) => {
  if (stream && ctx) return { ok: true, w: canvas.width, h: canvas.height };
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
      },
    },
  };
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);
  await video.play();
  // 等视频真正有可画的帧（readyState >= HAVE_CURRENT_DATA）
  for (let i = 0; i < 40 && video.readyState < 2; i++) await new Promise((r) => setTimeout(r, 50));
  canvas = document.createElement('canvas');
  // 缩到 720p：够看够 OCR，JPEG 编码快一截，抓帧更省
  canvas.width = 1280;
  canvas.height = 720;
  ctx = canvas.getContext('2d');
  return { ok: true, w: canvas.width, h: canvas.height };
};

/* 画面指纹：把当前帧缩成 64x36 灰度格（2304 格，每格约 20x20 像素），主进程用它判断"画面到底变没变"。
   两个坑都实测过：
   1) 必须在**像素**上算，不能对 jpeg 字节做哈希 —— 同一静止画面两次编码的字节并不相同
      （实测 91043 / 91347），按字节采样会错位雪崩，把"没变"误判成 89% 巨变。
   2) 网格不能太粗 —— 16x9 时"白底上又开一个白窗口"整屏 0 格变化，完全看不见；
      48x27 才看得出来（静止时单格最大差 7，真变化时 40+）。 */
const FP_W = 64, FP_H = 36;
let fpCanvas = null, fpCtx = null;
function frameSig() {
  if (!ctx || !video) return '';
  if (!fpCanvas) {
    fpCanvas = document.createElement('canvas');
    fpCanvas.width = FP_W; fpCanvas.height = FP_H;
    fpCtx = fpCanvas.getContext('2d', { willReadFrequently: true });
  }
  fpCtx.drawImage(video, 0, 0, FP_W, FP_H);
  const d = fpCtx.getImageData(0, 0, FP_W, FP_H).data;
  let out = '';
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    out += g.toString(16).padStart(2, '0');
  }
  return out;
}

window.__grabFrame = () => {
  if (!ctx || !video) return null;
  ctx.drawImage(video, 0, 0, 1280, 720);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.75), width: 1280, height: 720, sig: frameSig() };
};
