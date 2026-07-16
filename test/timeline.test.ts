import assert from "node:assert/strict";
import { test } from "vitest";

import { buildTimeline, timelineUnits } from "../src/morse/timeline";

/** 期待値を [onなら+units, offなら-units] の数列で書けるようにする補助。 */
function pattern(timeline: ReturnType<typeof buildTimeline>): number[] {
  return timeline.map((s) => (s.on ? s.units : -s.units));
}

test("timeline: SOS の全系列（短点1・長点3・符号内間1・文字間3）", () => {
  assert.deepEqual(
    pattern(buildTimeline("... --- ...")),
    [1, -1, 1, -1, 1, -3, 3, -1, 3, -1, 3, -3, 1, -1, 1, -1, 1]
  );
});

test("timeline: 正規形の語区切り ' / ' はちょうど 7 unit", () => {
  // 「置換」方式だと '/' 後の ' ' が 7→3 に潰し、「加算」方式だと 9 になる —
  // どちらも過去に実際に踏んだ誤り（加算は旧 player のバグ）。max 方式の回帰防止。
  assert.deepEqual(pattern(buildTimeline(".- / -")), [1, -1, 3, -7, 3]);
});

test("timeline: 語区切りの変則形（空白なし・連続・重複）もすべて 7 unit", () => {
  assert.deepEqual(pattern(buildTimeline(".-/ -")), [1, -1, 3, -7, 3]);
  assert.deepEqual(pattern(buildTimeline(".- /-")), [1, -1, 3, -7, 3]);
  assert.deepEqual(pattern(buildTimeline(".-  /  / -")), [1, -1, 3, -7, 3]);
});

test("timeline: 先頭の区切り・末尾の無音は出力しない", () => {
  assert.deepEqual(pattern(buildTimeline("/ .-")), [1, -1, 3]);
  assert.deepEqual(pattern(buildTimeline(".- / ")), [1, -1, 3]);
  assert.deepEqual(pattern(buildTimeline("  ...")), [1, -1, 1, -1, 1]);
});

test("timeline: 空文字と不明文字", () => {
  assert.deepEqual(buildTimeline(""), []);
  assert.deepEqual(buildTimeline(" / "), []);
  // 不明文字は無視（保留ギャップにも影響しない）
  assert.deepEqual(pattern(buildTimeline(".x-")), [1, -1, 3]);
});

test("timeline: 総時間", () => {
  // SOS = 短点×6 + 長点×3 + 符号内間×6 + 文字間×2 = 6+9+6+6 = 27 unit
  assert.equal(timelineUnits(buildTimeline("... --- ...")), 27);
});
