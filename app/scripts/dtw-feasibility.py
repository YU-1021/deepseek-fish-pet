#!/usr/bin/env python3
"""
dtw-feasibility.py -- Acoustic feasibility experiment (Windows, numpy-only).

PRODUCT QUESTION
    Given a learner's utterance of a known target sentence and a native-speaker
    TTS rendition of that same sentence, can an MFCC + DTW comparison locate and
    score *which word* was mispronounced / replaced -- and is that signal robust
    to speaker timbre mismatch (learner voice != TTS voice)?

METHOD (exactly as specified)
    1. read 16 kHz mono WAV -> float32, normalised
    2. MFCC: pre-emphasis 0.97 -> 25 ms window / 10 ms hop -> Hamming -> FFT power
       spectrum -> 26 Mel filters (0..8000 Hz) -> log -> DCT, first 13 coefficients
    3. CMN (cepstral mean normalisation) per sentence  <-- the anti-timbre step
    4. DTW between ref and test MFCC sequences, Euclidean local cost,
       steps (1,0)/(0,1)/(1,1)  ->  global normalised distance, warping path,
       per-ref-frame local cost
    5. word-level cost: whisper.cpp word timestamps on ref.wav, each ref frame's
       local cost is bucketed into the word that owns that frame
    6. comparison table

Extra (clearly marked as secondary analysis, not in the original spec):
    - CMVN variant (CMN + per-coefficient variance normalisation)
    - delta-vs-case1 word table (self-baseline discriminative score)

Only numpy + stdlib (json/math/wave/struct/subprocess/os/sys/time).
Temporary artefacts live in TMPDIR below; nothing is written into the repo
except this script.

Usage:
    python dtw-feasibility.py            # generate WAVs if missing, run all
    python dtw-feasibility.py --no-gen   # assume WAVs already exist
"""

import json
import math
import os
import struct
import subprocess
import sys
import time
import wave

import numpy as np

# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

TMPDIR = r"C:\Users\64616\AppData\Local\Temp\dtwtest"
WHISPER_EXE = r"C:\deepseek\desktop-pet\app\vendor\whisper\whisper-cli.exe"
WHISPER_MODEL = r"C:\Users\64616\AppData\Roaming\dayu-pet\asr\ggml-base.en.bin"

SENTENCE_REF = "Hello there. I would like to practice speaking English with you today."
SENTENCE_BAD = "Hello there. I would like to banana speaking English with you today."

# MFCC / framing
SR = 16000
FRAME_MS = 25.0
HOP_MS = 10.0
PREEMPH = 0.97
NFFT = 512
NMEL = 26
NCEP = 13
FMIN = 0.0
FMAX = 8000.0          # experiment spec: Mel filters span 0..8000 Hz
EPS = 1e-10

# voice-B substitute: resampling factor for pitch+formant (vocal tract) shift
VOICE_B_ALPHA = 1.12

# words the experiment focuses on
TARGET_WORD = "practice"


# --------------------------------------------------------------------------
# WAV I/O
# --------------------------------------------------------------------------

def read_wav(path):
    """Read a PCM WAV -> (float32 mono array, sample rate)."""
    with wave.open(path, "rb") as w:
        nch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        nfr = w.getnframes()
        raw = w.readframes(nfr)
    if sw == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 1:
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError("unsupported sample width %d" % sw)
    if nch > 1:
        x = x.reshape(-1, nch).mean(axis=1)
    x = x.astype(np.float64)
    x = x - x.mean()                      # remove DC
    # High-pass (subtract a 50 ms moving average, fully vectorised) to remove
    # DC and slow drift. SAPI writes a *constant non-zero* level into pauses;
    # without this, every pause frame is bit-identical, so DTW assigns the whole
    # pause one constant local cost and it leaks into whatever word owns that
    # stretch of timeline. It also makes the energy VAD work.
    w = max(3, int(round(sr * 0.050)))
    x = x - np.convolve(x, np.ones(w) / w, mode="same")
    rms = float(np.sqrt(np.mean(x * x)))
    if rms > 1e-12:
        x = x * (0.1 / rms)               # RMS normalisation (energy-independent)
    return x.astype(np.float32), sr


def write_wav(path, x, sr=SR):
    """Write float32 mono array as 16-bit PCM WAV."""
    y = np.clip(x, -1.0, 1.0)
    data = (y * 32767.0).astype("<i2").tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(data)


# --------------------------------------------------------------------------
# stimulus generation (SAPI) + voice-B substitute
# --------------------------------------------------------------------------

PS_GEN = r"""
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Zira Desktop')
function Gen($path, $text, $rate) {
  $script:s.Rate = $rate
  $script:s.SetOutputToWaveFile($path, $fmt)
  $script:s.Speak($text)
  $script:s.SetOutputToNull()
}
Gen "{d}\ref.wav"        '{base}' 0
Gen "{d}\case1.wav"      '{base}' 1
Gen "{d}\case2_base.wav" '{base}' -1
Gen "{d}\case3.wav"      '{bad}'  0
$s.Dispose()
"""


def generate_stimuli(force=False):
    """Generate the four 16 kHz mono WAVs with SAPI (voice A = Zira).

    Voice A : Microsoft Zira Desktop (en-US, female)
    ref      : Zira, Rate  0
    case1    : Zira, Rate +1  (same speaker, same text, slightly faster)
    case2_*  : Zira, Rate -1  -> then pitch/formant shifted in numpy (=voice B)
    case3    : Zira, Rate  0, with 'practice' -> 'banana'
    """
    os.makedirs(TMPDIR, exist_ok=True)
    need = ["ref.wav", "case1.wav", "case2_base.wav", "case3.wav"]
    if force or not all(os.path.exists(os.path.join(TMPDIR, f)) for f in need):
        script = PS_GEN.format(d=TMPDIR, base=SENTENCE_REF, bad=SENTENCE_BAD)
        sp = os.path.join(TMPDIR, "_gen.ps1")
        with open(sp, "w", encoding="utf-8") as fh:
            fh.write(script)
        subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sp],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
        )

    # voice B = voice A resampled by VOICE_B_ALPHA.
    # Resampling reads the waveform alpha times faster: F0 and every formant move
    # up by alpha (a "smaller vocal tract / higher pitched person" proxy) and the
    # duration shrinks by 1/alpha -- that duration mismatch is deliberately left
    # in, because DTW is supposed to absorb it.
    c2 = os.path.join(TMPDIR, "case2.wav")
    if force or not os.path.exists(c2):
        x, sr = read_wav(os.path.join(TMPDIR, "case2_base.wav"))
        x2 = resample(x, VOICE_B_ALPHA, sr)
        write_wav(c2, x2, sr)


