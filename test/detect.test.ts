import assert from "node:assert/strict";
import { test } from "vitest";

import { PulseClassifier } from "../src/audio/classify";
import { ToneDetector } from "../src/audio/detect";
import { decode } from "../src/morse/decode";
import { encode } from "../src/morse/encode";
import {
  framesFromAudio,
  mulberry32,
  synthesizeMorseAudio,
} from "./helpers/signal";

// AnalyserNode の既定構成に合わせる。
const SR = 48000;
const FFT = 2048;
const BIN_HZ = SR / FFT; // ≈ 23.4Hz
const FRAME = 1 / 60; // rAF 相当

/** 全 bin baseDb の平坦スペクトラムに、指定周波数のピークを立てた合成フレーム。 */
function makeSpectrum(
  peaks: Array<{ hz: number; db: number }>,
  baseDb = -100
): Float32Array {
  const spec = new Float32Array(FFT / 2).fill(baseDb);
  for (const p of peaks) {
    const bin = Math.round(p.hz / BIN_HZ);
    // 実 FFT の主ローブ幅を模して中心 ±1 bin に載せる
    for (const b of [bin - 1, bin, bin + 1]) {
      if (b >= 0 && b < spec.length) spec[b] = Math.max(spec[b], p.db);
    }
  }
  return spec;
}

function newDetector(freq = 600) {
  return new ToneDetector({ sampleRate: SR, fftSize: FFT, freq });
}

/** n フレーム連続で同じスペクトラムを流し、最後のフレーム結果を返す。 */
function feed(
  det: ToneDetector,
  spec: Float32Array,
  n: number,
  t0: number
): ReturnType<ToneDetector["update"]> {
  let last!: ReturnType<ToneDetector["update"]>;
  for (let i = 0; i < n; i++) last = det.update(spec, t0 + i * FRAME);
  return last;
}

test("検出: 無音のみでは発火しない（ready=false）", () => {
  const det = newDetector();
  const r = feed(det, makeSpectrum([]), 120, 0);
  assert.equal(r.on, false);
  assert.equal(r.ready, false);
});

test("検出: 白色雑音のみでは発火しない", () => {
  const det = newDetector();
  const rand = mulberry32(42);
  let onSeen = false;
  for (let i = 0; i < 200; i++) {
    // 全帯域が ±2dB で揺れる雑音 — 対象帯域と参照帯域の差は分離 6dB に届かない
    const spec = new Float32Array(FFT / 2);
    for (let b = 0; b < spec.length; b++) spec[b] = -80 + (rand() * 2 - 1) * 2;
    if (det.update(spec, i * FRAME).on) onSeen = true;
  }
  assert.equal(onSeen, false);
});

test("検出: 無音のあとのトーンは即座に ON（起動遅延なし）", () => {
  const det = newDetector();
  feed(det, makeSpectrum([]), 60, 0); // 1 秒の無音でノイズ床学習
  const r = det.update(makeSpectrum([{ hz: 600, db: -40 }]), 1.0);
  assert.equal(r.ready, true);
  assert.equal(r.on, true); // 最初のトーンフレームで検出（分位点方式の ~300ms 遅延が無いこと）
});

test("検出: 中心±40Hz 内のずれ（620Hz）も拾う", () => {
  const det = newDetector();
  feed(det, makeSpectrum([]), 60, 0);
  const r = det.update(makeSpectrum([{ hz: 620, db: -40 }]), 1.0);
  assert.equal(r.on, true);
});

test("検出: 参照帯域の干渉波（800Hz）では発火しない", () => {
  const det = newDetector();
  feed(det, makeSpectrum([]), 60, 0);
  const r = feed(det, makeSpectrum([{ hz: 800, db: -40 }]), 60, 1.0);
  assert.equal(r.on, false);
});

test("検出: フェードイン・アウトでヒステリシスが 1 回ずつ遷移する", () => {
  const det = newDetector();
  feed(det, makeSpectrum([]), 60, 0);
  const transitions: boolean[] = [];
  let prev = false;
  let t = 1.0;
  const levels = [
    // フェードイン → 保持 → フェードアウト（dB）
    -90, -80, -70, -60, -50, -45, -40, -40, -40, -40, -45, -50, -60, -70, -80,
    -90, -100, -100,
  ];
  for (const db of levels) {
    const r = det.update(makeSpectrum([{ hz: 600, db }]), (t += FRAME));
    if (r.on !== prev) transitions.push(r.on);
    prev = r.on;
  }
  // 立ち上がり 1 回・立ち下がり 1 回のみ（境界揺れでチャタリングしない）
  assert.deepEqual(transitions, [true, false]);
});

test("検出: 起動時からトーンが鳴っている場合は最初の無音の後に検出できる（仕様）", () => {
  const det = newDetector();
  const tone = makeSpectrum([{ hz: 600, db: -40 }]);
  // 起動直後からトーン → 床とピークが同値初期化され分離が生まれない → OFF のまま
  const during = feed(det, tone, 60, 0);
  assert.equal(during.on, false);
  // 最初の無音で床が即座に下がる
  feed(det, makeSpectrum([]), 30, 1.0);
  // 次のトーンからは通常どおり検出
  const r = det.update(tone, 1.6);
  assert.equal(r.on, true);
});

test("検出: 連続トーンは 4 秒でも保持する（床の上昇制限）", () => {
  // 保持限界は (SNR − READY_DB) / 3 秒。この合成トーンは SNR ~59dB なので
  // 理論値 ~15 秒 — 4 秒は余裕を持って ON が続くはず（回帰検知用）。
  // 弱い信号（SNR 20dB 程度）では数秒で落ちるのが仕様（detect.ts 参照）。
  const det = newDetector();
  feed(det, makeSpectrum([]), 60, 0);
  const tone = makeSpectrum([{ hz: 600, db: -40 }]);
  let t = 1.0;
  for (let i = 0; i < 240; i++) {
    // 4 秒間
    const r = det.update(tone, (t += FRAME));
    assert.equal(r.on, true, `${i} フレーム目で OFF に落ちた`);
  }
});

test("検出: 帯域を確保できない構成は生成時に throw", () => {
  assert.throws(
    () => new ToneDetector({ sampleRate: SR, fftSize: 32, freq: 600 }),
    RangeError
  );
});

// ── 統合: PCM 合成 → 実 FFT → 検出 → 分類 → 復号 ─────────────────────
// bin マップ・Blackman 窓の漏れ・検出と分類の結合を録音 fixture なしで拘束する。

function decodeAudio(morse: string, noiseAmp: number, mode: "international" | "wabun") {
  const pcm = synthesizeMorseAudio(morse, {
    wpm: 20,
    freq: 600,
    sampleRate: SR,
    noiseAmp,
    seed: 7,
  });
  const det = newDetector();
  const cls = new PulseClassifier();
  let last = 0;
  for (const f of framesFromAudio(pcm, { sampleRate: SR })) {
    cls.push(det.update(f.spectrumDb, f.time).on, f.time);
    last = f.time;
  }
  return decode(cls.flush(last).morse, mode);
}

test("統合: 600Hz/20WPM の SOS を復号できる", () => {
  assert.equal(decodeAudio(encode("SOS", "international").morse, 0, "international"), "SOS");
});

test("統合: 白色雑音を重畳しても復号できる", () => {
  assert.equal(
    decodeAudio(encode("SOS", "international").morse, 0.05, "international"),
    "SOS"
  );
});

test("統合: 和文（濁点合成を含む）を復号できる", () => {
  assert.equal(
    decodeAudio(encode("ガンバレ", "wabun").morse, 0, "wabun"),
    "ガンバレ"
  );
});
