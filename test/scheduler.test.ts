import assert from "node:assert/strict";
import { test } from "vitest";

import { buildDeck } from "../src/learn/deck";
import {
  BOX_MAX,
  CardStat,
  DeckProgress,
  INITIAL_SESSION,
  Session,
  advanceSession,
  applyResult,
  getStat,
  initialDeckProgress,
  isUnlockReady,
  noteMiss,
  pickNext,
  unlockNext,
} from "../src/learn/scheduler";
import { mulberry32 } from "./helpers/signal";

/** 指定した箱を持つ進捗を作るテスト補助（seen/correct は box と同じにしておく）。 */
function progressWithBoxes(
  unlockedCount: number,
  boxes: Record<string, number>
): DeckProgress {
  const cards: Record<string, CardStat> = {};
  for (const [char, box] of Object.entries(boxes)) {
    cards[char] = { box, seen: box, correct: box };
  }
  return { unlockedCount, cards };
}

// -------------------- applyResult（箱遷移） --------------------

test("applyResult: 正答で box+1（BOX_MAX でクランプ）", () => {
  const deck = buildDeck("international");
  let p: DeckProgress = initialDeckProgress(deck);
  const ch = deck[0].char;
  const seq = [1, 2, 3, 4, 4, 4]; // 正答を重ねても BOX_MAX=4 で頭打ち
  for (let i = 0; i < seq.length; i++) {
    p = applyResult(p, ch, true);
    assert.equal(getStat(p, ch).box, seq[i]);
    assert.equal(getStat(p, ch).seen, i + 1);
    assert.equal(getStat(p, ch).correct, i + 1);
  }
});

test("applyResult: 誤答で box→0・seen は増え correct は据え置き", () => {
  const deck = buildDeck("international");
  const ch = deck[0].char;
  let p = applyResult(applyResult(initialDeckProgress(deck), ch, true), ch, true);
  assert.equal(getStat(p, ch).box, 2);
  p = applyResult(p, ch, false);
  assert.deepEqual(getStat(p, ch), { box: 0, seen: 3, correct: 2 });
});

test("applyResult: 不変更新（入力を破壊しない）", () => {
  const deck = buildDeck("international");
  const p0 = initialDeckProgress(deck);
  const p1 = applyResult(p0, deck[0].char, true);
  assert.deepEqual(p0.cards, {}); // 元は空のまま
  assert.notEqual(p0, p1);
});

// -------------------- pickNext（決定性・低箱優先・直前札回避） --------------------

test("pickNext: 同一 rng 系列なら決定的（同一出力列）", () => {
  const deck = buildDeck("international");
  const progress = initialDeckProgress(deck);
  const run = (seed: number): string[] => {
    const rng = mulberry32(seed);
    let s: Session = INITIAL_SESSION;
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const ch = pickNext(deck, progress, s, rng);
      out.push(ch);
      s = advanceSession(s, ch);
    }
    return out;
  };
  assert.deepEqual(run(123), run(123));
});

test("pickNext: 低箱優先の重み付き抽選（box0 は box4 より高頻度）", () => {
  const deck = buildDeck("international");
  const [a, b] = [deck[0].char, deck[1].char];
  // A=box0（weight 16）, B=box4（weight 1）。lastChar=null なので回避は無し。
  const progress = progressWithBoxes(2, { [a]: 0, [b]: BOX_MAX });
  const rng = mulberry32(2026);
  let countA = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (pickNext(deck, progress, INITIAL_SESSION, rng) === a) countA++;
  }
  // 理論比 16:1 → A は約 94%。統計揺らぎを見て 85% 超を要求する。
  assert.ok(countA > N * 0.85, `countA=${countA}/${N}`);
});

test("pickNext: 直前札は避ける（代替が存在する場合）", () => {
  const deck = buildDeck("international");
  const progress = initialDeckProgress(deck); // 5 枚解放・全 box0
  const last = deck[0].char;
  const session: Session = { lastChar: last, missQueue: [] };
  const rng = mulberry32(55);
  for (let i = 0; i < 500; i++) {
    assert.notEqual(pickNext(deck, progress, session, rng), last);
  }
});

test("pickNext: 解放済み 1 枚なら直前札でも選ぶ（代替が無い）", () => {
  const deck = buildDeck("international");
  const only = deck[0].char;
  const p: DeckProgress = { unlockedCount: 1, cards: {} };
  const s: Session = { lastChar: only, missQueue: [] };
  assert.equal(pickNext(deck, p, s, mulberry32(1)), only);
});

// -------------------- ミスキュー（誤答再出題の保証） --------------------

