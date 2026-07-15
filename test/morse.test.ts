import assert from "node:assert/strict";
import { test } from "vitest";

import { decode } from "../src/morse/decode";
import { encode } from "../src/morse/encode";
import { roundTrip, toDisplay } from "../src/morse/index";

test("欧文: SOS", () => {
  assert.equal(encode("SOS", "international").morse, "... --- ...");
});

test("欧文: 語区切り", () => {
  assert.equal(encode("HI OK", "international").morse, ".... .. / --- -.-");
});

test("欧文: 往復", () => {
  assert.equal(roundTrip("HELLO WORLD", "international"), "HELLO WORLD");
  assert.equal(roundTrip("CQ DE JA1ABC", "international"), "CQ DE JA1ABC");
});

test("和文: イロハ", () => {
  assert.equal(encode("イロハ", "wabun").morse, ".- .-.- -...");
});

test("和文: 濁点合成（ガ = カ + ゛）", () => {
  const m = encode("ガ", "wabun").morse;
  assert.equal(m, ".-.. .."); // カ + 濁点
  assert.equal(decode(m, "wabun"), "ガ");
});

test("和文: 半濁点合成（パ = ハ + ゜）", () => {
  assert.equal(roundTrip("パ", "wabun"), "パ");
});

test("和文: ひらがな入力もカタカナへ", () => {
  assert.equal(roundTrip("こんにちは", "wabun"), "コンニチハ");
});

test("和文: 長音", () => {
  assert.equal(roundTrip("ラーメン", "wabun"), "ラーメン");
});

test("和文: 濁音まじりの往復", () => {
  assert.equal(roundTrip("ガンバレ", "wabun"), "ガンバレ");
});

test("表示整形 ・－", () => {
  assert.equal(toDisplay("... ---"), "・・・ －－－");
});

test("未知の符号は � になる", () => {
  assert.equal(decode("........", "international").includes("�"), true);
});
