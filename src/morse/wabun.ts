// 和文モールス符号（Wabun code）表。
// 内部表現はドット "." とダッシュ "-"。表示時に ・／－ へ変換する。
//
// 出典で検証済み（五十音・濁点・半濁点・長音・読点・句点）。
// 濁音・半濁音は「清音 + 濁点/半濁点」で表す（例: ガ = カ + ゛）。

/** カナ 1 文字 → 符号。清音・拗音の基本 46 音＋ヰヱヲン。 */
export const WABUN: Record<string, string> = {
  ア: "--.--",
  イ: ".-",
  ウ: "..-",
  エ: "-.---",
  オ: ".-...",
  カ: ".-..",
  キ: "-.-..",
  ク: "...-",
  ケ: "-.--",
  コ: "----",
  サ: "-.-.-",
  シ: "--.-.",
  ス: "---.-",
  セ: ".---.",
  ソ: "---.",
  タ: "-.",
  チ: "..-.",
  ツ: ".--.",
  テ: ".-.--",
  ト: "..-..",
  ナ: ".-.",
  ニ: "-.-.",
  ヌ: "....",
  ネ: "--.-",
  ノ: "..--",
  ハ: "-...",
  ヒ: "--..-",
  フ: "--..",
  ヘ: ".",
  ホ: "-..",
  マ: "-..-",
  ミ: "..-.-",
  ム: "-",
  メ: "-...-",
  モ: "-..-.",
  ヤ: ".--",
  ユ: "-..--",
  ヨ: "--",
  ラ: "...",
  リ: "--.",
  ル: "-.--.",
  レ: "---",
  ロ: ".-.-",
  ワ: "-.-",
  ヰ: ".-..-",
  ヱ: ".--..",
  ヲ: ".---",
  ン: ".-.-.",
};

/** 記号・修飾符号。 */
export const WABUN_SYMBOLS: Record<string, string> = {
  "゛": "..", // 濁点（だくてん）
  "゜": "..--.", // 半濁点（はんだくてん）
  "ー": ".--.-", // 長音
  "、": ".-.-.-", // 読点
  "。": ".-.-..", // 句点
};

/** 濁点を付けたときに元となる清音（ガ→カ など）。 */
const DAKUTEN_MAP: Record<string, string> = {
  ガ: "カ", ギ: "キ", グ: "ク", ゲ: "ケ", ゴ: "コ",
  ザ: "サ", ジ: "シ", ズ: "ス", ゼ: "セ", ゾ: "ソ",
  ダ: "タ", ヂ: "チ", ヅ: "ツ", デ: "テ", ド: "ト",
  バ: "ハ", ビ: "ヒ", ブ: "フ", ベ: "ヘ", ボ: "ホ",
  ヴ: "ウ",
};

/** 半濁点を付けたときに元となる清音（パ→ハ など）。 */
const HANDAKUTEN_MAP: Record<string, string> = {
  パ: "ハ", ピ: "ヒ", プ: "フ", ペ: "ヘ", ポ: "ホ",
};

/** 小書きカナ（ァィゥ…ッャュョ）を通常サイズへ寄せる。和文モールスに小書きは無い。 */
const SMALL_KANA_MAP: Record<string, string> = {
  ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ",
  ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ヮ: "ワ",
};

/**
 * 入力カナ 1 文字を、和文モールスで送るための「基本カナ列 + 付加符号」に正規化する。
 * 例: "ガ" → ["カ", "゛"], "パ" → ["ハ", "゜"], "ァ" → ["ア"]。
 * 対応表に無ければ空配列。
 */
export function decomposeKana(ch: string): string[] {
  if (WABUN[ch]) return [ch];
  if (WABUN_SYMBOLS[ch]) return [ch];
  if (DAKUTEN_MAP[ch]) return [DAKUTEN_MAP[ch], "゛"];
  if (HANDAKUTEN_MAP[ch]) return [HANDAKUTEN_MAP[ch], "゜"];
  if (SMALL_KANA_MAP[ch]) return [SMALL_KANA_MAP[ch]];
  return [];
}

/** 逆引き: 符号 → カナ（清音・記号のみ。濁点等は復号側で合成）。 */
export const WABUN_REVERSE: Record<string, string> = (() => {
  const r: Record<string, string> = {};
  for (const [k, code] of Object.entries(WABUN)) r[code] = k;
  for (const [k, code] of Object.entries(WABUN_SYMBOLS)) r[code] = k;
  return r;
})();

/** 復号時の合成用: 清音 + 濁点 → 濁音（カ+゛→ガ）。 */
export const COMPOSE_DAKUTEN: Record<string, string> = Object.fromEntries(
  Object.entries(DAKUTEN_MAP).map(([voiced, plain]) => [plain, voiced])
);

/** 復号時の合成用: 清音 + 半濁点 → 半濁音（ハ+゜→パ）。 */
export const COMPOSE_HANDAKUTEN: Record<string, string> = Object.fromEntries(
  Object.entries(HANDAKUTEN_MAP).map(([p, plain]) => [plain, p])
);

/** ひらがな→カタカナ（入力の許容範囲を広げる）。 */
export function toKatakana(input: string): string {
  return input.replace(/[ぁ-ゖ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) + 0x60)
  );
}