test("ミスキュー: 誤答札は他 2 問の後に強制再出題される", () => {
  const deck = buildDeck("international");
  const progress = initialDeckProgress(deck); // 解放 5 枚
  const [missed, other1, other2] = [deck[0].char, deck[1].char, deck[2].char];

  // 出題→誤答: advanceSession の後に noteMiss（この順序が仕様）。
  let s = advanceSession(INITIAL_SESSION, missed);
  s = noteMiss(s, missed); // missQueue [{missed, dueIn:2}]
  // 他の 2 問を出す（dueIn 2→1→0）。
  s = advanceSession(s, other1);
  s = advanceSession(s, other2);
  // どの rng でも missed が強制再出題される。
  for (const seed of [1, 2, 3, 100, 9999]) {
    assert.equal(pickNext(deck, progress, s, mulberry32(seed)), missed);
  }
});

test("ミスキュー: 期限前は強制せず、直前札なら回避される（dueIn=0 で初めて強制）", () => {
  const deck = buildDeck("international");
  const progress = initialDeckProgress(deck);
  const target = deck[0].char;

  // dueIn=1（未期限）かつ直前札 = target → 回避されるので target は出ない。
  const notYet: Session = { lastChar: target, missQueue: [{ char: target, dueIn: 1 }] };
  for (const seed of [1, 2, 3, 42, 777]) {
    assert.notEqual(pickNext(deck, progress, notYet, mulberry32(seed)), target);
  }
  // dueIn=0（期限到来）は直前札回避を上書きして強制再出題する。
  const due: Session = { lastChar: target, missQueue: [{ char: target, dueIn: 0 }] };
  for (const seed of [1, 2, 3, 42, 777]) {
    assert.equal(pickNext(deck, progress, due, mulberry32(seed)), target);
  }
});

test("ミスキュー: 解放済み<3 の縮退でも可能な範囲で早く再出題される", () => {
  const deck = buildDeck("international");
  const progress: DeckProgress = { unlockedCount: 2, cards: {} }; // 解放 2 枚
  const [a, b] = [deck[0].char, deck[1].char];

  let s = advanceSession(INITIAL_SESSION, a);
  s = noteMiss(s, a); // [{a, dueIn:2}], lastChar a
  // 直前 a を避けると残りは b の 1 枚だけ。
  assert.equal(pickNext(deck, progress, s, mulberry32(1)), b);
  s = advanceSession(s, b); // [{a, dueIn:1}], lastChar b
  // 直前 b を避けると a しか無く、期限前でも自然に a が再出題される（早める）。
  assert.equal(pickNext(deck, progress, s, mulberry32(1)), a);
});

test("advanceSession: 出題した札は保留を満たしキューから除かれる", () => {
  const deck = buildDeck("international");
  const [x, y] = [deck[0].char, deck[1].char];
  let s = noteMiss(advanceSession(INITIAL_SESSION, x), x); // [{x,2}]
  s = noteMiss(s, y); // [{x,2},{y,2}]
  s = advanceSession(s, x); // x を出題 → x 除外、y は dueIn 2→1
  assert.deepEqual(s.missQueue, [{ char: y, dueIn: 1 }]);
  assert.equal(s.lastChar, x);
});

// -------------------- 解放ゲート --------------------

test("解放: 全 box≥2 で次を解放し新カードは box0 で入る", () => {
  const deck = buildDeck("international");
  let p = initialDeckProgress(deck); // 解放 5
  assert.equal(isUnlockReady(deck, p), false); // 全 box0 → 未達

  // 解放済み 5 枚をすべて box2 へ。
  for (const c of deck.slice(0, 5)) {
    p = applyResult(applyResult(p, c.char, true), c.char, true);
  }
  assert.equal(isUnlockReady(deck, p), true);
  const p2 = unlockNext(deck, p);
  assert.equal(p2.unlockedCount, 6);
  assert.equal(getStat(p2, deck[5].char).box, 0); // 新カードは box0
});

test("解放: 1 枚でも box<2 なら不変", () => {
  const deck = buildDeck("international");
  let p = initialDeckProgress(deck);
  for (const c of deck.slice(0, 5)) {
    p = applyResult(applyResult(p, c.char, true), c.char, true);
  }
  // 1 枚を誤答で box0 に落とす。
  p = applyResult(p, deck[2].char, false);
  assert.equal(isUnlockReady(deck, p), false);
  assert.equal(unlockNext(deck, p), p); // 不変（同一参照を返す）
});

test("解放: 上限（全解放済み）では increment しない", () => {
  const deck = buildDeck("international");
  const boxes: Record<string, number> = {};
  for (const c of deck) boxes[c.char] = BOX_MAX;
  const p = progressWithBoxes(deck.length, boxes);
  assert.equal(isUnlockReady(deck, p), false);
  assert.equal(unlockNext(deck, p).unlockedCount, deck.length);
});
