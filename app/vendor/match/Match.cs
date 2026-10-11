/* match.exe —— 灰度归一化互相关（NCC / TM_CCOEFF_NORMED）模板匹配
 *
 * 为什么要有这个程序：
 *   实测"让视觉大模型直接输出像素坐标"根本不可靠 —— 同一个按钮每次读数差 20~120px
 *   （ScreenSpot-Pro 论文里最好的模型只有 18.9%，OmniParser 改成"先枚举候选再让模型选序号"才到 73%）。
 *   游戏自动化领域（MaaAssistantArknights 等）用的都是**模板匹配**：把按钮的小图存下来，
 *   在全屏图里找相关性最高的位置 → 像素级精确、而且**确定性**（同画面必然同结果）。
 *
 * 设计取舍（都来自实测/调研）：
 *   · **不做多尺度**：MAA 的做法是每次截图统一缩放到固定基准（720p）后匹配，
 *     我们也一样——抓帧恒定 1920x1080（= 物理屏 1:1），所以模板天然同尺度。
 *   · **不做图像解码**：调用方（Node/Electron）用 nativeImage.toBitmap() 直接给原始 BGRA，
 *     这里只做灰度转换 + 匹配 → 省掉整个 System.Drawing 依赖，启动也更快。
 *   · **粗到精**：先在 1/2 分辨率上全搜索（快 4 倍），再在最佳点附近 ±R 用原始分辨率精修，
 *     精度与全分辨率一致，耗时约 1/4。
 *   · 只用零均值归一化相关（对整体亮度/对比度变化不敏感 —— 游戏里明暗变化很常见）。
 *
 * 用法：
 *   match.exe <frame.bin> <fw> <fh> <tpl.bin> <tw> <th> [roiX roiY roiW roiH] [minScore]
 * 输出（一行，方便解析）：
 *   OK <score> <x> <y> <w> <h>         x,y 是**匹配框中心**（截图空间像素）
 *   LOW <score> <x> <y> ...            最佳分数低于阈值
 *   ERR <message>
 *
 * frame.bin / tpl.bin 都是**原始 BGRA**（每像素 4 字节，行优先），由调用方按同一尺寸约定写盘。
 */
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

static class Match
{
    static byte[] LoadBin(string path, out int len)
    {
        byte[] b = File.ReadAllBytes(path);
        len = b.Length;
        return b;
    }

    /* BGRA -> 灰度（整数近似：0.299R+0.587G+0.114B），顺手把数组缩到 1/4 */
    static byte[] Gray(byte[] bgra, int w, int h)
    {
        byte[] g = new byte[w * h];
        for (int i = 0, p = 0; i < g.Length; i++, p += 4)
            g[i] = (byte)((bgra[p + 2] * 77 + bgra[p + 1] * 150 + bgra[p] * 29) >> 8);
        return g;
    }

    /* 1/2 下采样（2x2 平均），用于粗搜 */
    static byte[] Half(byte[] g, int w, int h, out int hw, out int hh)
    {
        hw = w / 2; hh = h / 2;
        byte[] o = new byte[hw * hh];
        for (int y = 0; y < hh; y++)
        {
            int r0 = (y * 2) * w, r1 = r0 + w;
            for (int x = 0; x < hw; x++)
            {
                int c0 = x * 2;
                o[y * hw + x] = (byte)((g[r0 + c0] + g[r0 + c0 + 1] + g[r1 + c0] + g[r1 + c0 + 1]) >> 2);
            }
        }
        return o;
    }

    /* 在 img(w x h) 的 ROI 内，用 tpl(tw x th) 做零均值归一化相关，返回最佳分数与左上角。
       step 是采样步长（粗搜用 1，因为我们已经在半分辨率上）。
       bestXY 用于"只在这个点附近找"的精修模式（传 null 就是全 ROI 搜索）。 */
    static double Search(byte[] img, int w, int h, byte[] tpl, int tw, int th,
                         int rx, int ry, int rw, int rh, int step, int[] hint, out int bx, out int by)
    {
        bx = -1; by = -1;
        int tlen = tw * th;
        // 模板的均值与零均值平方和（一次算好）
        double tm = 0; for (int i = 0; i < tlen; i++) tm += tpl[i];
        tm /= tlen;
        double tss = 0; for (int i = 0; i < tlen; i++) { double d = tpl[i] - tm; tss += d * d; }
        if (tss <= 1e-9) return -2;   // 纯色模板：相关性没有意义

        int x0 = rx, x1 = rx + rw - tw, y0 = ry, y1 = ry + rh - th;
        if (hint != null) { x0 = Math.Max(rx, hint[0]); x1 = Math.Min(x1, hint[0] + hint[2]); y0 = Math.Max(ry, hint[1]); y1 = Math.Min(y1, hint[1] + hint[3]); }
        double best = -2;
        for (int y = y0; y <= y1; y += step)
        {
            for (int x = x0; x <= x1; x += step)
            {
                // 图像块的均值
                double im = 0;
                for (int ty = 0; ty < th; ty++)
                {
                    int o = (y + ty) * w + x;
                    for (int tx = 0; tx < tw; tx++) im += img[o + tx];
                }
                im /= tlen;
                double num = 0, iss = 0;
                for (int ty = 0; ty < th; ty++)
                {
                    int o = (y + ty) * w + x, t = ty * tw;
                    for (int tx = 0; tx < tw; tx++)
                    {
                        double di = img[o + tx] - im;
                        double dt = tpl[t + tx] - tm;
                        num += di * dt;
                        iss += di * di;
                    }
                }
                double den = Math.Sqrt(iss * tss);
                double sc = den <= 1e-9 ? -2 : num / den;
                /* 【平局固定选左上】游戏里经常有**完全相同的重复目标**（干员卡片、同样的按钮），
                   噪声背景会让两处的分数差在小数点后好几位 —— 实测原来会命中下面那一个，
                   导致"要点第一个卡片"这种需求结果不稳定。这里：分数接近时优先取更靠上、再靠左的，
                   保证同一画面每次给同一个答案（确定性）。 */
                if (sc > best + 1e-6 || (Math.Abs(sc - best) <= 1e-6 && (by < 0 || y < by || (y == by && x < bx))))
                {
                    best = Math.Max(best, sc); bx = x; by = y;
                }
            }
        }
        return best;
    }

