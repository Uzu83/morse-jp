import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

import { runTimeline } from "../src/audio/player";
import { buildTimeline } from "../src/morse/timeline";

// ランナーは「クロック注入 + setTimeout」だけの純粋な作りなので、
// fake timers と手動クロックで決定論的に試験できる。
// クロック（= 本番では AudioContext.currentTime）とタイマーは別物であることに注意:
// advance() は両方を一緒に進め、クロックだけ止めれば suspend を模せる。

let now = 0;
const clock = () => now;

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function advance(sec: number) {
  now += sec;
  vi.advanceTimersByTime(sec * 1000);
}

interface Ev {
  t: number;
  on: boolean;
  remMs: number;
}

function record(events: Ev[]) {
  return (on: boolean, remainingMs: number) =>
    events.push({ t: Number(now.toFixed(4)), on, remMs: Math.round(remainingMs) });
}

const UNIT = 0.06; // 20WPM

test("runner: 正常系 — 遷移が境界どおりに発火し、開始前は発火しない", async () => {
  const events: Ev[] = [];
  const done = runTimeline({
    timeline: buildTimeline(".-"), // on1 off1 on3 → 計 5u = 0.3s
    unitSec: UNIT,
    t0: 0.1,
    clock,
    onChange: record(events),
  });
  advance(0.05); // まだ t0 前
  assert.equal(events.length, 0);
  advance(0.05); // t0 ちょうど
  advance(0.06);
  advance(0.06);
  advance(0.18); // 最後の長点終了
  await done;
  assert.deepEqual(events, [
    { t: 0.1, on: true, remMs: 60 },
    { t: 0.16, on: false, remMs: 60 },
    { t: 0.22, on: true, remMs: 180 },
    { t: 0.4, on: false, remMs: 0 }, // 自然完了時は必ず off
  ]);
});

test("runner: 遅延 wake は失われた遷移を再生せず現在状態へスキップする", async () => {
  const events: Ev[] = [];
  const done = runTimeline({
    timeline: buildTimeline(".-"),
    unitSec: UNIT,
    t0: 0.1,
    clock,
    onChange: record(events),
  });
  advance(0.1); // 最初の短点 ON
  // タブ非表示相当: クロックとタイマーが一気に 130ms 進む（off と on の境界を跨ぐ）
  advance(0.13); // pos = 0.13 → 3 番目のセグメント（長点、0.12〜0.30）の途中
  // 中間の off は再生されない。ON→ON でも新セグメントなので残り時間で再発火する
  assert.deepEqual(events, [
    { t: 0.1, on: true, remMs: 60 },
    { t: 0.23, on: true, remMs: 170 },
  ]);
  advance(0.17);
  await done;
  assert.equal(events[events.length - 1].on, false);
});

test("runner: abort で即座に off を報告して終わる", async () => {
  const events: Ev[] = [];
  const ctl = new AbortController();
  const done = runTimeline({
    timeline: buildTimeline("---"),
    unitSec: UNIT,
    t0: 0,
    clock,
    signal: ctl.signal,
    onChange: record(events),
  });
  advance(0.01); // 長点 ON 中
  ctl.abort();
  await done;
  assert.equal(events.length, 2);
  assert.equal(events[1].on, false);
  const count = events.length;
  advance(1); // 以後は何も起きない
  assert.equal(events.length, count);
});

test("runner: 停止から同一 ON セグメント内へ再開したら残り時間で再発火する", async () => {
  // wall 時間指定の振動は suspend 中に自然停止しているため、再開後の残り区間を
  // 振動させ直す必要がある（ゲート2レビューで固定した仕様）。
  const events: Ev[] = [];
  const done = runTimeline({
    timeline: buildTimeline("-"), // on3 = 0.18s
    unitSec: UNIT,
    t0: 0,
    clock,
    onChange: record(events),
  });
  advance(0.03); // ON の途中まで進む（wake は無いが clock は進んでいる）
  // クロック停止のままタイマーだけ進む → stall 検出（発火なし）
  vi.advanceTimersByTime(500);
  await Promise.resolve();
  assert.equal(events.length, 1);
  // クロック再開: 同一 ON セグメント内でも残り時間つきで再発火する
  now += 0.02; // pos = 0.05 → 残り 130ms
  vi.advanceTimersByTime(100); // 保留中の wake が発火するまで wall を進める
  assert.deepEqual(events[events.length - 1], { t: 0.05, on: true, remMs: 130 });
  advance(0.2);
  await done;
  assert.equal(events[events.length - 1].on, false);
});

test("runner: クロック停止（suspend 相当）中は状態が進まず、再開後に完走する", async () => {
  const events: Ev[] = [];
  let settled = false;
  const done = runTimeline({
    timeline: buildTimeline(".."),
    unitSec: UNIT,
    t0: 0,
    clock,
    onChange: record(events),
  }).then(() => {
    settled = true;
  });
  advance(0.001);
  assert.equal(events.length, 1); // 最初の ON
  // クロックだけ止めてタイマーを進める（AudioContext suspend 相当）
  vi.advanceTimersByTime(1000);
  await Promise.resolve();
  assert.equal(events.length, 1, "停止中に遷移が発火してはいけない");
  assert.equal(settled, false);
  // 再開
  advance(0.2); // 総時間 3u+off1? ".." = on1 off1 on1 = 0.18s → 完走
  await done;
  assert.equal(settled, true);
  assert.equal(events[events.length - 1].on, false);
});
