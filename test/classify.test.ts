import assert from "node:assert/strict";
import { test } from "vitest";

import { PulseClassifier } from "../src/audio/classify";
import { buildTimeline } from "../src/morse/timeline";
import { mulberry32 } from "./helpers/signal";

// 60fps の rAF でサンプリングした現実的なタイムスタンプを模す:
// 遷移時刻はフレーム格子（16.7ms）に量子化され、±jitter の揺れを持つ。
// 「5ms のスパイク」のような格子未満の事象はそもそも観測されない
// （2026-07-15 codex レビュー指摘 — テストは観測可能な入力で書く）。
const FRAME = 1 / 60;

interface TimelineOpts {
  unit: number;
  start?: number;
  /** フレーム格子に量子化するか。境界値テストでは無効にして正確な時刻を使う。 */
  quantize?: boolean;
  jitterSec?: number;
  seed?: number;
}

/**
 * モールス文字列から ON/OFF 遷移列を作って classifier へ流す。
 * タイミング規則は送出側の唯一の定義 src/morse/timeline.ts を消費する。
 * 最後のトーンの終了時刻を返す（末尾に無音は付かない — timeline の仕様）。
 */
function pushMorse(
  cls: PulseClassifier,
  morse: string,
  opts: TimelineOpts
): number {
  const rand = mulberry32(opts.seed ?? 1);
  const q = (t: number) => {
    if (!opts.quantize) return t;
    const j = opts.jitterSec ? (rand() * 2 - 1) * opts.jitterSec : 0;
    return Math.round(t / FRAME) * FRAME + j;
  };
  let t = opts.start ?? 0;
  for (const seg of buildTimeline(morse)) {
    cls.push(seg.on, q(t));
    t += seg.units * opts.unit;
  }
  cls.push(false, q(t)); // 最後のトーンを閉じる
  return t;
}

const UNIT_20WPM = 1.2 / 20; // 60ms

test("分類: 20WPM の SOS（フレーム量子化 + ジッター入り）", () => {
  const cls = new PulseClassifier();
  const end = pushMorse(cls, "... --- ...", {
    unit: UNIT_20WPM,
    quantize: true,
    jitterSec: 0.003,
  });
  const r = cls.read(end + UNIT_20WPM);
  assert.equal(r.morse, "... --- ...");
  assert.ok(r.unit !== null, "両クラスタ確定後は unit を返す");
  assert.equal(Math.round(1.2 / r.unit!), 20);
});

test("分類: 語間 " + "（/ が保存される）", () => {
  const cls = new PulseClassifier();
  const end = pushMorse(cls, ".... .. / --- -.-", {
    unit: UNIT_20WPM,
    quantize: true,
  });
  assert.equal(cls.read(end).morse, ".... .. / --- -.-");
});

test("分類: 先頭の無音は区切りとして出力されない", () => {
  const cls = new PulseClassifier();
  cls.push(false, 0); // マイク開始
  pushMorse(cls, "...", { unit: UNIT_20WPM, start: 3.0 }); // 3 秒後に送信開始
  const r = cls.read(3.5);
  assert.equal(r.morse, "..."); // 先頭に " / " や " " が付かない
});

test("分類: 間の境界値 — ちょうど 2×unit は文字間、ちょうど 5×unit は語間", () => {
  const u = UNIT_20WPM;
  // 手組みの遷移列（量子化なしの正確な時刻）: unit はこの列から 1u/3u として推定される
  const cls = new PulseClassifier();
  let t = 0;
  const pulse = (dur: number, gap: number) => {
    cls.push(true, t);
    t += dur;
    cls.push(false, t);
    t += gap;
  };
  pulse(u, u); // .
  pulse(3 * u, 2 * u); // - のあと ちょうど 2u
  pulse(u, 5 * u); // . のあと ちょうど 5u
  pulse(3 * u, u); // -
  assert.equal(cls.read(t).morse, ".- . / -");
});

test("分類: 符号の境界値 — ちょうど 2×unit の ON は長点", () => {
  const u = UNIT_20WPM;
  const cls = new PulseClassifier();
  let t = 0;
  const pulse = (dur: number, gap: number) => {
    cls.push(true, t);
    t += dur;
    cls.push(false, t);
    t += gap;
  };
  // 短点・長点でクラスタを確立してから、ちょうど 2u のパルスを送る
  for (let i = 0; i < 3; i++) pulse(u, u);
  for (let i = 0; i < 3; i++) pulse(3 * u, u);
  pulse(2 * u, u);
  const morse = cls.read(t).morse;
  assert.equal(morse[morse.length - 1], "-");
});

test("分類: 長点しか無い間は暫定分類し、短点の出現で遡及訂正される", () => {
  const cls = new PulseClassifier();
  // "---"（オー）だけ: 単一クラスタ。OFF 長（1u）が「全部長点」モデルを支持する
  const end1 = pushMorse(cls, "---", { unit: UNIT_20WPM });
  const r1 = cls.read(end1);
  assert.equal(r1.morse, "---");
  assert.equal(r1.unit, null, "単一クラスタの間は unit=null（測定中）");
  // 文字間を空けて "..." が続くと両クラスタが確定し、全履歴が正しく再分類される
  const end2 = pushMorse(cls, "...", {
    unit: UNIT_20WPM,
    start: end1 + 3 * UNIT_20WPM, // 文字間 3u（end1 は最後のトーン終了時刻）
  });
  const r2 = cls.read(end2);
  assert.equal(r2.morse, "--- ...");
  assert.ok(r2.unit !== null);
});

