// テスト用の信号合成ヘルパー。
//
// 録音 fixture を置かずに「PCM 合成 → 実 FFT → 検出 → 分類 → 復号」の結合を
// 決定論的に試験するためのもの（2026-07-15 codex レビューの出荷条件
// 「合成 dB 配列だけでは bin ずれ・窓漏れを拘束できない」への対応）。
// 乱数はすべてシード付き PRNG — テストは常に再現可能でなければならない。

/** mulberry32: シード付き 32bit PRNG。テストの決定論性のため Math.random は使わない。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * モールス文字列（"." "-" " " "/"）をキーイングした PCM を合成する。
 * タイミングは player.ts と同じ規則（短点1u+間1u、長点3u+間1u、' '=+2u、'/'=+4u）。
 */
export function synthesizeMorseAudio(
  morse: string,
  opts: {
    wpm: number;
    freq: number;
    sampleRate: number;
    /** 白色雑音の振幅（トーン振幅は 0.5 固定）。既定 0。 */
    noiseAmp?: number;
    seed?: number;
    /** 先頭の無音（秒）。検出器のノイズ床学習に使う。既定 0.5。 */
    leadSec?: number;
    /** 末尾の無音（秒）。既定 0.25（20WPM の語間 5u=300ms 未満に抑え、末尾に偽の語区切りを作らない）。 */
    tailSec?: number;
  }
): Float32Array {
  const unit = 1.2 / opts.wpm;
  const sr = opts.sampleRate;
  const lead = opts.leadSec ?? 0.5;
  const tail = opts.tailSec ?? 0.25;

  // (on, 継続時間) のスケジュールを組み立ててから一括でサンプル化する。
  const sched: Array<{ on: boolean; dur: number }> = [{ on: false, dur: lead }];
  for (const c of morse) {
    if (c === ".") sched.push({ on: true, dur: unit }, { on: false, dur: unit });
    else if (c === "-")
      sched.push({ on: true, dur: 3 * unit }, { on: false, dur: unit });
    else if (c === " ") sched.push({ on: false, dur: 2 * unit });
    else if (c === "/") sched.push({ on: false, dur: 4 * unit });
  }
  sched.push({ on: false, dur: tail });

  const total = Math.ceil(sched.reduce((a, s) => a + s.dur, 0) * sr);
  const out = new Float32Array(total);
  const rand = mulberry32(opts.seed ?? 1);
  const noise = opts.noiseAmp ?? 0;

  let i = 0;
  for (const s of sched) {
    const n = Math.round(s.dur * sr);
    for (let k = 0; k < n && i < total; k++, i++) {
      const t = i / sr;
      let v = noise ? (rand() * 2 - 1) * noise : 0;
      if (s.on) v += 0.5 * Math.sin(2 * Math.PI * opts.freq * t);
      out[i] = v;
    }
  }
  return out;
}

/** Blackman 窓（Web Audio 仕様の AnalyserNode と同じ係数: a=0.16）。 */
function blackman(n: number, N: number): number {
  const x = (2 * Math.PI * n) / N;
  return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
}

/** radix-2 FFT（in-place・反復版）。テスト専用なので速度より簡潔さ優先。 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // ビット反転並べ替え
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

/**
 * PCM から AnalyserNode 相当の dB スペクトラムフレーム列を生成する。
 * フレーム間隔は rAF 相当の 1/60 秒（≈16.7ms）。time は音声クロック基準。
 */
export function framesFromAudio(
  samples: Float32Array,
  opts: { sampleRate: number; fftSize?: number; frameIntervalSec?: number }
): Array<{ spectrumDb: Float32Array; time: number }> {
  const fftSize = opts.fftSize ?? 2048;
  const hop = Math.round((opts.frameIntervalSec ?? 1 / 60) * opts.sampleRate);
  const frames: Array<{ spectrumDb: Float32Array; time: number }> = [];

  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * blackman(i, fftSize);
    }
    fft(re, im);
    const spec = new Float32Array(fftSize / 2);
    for (let i = 0; i < spec.length; i++) {
      const mag = Math.hypot(re[i], im[i]) / fftSize;
      spec[i] = 20 * Math.log10(mag + 1e-12);
    }
    // time はフレーム末尾（AnalyserNode が「直近 fftSize サンプル」を見るのと同じ向き）
    frames.push({ spectrumDb: spec, time: (start + fftSize) / opts.sampleRate });
  }
  return frames;
}
