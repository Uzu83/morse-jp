// morse-jp コアAPI。UI・音声から独立した純粋ロジック。

export { encode, WORD_GAP, LETTER_GAP } from "./encode";
export type { Mode } from "./encode";
export { decode } from "./decode";
export { WABUN, WABUN_SYMBOLS } from "./wabun";
export { INTERNATIONAL } from "./international";

import { decode } from "./decode";
import { encode, Mode } from "./encode";

/** 表示用に "." "-" を ・－ へ整形する。 */
export function toDisplay(morse: string): string {
  return morse.replace(/\./g, "・").replace(/-/g, "－");
}

/** encode→decode の往復（テスト・確認用）。 */
export function roundTrip(text: string, mode: Mode): string {
  return decode(encode(text, mode).morse, mode);
}