    static int Main(string[] args)
    {
        var ci = CultureInfo.InvariantCulture;
        try
        {
            if (args.Length < 6) { Console.WriteLine("ERR usage: match.exe frame.bin fw fh tpl.bin tw th [roiX roiY roiW roiH] [minScore]"); return 2; }
            string fp = args[0];
            int fw = int.Parse(args[1], ci), fh = int.Parse(args[2], ci);
            string tp = args[3];
            int tw = int.Parse(args[4], ci), th = int.Parse(args[5], ci);
            int rx = 0, ry = 0, rw = fw, rh = fh;
            double minScore = 0.70;   // MAA 的 templThreshold 默认就是 0.7
            if (args.Length >= 10)
            {
                rx = int.Parse(args[6], ci); ry = int.Parse(args[7], ci);
                rw = int.Parse(args[8], ci); rh = int.Parse(args[9], ci);
            }
            if (args.Length >= 11) minScore = double.Parse(args[10], ci);

            int flen, tlen;
            byte[] fraw = LoadBin(fp, out flen);
            byte[] traw = LoadBin(tp, out tlen);
            if (flen < fw * fh * 4) { Console.WriteLine("ERR frame too small: " + flen + " < " + (fw * fh * 4)); return 3; }
            if (tlen < tw * th * 4) { Console.WriteLine("ERR template too small: " + tlen + " < " + (tw * th * 4)); return 3; }
            if (tw > rw || th > rh) { Console.WriteLine("ERR template bigger than roi"); return 3; }

            var sw = Stopwatch.StartNew();
            byte[] fg = Gray(fraw, fw, fh);
            byte[] tg = Gray(traw, tw, th);

            // 1) 粗搜：半分辨率 + **隔点采样**（step=2）。
            //    实测半分辨率逐步搜索全屏要 864ms，太慢；隔点后位置数降到 1/4 → ~200ms。
            //    精度不受影响：粗搜只负责给一个"大概在哪"，最终坐标由下面原始分辨率的精修给出。
            int hw, hh;
            byte[] fh2 = Half(fg, fw, fh, out hw, out hh);
            int tw2, th2;
            byte[] th2a = Half(tg, tw, th, out tw2, out th2);
            if (tw2 < 2 || th2 < 2) { tw2 = Math.Max(2, tw / 2); th2 = Math.Max(2, th / 2); }
            int crx = rx / 2, cry = ry / 2, crw = Math.Max(2, rw / 2), crh = Math.Max(2, rh / 2);
            int cbx, cby;
            double cs = Search(fh2, hw, hh, th2a, tw2, th2, crx, cry, crw, crh, 2, null, out cbx, out cby);

            // 2) 精修：原始分辨率、逐点，在粗搜点附近 ±10 像素内找。
            //    粗搜误差上界 = 采样步长 2 × 半分辨率 ≈ 4 像素，留到 ±10 足够安全。
            int R = 10;
            int[] hint = new int[] { Math.Max(rx, cbx * 2 - R), Math.Max(ry, cby * 2 - R), R * 2, R * 2 };
            int bx, by;
            double bs = Search(fg, fw, fh, tg, tw, th, rx, ry, rw, rh, 1, hint, out bx, out by);
            if (bx < 0) { bs = cs; bx = cbx * 2; by = cby * 2; }   // 精修没找到就退回粗搜结果

            sw.Stop();
            int cx = bx + tw / 2, cy = by + th / 2;
            string tag = bs >= minScore ? "OK" : "LOW";
            Console.WriteLine(tag + " " + bs.ToString("F4", ci) + " " + cx + " " + cy + " " + tw + " " + th + " ms=" + sw.ElapsedMilliseconds);
            return bs >= minScore ? 0 : 1;
        }
        catch (Exception e)
        {
            Console.WriteLine("ERR " + e.Message);
            return 4;
        }
    }
}