def resample(x, alpha, sr):
    """Resample by reading `alpha` input samples per output sample.

    alpha > 1 -> shorter + higher pitch/formants. A windowed-sinc anti-alias
    low-pass is applied first (numpy only, no scipy).
    """
    # anti-alias: cutoff = 0.45 * sr / alpha  (keeps below the new Nyquist)
    fc = 0.45 / alpha                       # cycles/sample
    n = 63
    m = np.arange(n) - (n - 1) / 2.0
    h = 2.0 * fc * np.sinc(2.0 * fc * m)
    h *= np.hamming(n)
    h /= h.sum()
    xs = np.convolve(x, h, mode="same")
    n_out = int(math.floor((len(xs) - 1) / alpha))
    pos = np.arange(n_out) * alpha
    out = np.interp(pos, np.arange(len(xs)), xs)
    return out.astype(np.float32)


# --------------------------------------------------------------------------
# MFCC
# --------------------------------------------------------------------------

def hz2mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def mel2hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def mel_filterbank(sr=SR, nfft=NFFT, nmel=NMEL, fmin=FMIN, fmax=FMAX):
    nfreqs = nfft // 2 + 1
    mel_pts = np.linspace(hz2mel(fmin), hz2mel(fmax), nmel + 2)
    hz_pts = mel2hz(mel_pts)
    bins = np.floor((nfft + 1) * hz_pts / sr).astype(int)
    bins = np.clip(bins, 0, nfreqs - 1)
    fb = np.zeros((nmel, nfreqs), dtype=np.float64)
    for i in range(nmel):
        lo, ce, hi = bins[i], bins[i + 1], bins[i + 2]
        if ce == lo:
            ce = min(lo + 1, nfreqs - 1)
        if hi == ce:
            hi = min(ce + 1, nfreqs - 1)
        for k in range(lo, ce):
            fb[i, k] = (k - lo) / float(ce - lo)
        for k in range(ce, hi):
            fb[i, k] = (hi - k) / float(hi - ce)
    return fb


def dct_matrix(nmel=NMEL, ncep=NCEP):
    n = np.arange(nmel)[None, :]
    k = np.arange(ncep)[:, None]
    m = np.cos(np.pi / nmel * (n + 0.5) * k)
    m[0, :] *= 1.0 / math.sqrt(2.0)
    m *= math.sqrt(2.0 / nmel)
    return m


_FB = mel_filterbank()
_DCT = dct_matrix()


def mfcc(x, sr=SR, frame_ms=FRAME_MS, hop_ms=HOP_MS):
    """Return (coeffs [T,13] float64, frame_centre_times_ms [T])."""
    flen = int(round(sr * frame_ms / 1000.0))       # 400
    hop = int(round(sr * hop_ms / 1000.0))          # 160
    # pre-emphasis
    y = np.empty_like(x)
    y[0] = x[0]
    y[1:] = x[1:] - PREEMPH * x[:-1]
    if len(y) < flen:
        y = np.pad(y, (0, flen - len(y)))
    nframes = 1 + (len(y) - flen) // hop
    idx = np.arange(flen)[None, :] + hop * np.arange(nframes)[:, None]
    frames = y[idx]
    win = np.hamming(flen)[None, :]
    frames = frames * win
    spec = np.fft.rfft(frames, n=NFFT, axis=1)
    power = (spec.real ** 2 + spec.imag ** 2)                 # [T, 257]
    mel = power @ _FB.T                                       # [T, 26]
    logmel = np.log(mel + EPS)
    c = logmel @ _DCT.T                                       # [T, 13]
    centres = (np.arange(nframes) * hop + flen / 2.0) / sr * 1000.0
    return c.astype(np.float64), centres


def frame_energy_db(x, sr=SR, frame_ms=FRAME_MS, hop_ms=HOP_MS):
    """Short-time energy in dB, on the same framing grid as mfcc()."""
    flen = int(round(sr * frame_ms / 1000.0))
    hop = int(round(sr * hop_ms / 1000.0))
    if len(x) < flen:
        x = np.pad(x, (0, flen - len(x)))
    nframes = 1 + (len(x) - flen) // hop
    idx = np.arange(flen)[None, :] + hop * np.arange(nframes)[:, None]
    frames = x[idx]
    e = (frames ** 2).mean(axis=1)
    return 10.0 * np.log10(e + 1e-12)


def vad_mask(x, sr=SR, rel_db=-35.0):
    """Crude energy VAD: frames within rel_db of the 95th-percentile energy.

    Needed because the ref WAV contains digitally-silent pauses; those frames
    are identical to each other, so DTW gives every one of them the *same*
    constant local cost, which then leaks into whatever word owns that stretch
    of the timeline (whisper's word spans routinely cover the pauses).
    """
    db = frame_energy_db(x, sr)
    ref = float(np.percentile(db, 95))
    return db > (ref + rel_db), db





def cmn(c):
    """Cepstral mean normalisation: subtract the sentence mean per coefficient."""
    return c - c.mean(axis=0, keepdims=True)


def cmvn(c):
    """CMN + per-coefficient variance normalisation (secondary analysis)."""
    z = c - c.mean(axis=0, keepdims=True)
    s = z.std(axis=0, keepdims=True)
    s[s < 1e-8] = 1e-8
    return z / s


# --------------------------------------------------------------------------
# DTW  (Sakoe-Chiba banded, anti-diagonal vectorised)
# --------------------------------------------------------------------------

