import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildDeck,
  makeChoices,
  INTERNATIONAL_KOCH_ORDER,
  WABUN_KOCH_ORDER,
} from "../src/learn/deck";
import { encode } from "../src/morse/encode";
import { INTERNATIONAL } from "../src/morse/international";
import { WABUN, WABUN_SYMBOLS } from "../src/morse/wabun";
import { mulberry32 } from "./helpers/signal";

test("deck: 欧文は Koch 順・41 文字・重複なし", () => {
  const deck = buildDeck("international");
  assert.equal(deck.length, INTERNATIONAL_KOCH_ORDER.length);
  assert.equal(deck.length, 41);
  // 先頭は古典 Koch 順（K M U R E …）。
  assert.deepEqual(
    deck.slice(0, 5).map((c) => c.char),
    ["K", "M", "U", "R", "E"]
  );
  const chars = deck.map((c) => c.char);
  assert.equal(new Set(chars).size, chars.length); // 重複なし
});

test("deck: 和文は原子（清音48＋記号5=53）の過不足ない集合", () => {
  const deck = buildDeck("wabun");
  assert.equal(deck.length, WABUN_KOCH_ORDER.length);
  assert.equal(deck.length, 53);
  const chars = deck.map((c) => c.char);
  assert.equal(new Set(chars).size, chars.length); // 重複なし
  // Koch 順定数は WABUN ∪ WABUN_SYMBOLS のちょうど並べ替えでなければならない。
  const atoms = new Set([...Object.keys(WABUN), ...Object.keys(WABUN_SYMBOLS)]);
  assert.deepEqual(new Set(chars), atoms);
  // 先頭は「いろは」順。
  assert.deepEqual(
    deck.slice(0, 3).map((c) => c.char),
    ["イ", "ロ", "ハ"]
  );
});

test("deck: 全カードの code は encode 出力と一致し skipped は空（符号手書き禁止の固定）", () => {
  for (const mode of ["international", "wabun"] as const) {
    for (const card of buildDeck(mode)) {
      const { morse, skipped } = encode(card.char, mode);
      assert.equal(card.code, morse, `${card.char} (${mode})`);
      assert.deepEqual(skipped, [], `${card.char} (${mode}) skipped`);
    }
  }
});

test("deck: Koch 順定数の全文字は符号表に存在する", () => {
  for (const ch of INTERNATIONAL_KOCH_ORDER) {
    assert.ok(INTERNATIONAL[ch] !== undefined, `欧文表に ${ch} が無い`);
  }
  for (const ch of WABUN_KOCH_ORDER) {
    assert.ok(
      WABUN[ch] !== undefined || WABUN_SYMBOLS[ch] !== undefined,
      `和文表に ${ch} が無い`
    );
  }
});

test("makeChoices: 解放済みのみ・正解含む・重複なし・n=min(4,unlocked)", () => {
  const deck = buildDeck("international");
  const unlockedCount = 5;
  const unlocked = new Set(deck.slice(0, unlockedCount).map((c) => c.char));
  const target = deck[4].char; // "E"（解放済み内）

  // 多数の rng で不変条件を確認する。
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    const choices = makeChoices(deck, unlockedCount, target, rng, 4);
    assert.equal(choices.length, 4); // min(4, 5)
    assert.ok(choices.includes(target)); // 正解を含む
    assert.equal(new Set(choices).size, choices.length); // 重複なし
    for (const c of choices) assert.ok(unlocked.has(c)); // 解放済みのみ
  }
});

test("makeChoices: 解放数が n 未満なら枚数は解放数でクランプ", () => {
  const deck = buildDeck("international");
  const target = deck[0].char; // "K"
  const rng = mulberry32(7);
  const choices = makeChoices(deck, 2, target, rng, 4); // 解放 2・要求 4
  assert.equal(choices.length, 2); // min(4, 2)
  assert.ok(choices.includes(target));
  const unlocked = new Set(deck.slice(0, 2).map((c) => c.char));
  for (const c of choices) assert.ok(unlocked.has(c));
});

test("makeChoices: 同一 rng 系列なら決定的（同一出力）", () => {
  const deck = buildDeck("international");
  const target = deck[2].char;
  const a = makeChoices(deck, 5, target, mulberry32(99), 4);
  const b = makeChoices(deck, 5, target, mulberry32(99), 4);
  assert.deepEqual(a, b);
});
