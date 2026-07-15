import { INTERNATIONAL } from "./international";
import { decomposeKana, toKatakana, WABUN, WABUN_SYMBOLS } from "./wabun";

export type Mode = "international" | "wabun";

/** 文字間の区切り（半角スペース1つ）。 */
export const LETTER_GAP = " ";
/** 語間の区切り（スラッシュ）。 */
export const WORD_GAP = " / ";

/**
 * テキストをモールス符号（"." と "-" の並び）に変換する。
 * - 文字間は空白、語間は " / " で区切る。
 * - 変換できない文字は skipped 配列に集めて返す（送出からは除外）。
 */
export function encode(
  text: string,
  mode: Mode
): { morse: string; skipped: string[] } {
  return mode === "wabun" ? encodeWabun(text) : encodeInternational(text);
}

function encodeInternational(text: string): { morse: string; skipped: string[] } {
  const skipped: string[] = [];
  const words = text.trim().toUpperCase().split(/\s+/).filter(Boolean);

  const encodedWords = words.map((word) => {
    const codes: string[] = [];
    for (const ch of word) {
      const code = INTERNATIONAL[ch];
      if (code) codes.push(code);
      else skipped.push(ch);
    }
    return codes.join(LETTER_GAP);
  });

  return { morse: encodedWords.filter(Boolean).join(WORD_GAP), skipped };
}

function encodeWabun(text: string): { morse: string; skipped: string[] } {
  const skipped: string[] = [];
  const words = toKatakana(text).trim().split(/[\s　]+/).filter(Boolean);

  const encodedWords = words.map((word) => {
    const codes: string[] = [];
    for (const ch of word) {
      const parts = decomposeKana(ch);
      if (parts.length === 0) {
        skipped.push(ch);
        continue;
      }
      for (const p of parts) {
        const code = WABUN[p] ?? WABUN_SYMBOLS[p];
        if (code) codes.push(code);
        else skipped.push(p);
      }
    }
    return codes.join(LETTER_GAP);
  });

  return { morse: encodedWords.filter(Boolean).join(WORD_GAP), skipped };
}