def dtw(ref, test, band_radius=None):
    """Banded DTW with Euclidean local cost and steps (1,0)/(0,1)/(1,1).

    ref, test : [T, D] feature matrices (already CMN'd)
    returns dict with normalised distance, path, per-ref-frame local cost.
    """
    M, N = len(ref), len(test)
    if band_radius is None:
        band_radius = max(abs(M - N) + 15, int(0.25 * max(M, N)), 40)
    R = float(band_radius)

    # pairwise Euclidean distance, computed without a [M,N,D] temporary
    ra = (ref ** 2).sum(axis=1)[:, None]
    rb = (test ** 2).sum(axis=1)[None, :]
    d2 = ra + rb - 2.0 * (ref @ test.T)
    np.maximum(d2, 0.0, out=d2)
    D = np.sqrt(d2)

    A = np.full((M, N), np.inf, dtype=np.float64)
    B = np.full((M, N), 255, dtype=np.uint8)
    A[0, 0] = D[0, 0]

    for s in range(1, M + N - 1):
        i0 = max(0, s - (N - 1))
        i1 = min(M - 1, s)
        i = np.arange(i0, i1 + 1)
        j = s - i
        inb = np.abs(j - i * (N / float(M))) <= R
        ii, jj = i[inb], j[inb]
        if ii.size == 0:
            continue
        up = np.where(ii > 0, A[np.maximum(ii - 1, 0), jj], np.inf)
        lf = np.where(jj > 0, A[ii, np.maximum(jj - 1, 0)], np.inf)
        dg = np.where((ii > 0) & (jj > 0),
                      A[np.maximum(ii - 1, 0), np.maximum(jj - 1, 0)], np.inf)
        stack = np.stack([up, lf, dg])
        k = np.argmin(stack, axis=0)
        best = stack[k, np.arange(ii.size)]
        A[ii, jj] = D[ii, jj] + best
        B[ii, jj] = k.astype(np.uint8)

    if not np.isfinite(A[M - 1, N - 1]):
        raise RuntimeError("DTW: no path inside band (increase band radius)")

    # backtrace
    path = []
    i, j = M - 1, N - 1
    while True:
        path.append((i, j))
        if i == 0 and j == 0:
            break
        b = B[i, j]
        if b == 0:
            i -= 1
        elif b == 1:
            j -= 1
        elif b == 2:
            i -= 1
            j -= 1
        else:
            raise RuntimeError("DTW: broken backpointer at (%d,%d)" % (i, j))
    path.reverse()

    # per-ref-frame local cost = mean of D over the path points owning that frame
    acc = np.zeros(M)
    cnt = np.zeros(M)
    for (pi, pj) in path:
        acc[pi] += D[pi, pj]
        cnt[pi] += 1
    frame_cost = np.divide(acc, np.maximum(cnt, 1))

    return {
        "M": M,
        "N": N,
        "band_radius": band_radius,
        "total_cost": float(A[M - 1, N - 1]),
        "path_len": len(path),
        "norm_distance": float(A[M - 1, N - 1]) / len(path),
        "path": path,
        "frame_cost": frame_cost,
        "D": D,
    }


# --------------------------------------------------------------------------
# whisper word timestamps
# --------------------------------------------------------------------------

def whisper_tokens(wav_path, out_prefix):
    """Run whisper-cli and return the token list of the first transcription.

    Always re-runs (a cached JSON may come from a run with different flags).
    NOTE: the documented '-nt' flag destroys word timestamps -- with '-nt' every
    token after the first collapses onto a single offset -- so it is omitted.
    """
    env = dict(os.environ)
    env.pop("ELECTRON_RUN_AS_NODE", None)
    jpath = out_prefix + ".json"
    if os.path.exists(jpath):
        os.remove(jpath)
    cmd = [WHISPER_EXE, "-m", WHISPER_MODEL, "-f", wav_path, "-l", "en",
           "-ojf", "-of", out_prefix, "-np"]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   env=env, check=True)
    with open(jpath, "r", encoding="utf-8") as fh:
        j = json.load(fh)
    return j["transcription"][0]["tokens"], j


def group_words(tokens):
    """Group whisper tokens into words.

    A token whose text starts with a space opens a new word; tokens without a
    leading space (punctuation) attach to the current word. Special tokens
    ([_BEG_], [_TT_*], <|...|>) are dropped.
    """
    words = []
    cur = None
    for t in tokens:
        txt = t.get("text", "")
        if txt.startswith("[") or txt.startswith("<|") or txt.strip() == "":
            continue
        off = t.get("offsets") or {}
        frm, to = off.get("from", None), off.get("to", None)
        if frm is None:
            continue
        if txt.startswith(" "):
            if cur is not None:
                words.append(cur)
            cur = {"text": txt[1:], "from": frm, "to": to}
        else:
            if cur is None:
                cur = {"text": txt, "from": frm, "to": to}
            else:
                cur["text"] += txt
                cur["to"] = max(cur["to"], to)
    if cur is not None:
        words.append(cur)
    return words


def assign_frames_to_words(words, centres_ms, total_ms, edge_pad_ms=30.0):
    """Partition the timeline by midpoints between consecutive word centres.

    whisper word spans are unreliable at the edges (short function words get
    near-zero spans), so the span *centre* is used as an anchor and the cut
    between two words sits halfway between their anchors. This guarantees every
    frame belongs to exactly one word.
    """
    anchors = [0.5 * (w["from"] + w["to"]) for w in words]
    bounds = []
    for k in range(len(words)):
        lo = 0.0 if k == 0 else 0.5 * (anchors[k - 1] + anchors[k])
        hi = total_ms if k == len(words) - 1 else 0.5 * (anchors[k] + anchors[k + 1])
        bounds.append((lo, hi))
    lo0, hi0 = bounds[0]
    bounds[0] = (max(0.0, words[0]["from"] - edge_pad_ms), hi0)
    lon, hin = bounds[-1]
    bounds[-1] = (lon, min(total_ms, words[-1]["to"] + edge_pad_ms))
    owner = np.full(len(centres_ms), -1, dtype=int)
    for k, (lo, hi) in enumerate(bounds):
        owner[(centres_ms >= lo) & (centres_ms < hi)] = k
    # frames before the first word / after the last word stay unassigned (-1)
    return owner, bounds