test("分類: 単発の短点（E）も暫定表示される", () => {
  const cls = new PulseClassifier();
  const u = UNIT_20WPM;
  cls.push(true, 0);
  cls.push(false, u);
  const r = cls.read(1.0);
  assert.equal(r.morse.startsWith("."), true);
  assert.equal(r.unit, null);
});

test("分類: 1 フレーム相当のスパイク・瞬断は併合される", () => {
  const u = UNIT_20WPM; // 60ms → グリッチ閾値 0.35u = 21ms > 16.7ms
  const cls = new PulseClassifier();
  let t = 0;
  const seg = (on: boolean, dur: number) => {
    cls.push(on, t);
    t += dur;
  };
  // ".-" を送るが、長点の途中に 16.7ms の瞬断、文字間の途中に 16.7ms のスパイクを入れる
  seg(true, u); // .
  seg(false, u);
  seg(true, 1.5 * u); // - 前半
  seg(false, FRAME); // 瞬断（検出揺れ）
  seg(true, 1.5 * u - FRAME); // - 後半
  seg(false, 1.5 * u);
  seg(true, FRAME); // スパイク（環境ノイズ）
  seg(false, 1.5 * u - FRAME);
  seg(true, u); // 次の文字 "."
  seg(false, u);
  assert.equal(cls.read(t).morse, ".- .");
});

test("分類: flush は進行中の長点を確定する", () => {
  const u = UNIT_20WPM;
  const cls = new PulseClassifier();
  const end = pushMorse(cls, "..", { unit: u });
  cls.push(true, end + u); // 符号内間 1u ののち、3 つ目の符号（長点）を送信中のまま停止
  const r = cls.flush(end + 4 * u);
  assert.equal(r.morse, "..-");
});

test("分類: read は進行中の ON を含めない（送信中に符号が揺れない）", () => {
  const u = UNIT_20WPM;
  const cls = new PulseClassifier();
  const end = pushMorse(cls, "..", { unit: u });
  cls.push(true, end + u);
  // 長点送信中（1.5u 経過時点）に read しても、進行中の符号は現れない
  assert.equal(cls.read(end + 2.5 * u).morse, "..");
});

test("分類: 無音の継続で文字間 → 語間へ遡及更新される（仮想末尾 OFF）", () => {
  const u = UNIT_20WPM;
  const cls = new PulseClassifier();
  const end = pushMorse(cls, "... ---", { unit: u });
  // 最後の OFF 遷移は end 時点（最後のトーン終了）。文字間相当の無音 → まだ語区切りは出ない
  assert.equal(cls.read(end + 2 * u).morse.endsWith("/"), false);
  // 語間相当まで無音が伸びると " / " が現れる（次の語を待っている表示）
  assert.equal(cls.read(end + 6 * u).morse.endsWith("/"), true);
});

test("分類: 25WPM（短め unit）でもフレーム量子化に耐える", () => {
  const cls = new PulseClassifier();
  const unit = 1.2 / 25; // 48ms ≈ 2.9 フレーム
  const end = pushMorse(cls, "-.-. --.-", { unit, quantize: true });
  assert.equal(cls.read(end).morse, "-.-. --.-");
});

test("分類: 5WPM（遅い送信）も分類できる", () => {
  const cls = new PulseClassifier();
  const unit = 1.2 / 5; // 240ms
  const end = pushMorse(cls, "... --- / .-", { unit, quantize: true });
  const r = cls.read(end);
  assert.equal(r.morse, "... --- / .-");
  assert.equal(Math.round(1.2 / r.unit!), 5);
});

test("分類: 検出バイアス（ON −20ms / OFF +20ms）を補正して復号する", () => {
  // 検出エッジの非対称で ON は縮み OFF は同量伸びる（時間の合計は保存）。
  // 補正が無いと 20WPM ですら符号内間 (60+20=80ms) が unit=40ms 基準の
  // 文字間境界 (80ms) に達し、全文字がバラバラになる — 統合テストで実際に踏んだ形。
  const u = 1.2 / 20;
  const BIAS = -0.02;
  const cls = new PulseClassifier();
  let t = 0;
  const pulse = (units: number, gapUnits: number) => {
    cls.push(true, t);
    t += units * u + BIAS;
    cls.push(false, t);
    t += gapUnits * u - BIAS;
  };
  // "-.- .-" 相当（クラスタ両方あり → バイアスが連立で解ける）
  pulse(3, 1);
  pulse(1, 1);
  pulse(3, 3); // 文字間
  pulse(1, 1);
  pulse(3, 1);
  const r = cls.read(t);
  assert.equal(r.morse, "-.- .-");
  // 解いた unit はバイアス込みの見かけ値でなく真値（60ms）に近いこと
  assert.ok(Math.abs(r.unit! - u) < 0.005, `unit=${r.unit}`);
});
