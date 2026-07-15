import { INTERNATIONAL_REVERSE } from "./international";
import { Mode } from "./encode";
import {
  COMPOSE_DAKUTEN,
  COMPOSE_HANDAKUTEN,
  WABUN_REVERSE,
} from "./wabun";

/**
 * 入力を正規化する: 全角 ・／－ を "." "-" に、語区切り "/" を統一トークンに、
 * 連続空白を単一に整える。
 */
function normalize(morse: string): string {
  return morse
    .replace(/[・･]/g, ".")
    .replace(/[－ー—–‐]/g, "-")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

/** モールス符号をテキストに復号する。 */
export function decode(morse: string, mode: Mode): string {
  const normalized = normalize(morse);
  if (!normalized) return "";

  const words = normalized.split(" / ");
  const decodedWords = words.map((word) => {
    const tokens = word.split(" ").filter(Boolean);
    return mode === "wabun"
      ? decodeWabunWord(tokens)
      : decodeInternationalWord(tokens);
  });

  return decodedWords.join(" ");
}

function decodeInternationalWord(tokens: string[]): string {
  return tokens.map((t) => INTERNATIONAL_REVERSE[t] ?? "�").join("");
}

function decodeWabunWord(tokens: string[]): string {
  let out = "";
  for (const t of tokens) {
    const ch = WABUN_REVERSE[t];
    if (ch === undefined) {
      out += "�";
      continue;
    }
    if (ch === "゛") {
      // 直前の清音を濁音へ合成。合成できなければ記号のまま残す。
      const last = out.slice(-1);
      const voiced = COMPOSE_DAKUTEN[last];
      if (voiced) out = out.slice(0, -1) + voiced;
      else out += "゛";
    } else if (ch === "゜") {
      const last = out.slice(-1);
      const semi = COMPOSE_HANDAKUTEN[last];
      if (semi) out = out.slice(0, -1) + semi;
      else out += "゜";
    } else {
      out += ch;
    }
  }
  return out;
}