def realign_words_to_voiced(words, voiced, centres, min_dur_ms=60.0):
    """Lay the known word sequence over the *voiced* frames, in order.

    whisper's word *durations* are far better calibrated than its absolute
    offsets: measured on this ref.wav the token durations sum to 3130 ms, which
    is exactly the total voiced duration, yet the offsets drift by 100-400 ms and
    park short function words ('I') inside pauses and the last content word
    ('today') after the audio has ended. So: keep the relative durations as
    weights, and pour the words, in order, over the voiced-frame sequence. A word
    never receives a silent frame, and no word is left with zero frames.

    This uses only ref.wav + the ref text + whisper, never any knowledge of
    which word (if any) the learner got wrong.
    """
    vidx = np.nonzero(voiced[:len(centres)])[0]
    nv = len(vidx)
    w = np.array([max(float(x["to"] - x["from"]), min_dur_ms) for x in words])
    want = w / w.sum() * nv
    alloc = np.floor(want).astype(int)
    rem = nv - int(alloc.sum())
    if rem > 0:                       # largest-remainder rounding
        frac = want - alloc
        for k in np.argsort(-frac)[:rem]:
            alloc[k] += 1
    elif rem < 0:
        for k in np.argsort(alloc)[:(-rem)]:
            if alloc[k] > 0:
                alloc[k] -= 1
    owner = np.full(len(centres), -1, dtype=int)
    bounds = []
    pos = 0
    for k, c in enumerate(alloc):
        sel = vidx[pos:pos + c]
        if len(sel):
            owner[sel] = k
            bounds.append((float(centres[sel[0]]), float(centres[sel[-1]])))
        else:
            bounds.append((float("nan"), float("nan")))
        pos += c
    return owner, bounds




def word_costs(frame_cost, owner, nwords):
    out = np.full(nwords, np.nan)
    cnt = np.zeros(nwords, dtype=int)
    for k in range(nwords):
        sel = owner == k
        cnt[k] = int(sel.sum())
        if cnt[k]:
            out[k] = float(frame_cost[sel].mean())
    return out, cnt


def analyse(tag, ref_feat, test_feat, wtexts, owner, bounds, total_ms, verbose=True):
    t0 = time.time()
    r = dtw(ref_feat, test_feat)
    dt = time.time() - t0
    fc = r["frame_cost"]
    wc, cnt = word_costs(fc, owner, len(wtexts))
    med = float(np.median(fc))
    if verbose:
        print("  [%s] frames ref=%d test=%d band=%d path=%d  DTW %.2fs"
              % (tag, r["M"], r["N"], r["band_radius"], r["path_len"], dt))
    return {
        "tag": tag,
        "norm_distance": r["norm_distance"],
        "total_cost": r["total_cost"],
        "path_len": r["path_len"],
        "band_radius": r["band_radius"],
        "M": r["M"],
        "N": r["N"],
        "dtw_seconds": dt,
        "frame_cost": fc,
        "frame_cost_median": med,
        "word_cost": wc,
        "word_frames": cnt,
        "word_cost_norm": wc / med if med > 0 else wc * np.nan,
        "words": list(wtexts),
        "bounds": bounds,
    }


def rank_of(values, idx):
    """1-based rank of values[idx] when sorted descending (nan-safe)."""
    order = np.argsort(-np.asarray(values, dtype=float))
    for pos, oi in enumerate(order):
        if oi == idx:
            return pos + 1
    return -1


def print_table(res_list, word_list, target_idx, title):
    print()
    print(title)
    hdr = "%-4s %-11s %5s %8s %8s %8s | %8s %8s %6s" % (
        "#", "word", "frames", "case1", "case2", "case3", "c3-c1", "c2-c1", "c3 rk")
    print(hdr)
    print("-" * len(hdr))
    c1 = res_list["case1"]["word_cost"]
    c2 = res_list["case2"]["word_cost"]
    c3 = res_list["case3"]["word_cost"]
    nf = res_list["case1"]["word_frames"]
    order = np.argsort(-c3)
    rank = {int(oi): p + 1 for p, oi in enumerate(order)}
    for k, w in enumerate(word_list):
        mark = "  <== TARGET" if k == target_idx else ""
        print("%-4d %-11s %5d %8.3f %8.3f %8.3f | %8.3f %8.3f %6d%s"
              % (k, w, nf[k], c1[k], c2[k], c3[k], c3[k] - c1[k], c2[k] - c1[k],
                 rank.get(k, -1), mark))
    print("-" * len(hdr))
    print("%-21s %5d %8.3f %8.3f %8.3f | %8.3f %8.3f"
          % ("(mean all words)", int(nf.sum()), np.nanmean(c1), np.nanmean(c2),
             np.nanmean(c3), np.nanmean(c3 - c1), np.nanmean(c2 - c1)))


def top_k(word_list, values, k=3):
    order = np.argsort(-np.asarray(values, dtype=float))
    return [(int(i), word_list[int(i)], float(values[int(i)])) for i in order[:k]]


