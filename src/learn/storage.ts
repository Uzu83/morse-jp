// 学習進捗の localStorage 入出力と正規化（副作用を薄く隔離した層）。
//
// 方針（.tmp-learn-plan.md §3）:
//  - 単一キー "morse-jp:learn"、バージョンは JSON 内部 version フィールド。
//  - 正規化（migrate）は「エントリ単位」で行い、部分破損に耐える。全捨てフォールバックは
//    JSON.parse 失敗 / ルートが object でない場合のみ。migrate は決して throw しない。
//  - 書き込みの setItem 例外（プライベートブラウズ・容量超過等）は握りつぶし、
//    メモリ状態で学習を継続する。多タブは last-write-wins を許容する。
//  - localStorage は注入可能にしてテスト可能にする（副作用の隔離）。

import { buildDeck, Card } from "./deck";
import {
  CardStat,
  DeckProgress,
  INITIAL_UNLOCKED,
  BOX_MAX,
  initialDeckProgress,
} from "./scheduler";

/** 永続キー（単一）。 */
export const STORAGE_KEY = "morse-jp:learn";
/** スキーマバージョン。 */
export const VERSION = 1;

/** 永続化するルート状態。 */
export interface PersistedState {
  readonly version: number;
  readonly decks: {
    readonly wabun: DeckProgress;
    readonly international: DeckProgress;
  };
}

/** localStorage の必要最小限のインターフェース（テストで差し替え可能にする）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * ストレージを解決する。
 *  - 明示注入（null 含む）はそのまま尊重する（null は「ストレージ無し」の明示指定）。
 *  - 省略時はグローバル localStorage を試す。参照自体が例外（一部ブラウザのプライバシー
 *    設定で SecurityError）や未定義（node/テスト環境）なら null を返す。
 */
function resolveStorage(injected?: StorageLike | null): StorageLike | null {
  if (injected !== undefined) return injected;
  try {
    if (typeof localStorage !== "undefined") return localStorage as StorageLike;
  } catch {
    /* localStorage への参照自体が例外 → ストレージ無し扱い */
  }
  return null;
}

/** 永続状態を読み込む。破損・欠損は正規化で吸収し、常に有効な状態を返す（throw しない）。 */
export function load(storage?: StorageLike | null): PersistedState {
  const s = resolveStorage(storage);
  let raw: string | null = null;
  try {
    raw = s ? s.getItem(STORAGE_KEY) : null;
  } catch {
    raw = null; // getItem 自体が例外でも既定へ倒す
  }
  return normalize(raw);
}

/**
 * 永続状態を書き込む。setItem 例外は握りつぶす（メモリ継続・多タブ last-write-wins 許容）。
 * updatedAt などの時刻付与は呼び出し側（UI）の責務。ここは Date に触れない（決定性）。
 */
export function save(state: PersistedState, storage?: StorageLike | null): void {
  const s = resolveStorage(storage);
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* プライベートブラウズ・容量超過等 → 握りつぶす */
  }
}

/**
 * 生 JSON 文字列を有効な PersistedState へ正規化する。決して throw しない。
 * 全捨てするのは「parse 失敗」「ルートが object でない」の 2 ケースのみ。
 * それ以外はデッキ単位・カードエントリ単位で部分的に救済する。
 */
export function normalize(raw: string | null): PersistedState {
  const wabunDeck = buildDeck("wabun");
  const intlDeck = buildDeck("international");
  const fallback = defaultState(wabunDeck, intlDeck);

  if (raw == null) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback; // parse 失敗（唯一の全捨てケース その1）
  }
  if (!isObject(parsed)) return fallback; // ルートが object でない（全捨て その2）

  const decksRaw: Record<string, unknown> = isObject(parsed.decks)
    ? parsed.decks
    : {};
  return {
    version: VERSION,
    decks: {
      // 未知のデッキキーは無視。欠損デッキはそれだけ既定へ。
      wabun: normalizeDeck(decksRaw.wabun, wabunDeck),
      international: normalizeDeck(decksRaw.international, intlDeck),
    },
  };
}

/** デッキ 1 つ分を正規化する。欠損/非 object なら既定進捗。 */
function normalizeDeck(raw: unknown, deck: Card[]): DeckProgress {
  if (!isObject(raw)) return initialDeckProgress(deck);

  const validChars = new Set(deck.map((c) => c.char));
  const cardsRaw: Record<string, unknown> = isObject(raw.cards) ? raw.cards : {};
  const cards: Record<string, CardStat> = {};
  for (const [char, statRaw] of Object.entries(cardsRaw)) {
    if (!validChars.has(char)) continue; // デッキに存在しない文字 → そのエントリだけ破棄
    const stat = normalizeStat(statRaw);
    if (stat) cards[char] = stat; // 不正エントリのみ破棄し、他は保持
  }
  // 【意図的】unlockedCount より後ろ（未解放位置）のカード統計も残す。
  // 理由: 現実的な破損は「unlockedCount だけ壊れて下限へクランプされる」形で起き、
  // そのとき未解放側に残った統計は利用者が実際に積んだ進捗そのもの。再解放された
  // 時点で復元されるのが正しい回復動作になる。「解放直後のカードは box 0」は
  // 通常運用（エントリ無し→既定値）の説明であって、破損復旧にまで課す不変条件では
  // ない（ゲート2レビューで議論の上 reject。ここを「解放数の後ろは破棄」に変えると
  // unlockedCount の破損が実進捗の消失へカスケードし、エントリ単位正規化の目的と逆行する）。

  const unlockedCount = clampUnlocked(raw.unlockedCount, deck.length);
  const updatedAt = toFiniteNumber(raw.updatedAt);
  return updatedAt !== null
    ? { unlockedCount, cards, updatedAt }
    : { unlockedCount, cards };
}

/**
 * カード統計 1 件を正規化する。数値でないフィールドがあれば null（= エントリ破棄）。
 * box は 0..BOX_MAX にクランプ、seen は非負、correct は非負かつ seen 以下に切り詰め。
 */
function normalizeStat(raw: unknown): CardStat | null {
  if (!isObject(raw)) return null;
  const box = toInt(raw.box);
  const seen = toInt(raw.seen);
  const correct = toInt(raw.correct);
  if (box === null || seen === null || correct === null) return null;

  const clampedSeen = Math.max(0, seen);
  const clampedCorrect = Math.min(Math.max(0, correct), clampedSeen); // correct ≤ seen
  const clampedBox = Math.min(BOX_MAX, Math.max(0, box)); // 0..BOX_MAX
  return { box: clampedBox, seen: clampedSeen, correct: clampedCorrect };
}

/** unlockedCount を [min(INITIAL_UNLOCKED, デッキサイズ), デッキサイズ] にクランプ。不正なら下限。 */
function clampUnlocked(v: unknown, deckSize: number): number {
  const lo = Math.min(INITIAL_UNLOCKED, deckSize);
  const n = toInt(v);
  if (n === null) return lo;
  return Math.min(deckSize, Math.max(lo, n));
}

/** 既定状態（両デッキとも初期進捗）。 */
function defaultState(wabunDeck: Card[], intlDeck: Card[]): PersistedState {
  return {
    version: VERSION,
    decks: {
      wabun: initialDeckProgress(wabunDeck),
      international: initialDeckProgress(intlDeck),
    },
  };
}

/** object（配列・null を除く）判定。 */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 有限数なら整数へ切り捨てて返す。数値でない/NaN/Infinity は null。 */
function toInt(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

/** 有限数ならそのまま、そうでなければ null。 */
function toFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
