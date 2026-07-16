// 学習モードのカード定義とデッキ構築（純粋ロジック層）。
//
// 設計の背骨（.tmp-learn-plan.md §2/§4）:
//  - 札の符号は必ず encode() から導出し、符号表を手書き複製しない（表とデッキが
//    食い違う二重管理を禁止する。表を変えたら buildDeck が即座に破綻して気づける）。
//  - デッキは「順序（Koch 順）と全カード列挙」の唯一の源。progress（永続進捗）は
//    疎に持ち、未出題カードの列挙はここ（deck）が担う。
//  - 乱数は rng: () => number を注入して決定的にテストする（Math.random 不使用）。

import { encode, Mode } from "../morse";

/** 学習カード 1 枚。char は出題対象の 1 文字、code はその符号（"." "-" 表現）。 */
export interface Card {
  readonly char: string;
  readonly code: string;
}

/**
 * 欧文（国際）モールスの古典 Koch 順（41 文字）。
 * Koch メソッドが伝統的に用いる導入順序で、聞き分けにくい隣接符号を段階的に
 * 増やしていく。全要素は INTERNATIONAL の有効キーでなければならない（buildDeck が検証）。
 */
export const INTERNATIONAL_KOCH_ORDER: readonly string[] = [
  "K", "M", "U", "R", "E", "S", "N", "A", "P", "T",
  "L", "W", "I", ".", "J", "Z", "=", "F", "O", "Y",
  ",", "V", "G", "5", "/", "Q", "9", "2", "H", "3",
  "8", "B", "?", "4", "7", "C", "1", "D", "6", "0",
  "X",
];

/**
 * 和文モールスの学習順（暫定ヒューリスティック定数）。
 *
 * 【暫定】和文モールスにはカノニカルな Koch 順が存在しないため、「いろは歌」順の
 * 48 かな（清音 44 ＋ ヰヱヲン）に、修飾記号 5 種（゛゜ー、。）を末尾へ足したもの。
 * より良い導入順が定まればこの 1 定数を差し替えるだけで済むよう、順序の知識を
 * ここに閉じ込めている（deck.ts の外へ漏らさない）。
 *
 * 不変条件: この配列は WABUN のキー全 48 と WABUN_SYMBOLS のキー全 5 の
 * ちょうど過不足ない並べ替えでなければならない（deck.test.ts が集合一致で検証）。
 */
export const WABUN_KOCH_ORDER: readonly string[] = [
  // いろは 48 かな（濁点等の修飾は付かない原子のみ）
  "イ", "ロ", "ハ", "ニ", "ホ", "ヘ", "ト",
  "チ", "リ", "ヌ", "ル", "ヲ",
  "ワ", "カ", "ヨ", "タ", "レ", "ソ", "ツ",
  "ネ", "ナ", "ラ", "ム",
  "ウ", "ヰ", "ノ", "オ", "ク", "ヤ", "マ",
  "ケ", "フ", "コ", "エ", "テ",
  "ア", "サ", "キ", "ユ", "メ", "ミ", "シ",
  "ヱ", "ヒ", "モ", "セ", "ス",
  "ン",
  // 修飾記号（清音より出現頻度が低いので末尾へ回す）
  "゛", "゜", "ー", "、", "。",
];

/**
 * 指定モードのデッキを Koch 順で構築する。純粋・決定的。
 *
 * code は encode(char, mode) から導出する（手書き禁止）。もし Koch 順定数に
 * 符号化できない文字が混じっていれば throw する — これは「定数と符号表の
 * 食い違い」というプログラミング不変条件の破れを早期に検出するための番人。
 */
export function buildDeck(mode: Mode): Card[] {
  const order = mode === "wabun" ? WABUN_KOCH_ORDER : INTERNATIONAL_KOCH_ORDER;
  return order.map((char) => {
    const { morse, skipped } = encode(char, mode);
    // skipped が空でない or 符号が空 = 定数の文字を符号表が知らない（表変更の検知点）。
    if (skipped.length > 0 || morse.length === 0) {
      throw new Error(
        `buildDeck: 文字 "${char}" (${mode}) を符号化できません（Koch 順定数と符号表の不整合）`
      );
    }
    return { char, code: morse };
  });
}

/**
 * 聞き取り出題の選択肢を作る。純粋・決定的（rng 注入）。
 *
 * 契約（.tmp-learn-plan.md §2）:
 *  - 候補は「解放済みカードのみ」（未解放文字を distractor に出さない = 順次解放の意味を守る）。
 *  - 正解 targetChar を必ず含み、重複しない。
 *  - 返す枚数は min(n, 解放済み枚数)。n は呼び出し側が min(4, unlockedCount) を渡す想定だが、
 *    ここでも解放済み枚数でクランプして「候補より多い選択肢」を作らないよう保証する。
 */
export function makeChoices(
  deck: Card[],
  unlockedCount: number,
  targetChar: string,
  rng: () => number,
  n: number
): string[] {
  const unlocked = deck.slice(0, Math.max(0, unlockedCount)).map((c) => c.char);
  const distractorPool = unlocked.filter((c) => c !== targetChar);
  // 選択肢総数は「正解 1 + distractor」。解放済み枚数を超えられない。最低 1（正解のみ）。
  const size = Math.min(Math.max(1, n), Math.max(1, unlocked.length));
  const chosen = [targetChar, ...pickDistinct(distractorPool, size - 1, rng)];
  // 正解の位置が固定にならないよう最後に並べ替える（位置で答えを推測させない）。
  return shuffle(chosen, rng);
}

/** プールから count 個を重複なく決定的に選ぶ（rng で並べ替えてから先頭を取る）。 */
function pickDistinct(pool: string[], count: number, rng: () => number): string[] {
  if (count <= 0) return [];
  return shuffle(pool, rng).slice(0, count);
}

/** Fisher-Yates。入力を破壊せずコピーを返す（不変更新）。rng は [0,1) を返す注入乱数。 */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