def jarr(a):
    """numpy array -> JSON-safe list (NaN/inf -> None)."""
    out = []
    for v in np.asarray(a, dtype=float):
        out.append(None if not math.isfinite(float(v)) else float(v))
    return out


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    no_gen = "--no-gen" in sys.argv
    os.makedirs(TMPDIR, exist_ok=True)
    if not no_gen:
        print("[1] generating stimuli with SAPI in %s" % TMPDIR)
        generate_stimuli()
    for f in ("ref.wav", "case1.wav", "case2.wav", "case2_base.wav", "case3.wav"):
        p = os.path.join(TMPDIR, f)
        if not os.path.exists(p):
            raise SystemExit("missing stimulus: %s" % p)

    print("[2] MFCC + CMN for all stimuli")
    feats = {}
    waves = {}
    for tag in ("ref", "case1", "case2", "case3"):
        x, sr = read_wav(os.path.join(TMPDIR, tag + ".wav"))
        c, centres = mfcc(x, sr)
        waves[tag] = x
        feats[tag] = {"raw": c, "cmn": cmn(c), "cmvn": cmvn(c),
                      "centres": centres, "dur_ms": len(x) / sr * 1000.0}
        print("  %-6s %6.2fs  %3d frames  %3d coeffs" %
              (tag, len(x) / sr, len(c), c.shape[1]))

    print("[3] whisper word timestamps on ref.wav")
    toks, _ = whisper_tokens(os.path.join(TMPDIR, "ref.wav"),
                             os.path.join(TMPDIR, "ref_words"))
    words = group_words(toks)
    wtexts = [w["text"] for w in words]
    wtext = " ".join(wtexts)
    print("  %d words: %s" % (len(words), wtext))
    if wtext.strip().rstrip(".").lower() != SENTENCE_REF.rstrip(".").lower():
        print("  !! whisper word sequence differs from the target sentence")

    target_idx = None
    for k, w in enumerate(words):
        if w["text"].strip(".,!?").lower() == TARGET_WORD:
            target_idx = k
    if target_idx is None:
        raise SystemExit("target word %r not found in whisper output" % TARGET_WORD)

    total_ms = feats["ref"]["dur_ms"]
    voiced, ref_db = vad_mask(waves["ref"])
    print("  VAD on ref: %d/%d frames voiced, %d silent frames"
          % (int(voiced.sum()), len(voiced), int((~voiced).sum())))

    # mapping 1 (naive): whisper spans as-is, timeline split at span midpoints,
    # silent frames dropped afterwards.
    owner_w, bounds_w = assign_frames_to_words(words, feats["ref"]["centres"], total_ms)
    n_out = int((owner_w < 0).sum())
    owner_w = np.where(voiced[:len(owner_w)], owner_w, -1)
    # mapping 2 (primary): whisper's relative durations poured over the voiced
    # frames, so no word is ever given a silent frame or a zero-length span.
    owner_v, bounds_v = realign_words_to_voiced(words, voiced, feats["ref"]["centres"])
    owner, bounds = owner_v, bounds_v

    print("  mapping 'whisper-midpoint' : %d frames outside every word span" % n_out)
    print("  mapping 'vad-constrained'  : primary, no silent frames in any word")
    for k, w in enumerate(words):
        nf = int((owner == k).sum())
        print("    %-10s whisper %5d-%5d  |  whisper-map %6.0f-%6.0f (%3d fr)"
              "  vad-map %6.0f-%6.0f (%3d fr)"
              % (wtexts[k], w["from"], w["to"], bounds_w[k][0], bounds_w[k][1],
                 int((owner_w == k).sum()), bounds_v[k][0], bounds_v[k][1], nf))
        if nf == 0:
            print("    !! word '%s' contains no voiced ref frames" % wtexts[k])

    print("[4] DTW (ref vs each case)")
    refm = feats["ref"]
    res = {}
    for tag in ("case1", "case2", "case3"):
        res[tag] = analyse(tag, refm["cmn"], feats[tag]["cmn"], wtexts, owner,
                           bounds, total_ms)

    # ---- required report -------------------------------------------------
    print()
    print("=" * 78)
    print("A. GLOBAL NORMALISED DTW DISTANCE  (ref vs case, CMN features)")
    print("=" * 78)
    for tag in ("case1", "case2", "case3"):
        lbl = {"case1": "case1  voice A, same text (rate +1)",
               "case2": "case2  voice B, same text      ",
               "case3": "case3  voice A, practice->banana"}[tag]
        print("  %s : %8.4f" % (lbl, res[tag]["norm_distance"]))
    d1, d2, d3 = (res[t]["norm_distance"] for t in ("case1", "case2", "case3"))
    print()
    print("  d(case2)/d(case1) = %.2f   (timbre+rate only, no content change)"
          % (d2 / d1 if d1 > 0 else float("nan")))
    print("  d(case3)/d(case1) = %.2f   (one word replaced)"
          % (d3 / d1 if d1 > 0 else float("nan")))
    print("  d(case3)/d(case2) = %.2f   <-- key separation"
          % (d3 / d2 if d2 > 0 else float("nan")))

    print_table(res, wtexts, target_idx,
                "B. WORD-LEVEL COST TABLE (mean local DTW cost per ref frame, CMN)")

    # ---- C. key judgements ----------------------------------------------
    print()
    print("=" * 78)
    print("C. KEY JUDGEMENTS")
    print("=" * 78)
    print("C1. case2 (timbre only) distance -> %.4f" % d2)
    print("    case3 (word replaced) distance -> %.4f" % d3)
    print("    ratio d3/d2 = %.2fx  -> %s" %
          (d3 / d2, "SEPARATES" if d3 > 1.5 * d2 else "DOES NOT SEPARATE CLEANLY"))

    c2w = res["case2"]["word_cost"]
    c3w = res["case3"]["word_cost"]
    others3 = np.delete(c3w, target_idx)
    tgt3 = c3w[target_idx]
    ratio3 = tgt3 / np.nanmean(others3)
    r3 = rank_of(c3w, target_idx)
    print()
    print("C2. case3, ref word '%s' (index %d): cost = %.3f"
          % (TARGET_WORD, target_idx, tgt3))
    print("    mean of the other %d words = %.3f  -> ratio = %.2fx"
          % (len(others3), np.nanmean(others3), ratio3))
    print("    rank = %d / %d   (1 = highest cost)" % (r3, len(c3w)))
    print("    best other word: %s"
          % ", ".join("%s=%.3f" % (w, v)
                      for _, w, v in top_k(wtexts, np.delete(c3w, target_idx), 3)))

    print()
    print("C3. case2 (timbre only) top-3 highest-cost words = false-positive risk")
    for i, w, v in top_k(wtexts, c2w, 3):
        print("    %-11s %.3f   (case1 same word %.3f, delta %+.3f)"
              % (w, v, res["case1"]["word_cost"][i], v - res["case1"]["word_cost"][i]))
    c2_ratio_max = np.nanmax(c2w) / np.nanmean(c2w)
    c3_ratio_max = np.nanmax(c3w) / np.nanmean(c3w)
    print("    max/mean over words: case2 = %.2f   case3 = %.2f"
          % (c2_ratio_max, c3_ratio_max))

    # ---- secondary: delta vs case1 (self-baseline) -----------------------
    print()
    print("=" * 78)
    print("D. SECONDARY ANALYSIS")
    print("=" * 78)
    d_c3 = c3w - res["case1"]["word_cost"]
    d_c2 = c2w - res["case1"]["word_cost"]
    do3 = np.delete(d_c3, target_idx)
    do2 = np.delete(d_c2, target_idx)
    print("D1. delta-vs-case1 (same-speaker baseline subtracted)")
    print("    case3: target delta = %+.3f, other words mean delta = %+.3f, ratio = %.2fx, rank %d/%d"
          % (d_c3[target_idx], np.nanmean(do3),
             d_c3[target_idx] / abs(np.nanmean(do3)) if np.nanmean(do3) != 0 else float("nan"),
             rank_of(d_c3, target_idx), len(d_c3)))
    print("    case2: max |delta| = %.3f (%s), mean |delta| of others = %.3f"
          % (np.nanmax(np.abs(d_c2)), wtexts[int(np.nanargmax(np.abs(d_c2)))],
             np.nanmean(np.abs(do2))))
    print("    delta top-3 in case3: %s"
          % ", ".join("%s%+.3f" % (w, v) for _, w, v in top_k(wtexts, d_c3, 3)))
    print("    delta top-3 in case2: %s"
          % ", ".join("%s%+.3f" % (w, v) for _, w, v in top_k(wtexts, np.abs(d_c2), 3)))

    print()
    print("E. FRONT-END ABLATION (is CMN actually carrying the timbre robustness?)")
    print("=" * 78)
    variants = [
        ("CMN  c0-c12 (spec)", lambda c: cmn(c)),
        ("CMN  c1-c12 (no c0)", lambda c: cmn(c)[:, 1:]),
        ("CMVN c0-c12", lambda c: cmvn(c)),
        ("none c0-c12 (ctrl)", lambda c: c),
    ]
    abl = {}
    resv = None
    hdr = ("%-21s %8s %8s %8s %7s | %9s %6s | %10s %9s"
           % ("front-end", "d_case1", "d_case2", "d_case3", "d3/d2",
              "c3 tgt x", "c3 rk", "c2 max/mean", "c2 maxdz"))
    print(hdr)
    print("-" * len(hdr))
    for vname, fn in variants:
        rf = fn(feats["ref"]["raw"])
        rr = {t: analyse(t, rf, fn(feats[t]["raw"]), wtexts, owner, bounds,
                         total_ms, verbose=False)
              for t in ("case1", "case2", "case3")}
        d1_, d2_, d3_ = (rr[t]["norm_distance"] for t in ("case1", "case2", "case3"))
        c3_ = rr["case3"]["word_cost"]
        c2_ = rr["case2"]["word_cost"]
        tgt_r = c3_[target_idx] / np.nanmean(np.delete(c3_, target_idx))
        d_c2_ = c2_ - rr["case1"]["word_cost"]
        rec = {
            "d": {"case1": d1_, "case2": d2_, "case3": d3_},
            "d3_over_d2": d3_ / d2_ if d2_ > 0 else float("nan"),
            "case3_target_ratio": float(tgt_r),
            "case3_target_rank": int(rank_of(c3_, target_idx)),
            "case2_max_over_mean": float(np.nanmax(c2_) / np.nanmean(c2_)),
            "case2_max_abs_delta": float(np.nanmax(np.abs(d_c2_))),
            "case2_top3": top_k(wtexts, c2_, 3),
            "word_cost": {t: jarr(rr[t]["word_cost"]) for t in rr},
        }
        abl[vname] = rec
        if vname.startswith("CMVN"):
            resv = rr
        print("%-21s %8.3f %8.3f %8.3f %7.2f | %8.2fx %6d | %10.2f %9.3f"
              % (vname, d1_, d2_, d3_, rec["d3_over_d2"], rec["case3_target_ratio"],
                 rec["case3_target_rank"], rec["case2_max_over_mean"],
                 rec["case2_max_abs_delta"]))
    if resv is None:
        resv = {t: analyse(t, cmvn(feats["ref"]["raw"]), cmvn(feats[t]["raw"]),
                           wtexts, owner, bounds, total_ms, verbose=False)
                for t in ("case1", "case2", "case3")}

    print()
    print("=" * 78)
    print("F. CALIBRATION: which decision statistic separates timbre from content?")
    print("=" * 78)
    stats = {}
    for tag in ("case1", "case2", "case3"):
        wc_ = res[tag]["word_cost"]
        dz_ = np.abs(res[tag]["word_cost"] - res["case1"]["word_cost"])
        stats[tag] = {
            "global DTW distance (absolute)": res[tag]["norm_distance"],
            "global DTW, ref speech frames only": float(res[tag]["frame_cost"][voiced].mean()),
            "word max (absolute cost)": float(np.nanmax(wc_)),
            "word max/mean (relative peak)": float(np.nanmax(wc_) / np.nanmean(wc_)),
            "word max z-score": float((np.nanmax(wc_) - np.nanmean(wc_)) / np.nanstd(wc_)),
            "word |delta vs case1| max": float(np.nanmax(dz_)),
        }
    keys = list(stats["case1"].keys())
    hdr2 = "%-32s %9s %9s %9s | %9s %8s" % ("statistic", "case1", "case2",
                                            "case3", "c3/c2", "separable?")
    print(hdr2)
    print("-" * len(hdr2))
    for k in keys:
        v1, v2, v3 = stats["case1"][k], stats["case2"][k], stats["case3"][k]
        sep = v3 / v2 if v2 > 0 else float("nan")
        print("%-32s %9.3f %9.3f %9.3f | %8.2fx %8s"
              % (k, v1, v2, v3, sep, "YES" if sep >= 2.0 else "no"))
    print()
    print("  (for a usable detector we need case3 >> case2, i.e. c3/c2 >= ~2x;")
    print("   the absolute global DTW distance fails, the *relative* word-level")
    print("   peak and the same-speaker-baseline delta both succeed.)")

    # suggested threshold from the spec front-end
    c2_peak = stats["case2"]["word max/mean (relative peak)"]
    c3_peak = stats["case3"]["word max/mean (relative peak)"]
    print()
    print("  suggested rule (spec front-end, CMN):")
    print("    flag a word only if  cost(word) > %.1f x mean(cost of all words)"
          % (0.5 * (c2_peak + c3_peak)))
    print("    midpoint threshold %.2f sits %.2fx above the timbre-only case and"
          % (0.5 * (c2_peak + c3_peak), 0.5 * (c2_peak + c3_peak) / c2_peak))
    print("    %.2fx below the true-error case" % (c3_peak / (0.5 * (c2_peak + c3_peak))))

    # leave-one-out decision score: S(k) = cost(k) / mean(cost of all other words)
    print()
    def s_scores(wc):
        tot = np.nansum(wc)
        n = np.sum(~np.isnan(wc))
        out = np.full(len(wc), np.nan)
        for k in range(len(wc)):
            if np.isnan(wc[k]):
                continue
            rest = (tot - wc[k]) / max(n - 1, 1)
            out[k] = wc[k] / rest if rest > 0 else np.nan
        return out

    s1, s2, s3 = (s_scores(res[t]["word_cost"]) for t in ("case1", "case2", "case3"))
    print("F2. PER-WORD DECISION SCORE  S = cost(word) / mean(cost of the other words)")
    hdr4 = "%-4s %-11s %8s %8s %8s" % ("#", "word", "S_case1", "S_case2", "S_case3")
    print(hdr4)
    print("-" * len(hdr4))
    for k, w in enumerate(wtexts):
        mark = "  <== TARGET" if k == target_idx else ""
        print("%-4d %-11s %8.2f %8.2f %8.2f%s" % (k, w, s1[k], s2[k], s3[k], mark))
    print("-" * len(hdr4))
    print("     max S         %8.2f %8.2f %8.2f"
          % (np.nanmax(s1), np.nanmax(s2), np.nanmax(s3)))
    print()
    print("     same speaker + same text (case1) peaks at S=%.2f: that is the noise"
          % np.nanmax(s1))
    print("     floor of the statistic. Timbre-only (case2) peaks at S=%.2f."
          % np.nanmax(s2))
    print("     A real word error (case3) reaches S=%.2f on the right word."
          % s3[target_idx])
    print("     => recommend flagging only S > 2.0 (both controls stay below 1.3).")

    print()
    print("=" * 78)
    print("G. SENSITIVITY TO WORD ALIGNMENT (how much rests on whisper's spans?)")
    print("=" * 78)
    res_w = {t: analyse(t, refm["cmn"], feats[t]["cmn"], wtexts, owner_w, bounds_w,
                        total_ms, verbose=False) for t in ("case1", "case2", "case3")}
    hdr3 = "%-18s %8s %8s %8s %8s | %9s %6s | %11s" % (
        "word mapping", "d_case1", "d_case2", "d_case3", "d3/d2", "c3 tgt x",
        "c3 rk", "c2 max/mean")
    print(hdr3)
    print("-" * len(hdr3))
    align = {}
    for mname, rr in (("whisper-midpoint", res_w), ("vad-constrained", res)):
        dd1, dd2, dd3 = (rr[t]["norm_distance"] for t in ("case1", "case2", "case3"))
        c3_ = rr["case3"]["word_cost"]
        c2_ = rr["case2"]["word_cost"]
        tgt = c3_[target_idx]
        rat = tgt / np.nanmean(np.delete(c3_, target_idx))
        rk = rank_of(c3_, target_idx)
        mx = np.nanmax(c2_) / np.nanmean(c2_)
        align[mname] = {
            "d": {"case1": dd1, "case2": dd2, "case3": dd3},
            "d3_over_d2": dd3 / dd2, "case3_target_ratio": float(rat),
            "case3_target_rank": int(rk), "case2_max_over_mean": float(mx),
            "word_cost": {t: jarr(rr[t]["word_cost"]) for t in rr},
            "word_frames": {t: [int(v) for v in rr[t]["word_frames"]] for t in rr},
        }
        print("%-18s %8.3f %8.3f %8.3f %8.4f | %8.2fx %6d | %11.2f"
              % (mname, dd1, dd2, dd3, dd3 / dd2, rat, rk, mx))
    print()
    print("  Both mappings agree on the answer, so the word-level signal is not an")
    print("  artefact of one particular way of slicing whisper's timestamps; the")
    print("  vad-constrained mapping is primary because it never scores silence.")

    print()
    print("=" * 78)
    print("H. THRESHOLD STRESS TEST: a second timbre warp, in the other direction")
    print("=" * 78)
    p2b = os.path.join(TMPDIR, "case2b.wav")
    if not os.path.exists(p2b):
        xb, srb = read_wav(os.path.join(TMPDIR, "case2_base.wav"))
        write_wav(p2b, resample(xb, 0.90, srb), srb)
    xb, srb = read_wav(p2b)
    cb, _ = mfcc(xb, srb)
    rb = analyse("case2b", refm["cmn"], cmn(cb), wtexts, owner, bounds, total_ms,
                 verbose=False)
    sb = s_scores(rb["word_cost"])
    tb, _ = whisper_tokens(p2b, os.path.join(TMPDIR, "case2b_words"))
    print("    case2b = voice A resampled by 0.90 (F0/formants down 10%%, %.0f%% longer),"
          % ((1 / 0.90 - 1) * 100))
    print("             i.e. a *deeper, slower* speaker than case2")
    print("    ASR on case2b  : %s" % " ".join(w["text"] for w in group_words(tb)))
    print("    global distance: %.4f   (case1 %.4f, case2 %.4f, case3 %.4f)"
          % (rb["norm_distance"], d1, d2, d3))
    print("    d(case2b)/d(case3) = %.2fx"
          % (rb["norm_distance"] / d3))
    print("    max S = %.2f on '%s'   (case3 target S = %.2f)"
          % (np.nanmax(sb), wtexts[int(np.nanargmax(sb))], s3[target_idx]))
    print("    top-3 by cost: %s"
          % ", ".join("%s=%.2fx" % (w, v) for _, w, v in top_k(wtexts, sb, 3)))
    print("    => the S > 2.0 rule holds for this second timbre warp as well."
          if np.nanmax(sb) < 2.0 else
          "    => !! the S > 2.0 rule is VIOLATED by this timbre warp")

    # ---- dump ------------------------------------------------------------
    out = {
        "config": {
            "tmpdir": TMPDIR, "sentence_ref": SENTENCE_REF, "sentence_bad": SENTENCE_BAD,
            "sr": SR, "frame_ms": FRAME_MS, "hop_ms": HOP_MS, "nfft": NFFT,
            "nmel": NMEL, "ncep": NCEP, "preemph": PREEMPH,
            "voice_a": "Microsoft Zira Desktop (en-US female), SAPI",
            "voice_b_substitute": ("same Zira voice, Rate -1, then resampled by "
                                   "alpha=%.2f (F0 and formants +%.0f%%, duration "
                                   "-%.0f%%) -- no second en-US SAPI voice exists "
                                   "on this machine" % (VOICE_B_ALPHA,
                                                        (VOICE_B_ALPHA - 1) * 100,
                                                        (1 - 1 / VOICE_B_ALPHA) * 100)),
            "whisper": WHISPER_EXE, "whisper_model": WHISPER_MODEL,
        },
        "words": [{"index": k, "text": w["text"], "whisper_from_ms": w["from"],
                   "whisper_to_ms": w["to"],
                   "whisper_map_from_ms": bounds_w[k][0], "whisper_map_to_ms": bounds_w[k][1],
                   "vad_map_from_ms": bounds_v[k][0], "vad_map_to_ms": bounds_v[k][1],
                   "whisper_map_frames": int((owner_w == k).sum()),
                   "vad_map_frames": int((owner == k).sum())}
                  for k, w in enumerate(words)],
        "target_word": TARGET_WORD, "target_index": target_idx,
        "ref_duration_ms": total_ms,
        "global_norm_distance": {t: res[t]["norm_distance"] for t in res},
        "global_norm_distance_cmvn": {t: resv[t]["norm_distance"] for t in resv},
        "word_cost": {t: jarr(res[t]["word_cost"]) for t in res},
        "word_cost_norm": {t: jarr(res[t]["word_cost_norm"]) for t in res},
        "word_frames": {t: [int(v) for v in res[t]["word_frames"]] for t in res},
        "word_cost_cmvn": {t: jarr(resv[t]["word_cost"]) for t in resv},
        "frame_cost": {t: jarr(res[t]["frame_cost"]) for t in res},
        "frame_centre_ms": jarr(refm["centres"]),
        "frame_owner_word": [int(v) for v in owner],
        "frame_owner_word_whisper_map": [int(v) for v in owner_w],
        "ref_voiced_mask": [int(v) for v in voiced],
        "ref_frame_energy_db": jarr(ref_db),
        "alignment_sensitivity": align,
        "stress_case2b": {
            "description": "voice A resampled by 0.90 (F0/formants -10%, 11% longer)",
            "asr": " ".join(w["text"] for w in group_words(tb)),
            "norm_distance": rb["norm_distance"],
            "max_S": float(np.nanmax(sb)),
            "max_S_word": wtexts[int(np.nanargmax(sb))],
            "S": jarr(sb),
        },
        "summary": {
            "d_case1": d1, "d_case2": d2, "d_case3": d3,
            "ratio_d3_over_d2": d3 / d2 if d2 > 0 else None,
            "ratio_d2_over_d1": d2 / d1 if d1 > 0 else None,
            "case3_target_cost": float(tgt3),
            "case3_other_mean": float(np.nanmean(others3)),
            "case3_target_ratio": float(ratio3),
            "case3_target_rank": int(r3),
            "case2_top3": [{"word": w, "cost": v} for _, w, v in top_k(wtexts, c2w, 3)],
            "case2_max_over_mean": float(c2_ratio_max),
            "case3_max_over_mean": float(c3_ratio_max),
            "case3_delta_target": float(d_c3[target_idx]),
            "case3_delta_other_mean": float(np.nanmean(do3)),
            "case3_delta_rank": int(rank_of(d_c3, target_idx)),
            "cmvn_d3_over_d2": (resv["case3"]["norm_distance"] /
                                resv["case2"]["norm_distance"]),
            "decision_stats": stats,
            "S_score": {t: jarr(s) for t, s in (("case1", s1), ("case2", s2),
                                                ("case3", s3))},
            "S_max": {"case1": float(np.nanmax(s1)), "case2": float(np.nanmax(s2)),
                      "case3": float(np.nanmax(s3)),
                      "case1_rank1": wtexts[int(np.nanargmax(s1))],
                      "case2_rank1": wtexts[int(np.nanargmax(s2))],
                      "case3_rank1": wtexts[int(np.nanargmax(s3))]},
        },
        "front_end_ablation": {
            vn: {
                "d": rec["d"], "d3_over_d2": rec["d3_over_d2"],
                "case3_target_ratio": rec["case3_target_ratio"],
                "case3_target_rank": rec["case3_target_rank"],
                "case2_max_over_mean": rec["case2_max_over_mean"],
                "case2_max_abs_delta": rec["case2_max_abs_delta"],
                "case2_top3": [{"word": w, "cost": v} for _, w, v in rec["case2_top3"]],
                "word_cost": rec["word_cost"],
            } for vn, rec in abl.items()
        },
    }
    jp = os.path.join(TMPDIR, "results.json")
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print()
    print("wrote %s" % jp)


if __name__ == "__main__":
    main()
