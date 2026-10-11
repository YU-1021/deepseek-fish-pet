"""Supplementary figure for the DTW feasibility report (Pillow only).
Not part of the deliverable script -- the deliverable is numpy+stdlib only.
Writes C:\\Users\\64616\\AppData\\Local\\Temp\\dtwtest\\dtw_report.png
"""
import json
from PIL import Image, ImageDraw, ImageFont

TMP = r"C:\Users\64616\AppData\Local\Temp\dtwtest"
d = json.load(open(TMP + r"\results.json", encoding="utf-8"))

W, H = 1500, 980
BG = (255, 255, 255)
img = Image.new("RGB", (W, H), BG)
dr = ImageDraw.Draw(img)
try:
    f_sm = ImageFont.truetype("consola.ttf", 15)
    f_md = ImageFont.truetype("consola.ttf", 17)
    f_lg = ImageFont.truetype("consola.ttf", 21)
except Exception:
    f_sm = f_md = f_lg = ImageFont.load_default()

words = [w["text"] for w in d["words"]]
tgt = d["target_index"]
cm = d["frame_centre_ms"]
own = d["frame_owner_word"]
fc = d["frame_cost"]
colors = {"case1": (90, 150, 220), "case2": (230, 140, 40), "case3": (200, 40, 40)}
labels = {"case1": "case1  voice A, same text (rate +1)",
          "case2": "case2  voice B, same text (timbre only)",
          "case3": "case3  voice A, practice -> banana"}

# ---------------- panel 1: per-frame local DTW cost ----------------
L, R, T, B = 90, W - 40, 70, 470
xmax = max(cm)
ymin, ymax = 0.0, 16.0


def px(t):
    return L + (t / xmax) * (R - L)


def py(v):
    v = max(ymin, min(ymax, v))
    return B - (v - ymin) / (ymax - ymin) * (B - T)


dr.text((L, 24), "Per-frame local DTW cost  (MFCC-13 + CMN, Euclidean)", font=f_lg, fill=(20, 20, 20))
# grid
for v in range(0, 17, 2):
    y = py(v)
    dr.line([(L, y), (R, y)], fill=(226, 226, 226))
    dr.text((L - 34, y - 8), str(v), font=f_sm, fill=(90, 90, 90))
for t in range(0, int(xmax) + 1, 500):
    x = px(t)
    dr.line([(x, T), (x, B)], fill=(238, 238, 238))
    dr.text((x - 16, B + 8), "%.1fs" % (t / 1000.0), font=f_sm, fill=(90, 90, 90))
dr.line([(L, B), (R, B)], fill=(60, 60, 60))
dr.line([(L, T), (L, B)], fill=(60, 60, 60))

# target word band
tb = [d["words"][tgt]["vad_map_from_ms"], d["words"][tgt]["vad_map_to_ms"]]
dr.rectangle([px(tb[0]), T, px(tb[1]), B], fill=(255, 244, 214))
# word separators
for k, w in enumerate(d["words"]):
    x = px(w["vad_map_from_ms"])
    dr.line([(x, T), (x, B)], fill=(200, 200, 200))
    xm = px(0.5 * (w["vad_map_from_ms"] + w["vad_map_to_ms"]))
    dr.text((xm - 6 * len(w["text"]) / 2, T - 20), w["text"], font=f_sm,
            fill=(150, 20, 20) if k == tgt else (70, 70, 70))
dr.line([(L, B), (R, B)], fill=(60, 60, 60))

for tag in ("case1", "case2", "case3"):
    pts = [(px(cm[i]), py(fc[tag][i])) for i in range(len(cm)) if fc[tag][i] is not None]
    dr.line(pts, fill=colors[tag], width=2 if tag != "case3" else 3)
# legend
ly = 500
for j, tag in enumerate(("case1", "case2", "case3")):
    y = ly + j * 24
    dr.line([(L, y + 8), (L + 40, y + 8)], fill=colors[tag], width=4)
    dr.text((L + 50, y), labels[tag], font=f_md, fill=(40, 40, 40))
dr.text((L + 620, ly + 8), "band 3: S = cost(word) / mean(other words)",
        font=f_md, fill=(40, 40, 40))

# ---------------- panel 2: per-word decision score S ----------------
L2, R2, T2, B2 = 90, W - 40, 610, 900
S = d["summary"]["S_score"]
smax = 5.0
n = len(words)
slot = (R2 - L2) / n


def sy(v):
    return B2 - (min(v, smax) / smax) * (B2 - T2)


dr.text((L2, 570), "Per-word decision score  S = cost(word) / mean(cost of the other words)",
        font=f_lg, fill=(20, 20, 20))
for v in range(0, 6):
    y = sy(v)
    dr.line([(L2, y), (R2, y)], fill=(226, 226, 226))
    dr.text((L2 - 30, y - 8), str(v), font=f_sm, fill=(90, 90, 90))
# threshold 2.0
dr.line([(L2, sy(2.0)), (R2, sy(2.0))], fill=(40, 160, 60), width=3)
dr.text((R2 - 300, sy(2.0) - 24), "recommended threshold  S > 2.0", font=f_md,
        fill=(30, 140, 50))

for k, w in enumerate(words):
    x0 = L2 + k * slot
    dr.rectangle([x0, T2, x0 + slot - 4, B2], outline=(255, 255, 255))
    if k == tgt:
        dr.rectangle([x0, T2, x0 + slot - 4, B2], fill=(255, 244, 214))
    for j, tag in enumerate(("case1", "case2", "case3")):
        v = S[tag][k]
        bw = (slot - 10) / 3.0
        bx = x0 + 3 + j * bw
        dr.rectangle([bx, sy(v), bx + bw - 2, B2], fill=colors[tag])
    lab = w
    dr.text((x0 + slot / 2 - 4 * len(lab), B2 + 8), lab, font=f_sm,
            fill=(150, 20, 20) if k == tgt else (70, 70, 70))
    mx = max(S[t][k] for t in S)
    dr.text((x0 + slot / 2 - 12, sy(mx) - 20), "%.2f" % mx, font=f_sm, fill=(40, 40, 40))
dr.line([(L2, B2), (R2, B2)], fill=(60, 60, 60))

dr.text((L2, B2 + 34),
        "case1 (same speaker+text) max S=%.2f   case2 (timbre only) max S=%.2f   "
        "case3 (real error on '%s') S=%.2f"
        % (d["summary"]["S_max"]["case1"], d["summary"]["S_max"]["case2"],
           words[tgt], d["summary"]["S_max"]["case3"]),
        font=f_md, fill=(20, 20, 20))
dr.text((L2, B2 + 58),
        "global normalised DTW distance:  case1 %.3f   case2 %.3f   case3 %.3f"
        "   -> d(case3)/d(case2) = %.2fx  (the GLOBAL metric does not separate)"
        % (d["global_norm_distance"]["case1"], d["global_norm_distance"]["case2"],
           d["global_norm_distance"]["case3"], d["summary"]["ratio_d3_over_d2"]),
        font=f_md, fill=(180, 30, 30),)

img.save(TMP + r"\dtw_report.png")
print("wrote", TMP + r"\dtw_report.png")
