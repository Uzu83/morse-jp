// 学習モードの出題スケジューラ（純粋ロジック層）。
//
// 方式（.tmp-learn-plan.md §2）:
//  - Leitner（箱式）: 箱 0..BOX_MAX の 5 段。正答で +1（上限クランプ）、誤答で 0 へ。
//  - 出題重み: weight = 2^(BOX_MAX − box)。低い箱ほど重く、優先的に再出題される。
//  - 誤答再出題の保証: 重み付き抽選だけでは「近いうちに再出題」を保証できないため、
//    セッション内の「ミスキュー」で誤答札を他の MISS_REQUEUE_DELAY 問の後に強制再出題する。
//  - 連続同一札の禁止: 直前と同じ札は避ける（代替が存在する場合）。
//  - 順次解放: 解放済み全カードが box ≥ UNLOCK_BOX_THRESHOLD になったら次の 1 文字を解放。
//
// この層は完全に純粋（Math.random / Date 不使用）。乱数は rng を注入し、
// すべての更新は不変（入力を破壊せず新オブジェクトを返す）。
//
// 状態の分離（設計の背骨）:
//  - deck    : 静的定義（順序・全カード列挙）           → deck.ts
//  - progress: 永続する進捗（箱・統計・解放数）          → ここで型定義、storage が永続化
//  - session : セッション内の一時状態（ミスキュー・直前札）→ ここで型定義、永続化しない

import { Card } from "./deck";

/** 箱の最大値。箱は 0..BOX_MAX の 5 段（0=未習熟、BOX_MAX=定着）。 */
export const BOX_MAX = 4;
/** 初期解放数。選択肢クイズが成立する最低母数を優先（Koch 伝統の 2 文字より多い）。 */
export const INITIAL_UNLOCKED = 5;
/** 誤答札を強制再出題するまでに挟む「他の札」の問題数。 */
export const MISS_REQUEUE_DELAY = 2;
/** 次の文字を解放する条件: 解放済み全カードがこの箱以上。 */
export const UNLOCK_BOX_THRESHOLD = 2;

/** カード 1 枚の学習統計。box は 0..BOX_MAX、correct ≤ seen が不変条件。 */
export interface CardStat {
  readonly box: number;
  readonly seen: number;
  readonly correct: number;
}

/**
 * 1 デッキ分の進捗（永続対象）。
 * cards は疎でよい: エントリの無い解放済みカードは DEFAULT_CARD_STAT として扱う。
 * updatedAt は表示専用で、採点ロジックには一切使わない（決定性の維持）。
 */
export interface DeckProgress {
  readonly unlockedCount: number;
  readonly cards: Readonly<Record<string, CardStat>>;
  readonly updatedAt?: number;
}

/** ミスキューの 1 項目。dueIn 問後に強制再出題（0 で「今すぐ期限到来」）。 */
export interface MissEntry {
  readonly char: string;
  readonly dueIn: number;
}

/**
 * セッション内の一時状態（永続化しない）。
 *  - lastChar : 直前に出題した札（連続同一札の禁止に使う）。初期は null。
 *  - missQueue: 誤答札の強制再出題キュー。
 */
export interface Session {
  readonly lastChar: string | null;
  readonly missQueue: readonly MissEntry[];
}

/** エントリの無いカードの既定統計（不変・共有参照で安全）。 */
export const DEFAULT_CARD_STAT: CardStat = { box: 0, seen: 0, correct: 0 };

/** セッション初期状態。 */
export const INITIAL_SESSION: Session = { lastChar: null, missQueue: [] };

/** progress からカード統計を取り出す。エントリが無ければ既定値を補完する。 */
export function getStat(progress: DeckProgress, char: string): CardStat {
  return progress.cards[char] ?? DEFAULT_CARD_STAT;
}

/** 初期進捗（cards 空・unlockedCount はデッキサイズでクランプ）。storage の既定にも使う。 */
export function initialDeckProgress(deck: Card[]): DeckProgress {
  return { unlockedCount: Math.min(INITIAL_UNLOCKED, deck.length), cards: {} };
}

/**
 * 次に出題する札を決める。純粋・決定的（同一 rng 系列 → 同一出力）。
 *
 * 優先順位:
 *  1. 期限の来たミスキュー（dueIn ≤ 0）を最優先で強制再出題する。
 *     重み付き抽選だけでは近接再出題を保証できないため、ここで確定的に割り込む。
 *     解放済みが 3 枚以上なら、期限到来時の札は必ず直前札と異なる（2 問挟むため）ので
 *     連続同一札の禁止と衝突しない。縮退（< 3 枚）時は強制再出題を優先する。
 *  2. 直前札を避けた候補（代替が 1 枚以上あるときのみ避ける）。
 *  3. 低箱優先の重み付き抽選 weight = 2^(BOX_MAX − box)。
 */
export function pickNext(
  deck: Card[],
  progress: DeckProgress,
  session: Session,
  rng: () => number
): string {
  const unlockedSet = new Set(unlockedChars(deck, progress));
  if (unlockedSet.size === 0) {
    throw new Error("pickNext: 解放済みカードが 0 枚です（unlockedCount の不正）");
  }

  // 1. 期限到来のミスキューを強制再出題（キューは解放済み札しか持たないが念のため確認）。
  const due = session.missQueue.find((m) => m.dueIn <= 0 && unlockedSet.has(m.char));
  if (due) return due.char;

  // 2. 直前札の回避（代替が存在する場合のみ）。
  const unlocked = [...unlockedSet];
  const candidates =
    session.lastChar !== null && unlocked.length > 1
      ? unlocked.filter((c) => c !== session.lastChar)
      : unlocked;

  // 3. 低箱優先の重み付き抽選。
  return weightedPick(candidates, progress, rng);
}

/** 解放済みカードの文字配列（deck 順・先頭 unlockedCount 枚）。 */
function unlockedChars(deck: Card[], progress: DeckProgress): string[] {
  const count = Math.max(0, Math.min(progress.unlockedCount, deck.length));
  return deck.slice(0, count).map((c) => c.char);
}

/** weight = 2^(BOX_MAX − box) の重み付き抽選。純粋・決定的。 */
function weightedPick(
  candidates: string[],
  progress: DeckProgress,
  rng: () => number
): string {
  if (candidates.length === 0) {
    throw new Error("weightedPick: 候補が空です");
  }
  const weights = candidates.map((c) =>
    Math.pow(2, BOX_MAX - getStat(progress, c).box)
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r < 0) return candidates[i];
  }
  // 浮動小数の端数で全 weight を引ききった場合の保険（実質到達しない）。
  return candidates[candidates.length - 1];
}

/**
 * 採点結果を進捗へ反映する（不変更新）。
 * 正答: box +1（BOX_MAX でクランプ）。誤答: box → 0。seen は常に +1、correct は正答時のみ +1。
 * updatedAt には触れない（純粋性維持。表示時刻の付与は UI/storage の責務）。
 */
export function applyResult(
  progress: DeckProgress,
  char: string,
  correct: boolean
): DeckProgress {
  const prev = getStat(progress, char);
  const box = correct ? Math.min(BOX_MAX, prev.box + 1) : 0;
  const next: CardStat = {
    box,
    seen: prev.seen + 1,
    correct: prev.correct + (correct ? 1 : 0),
  };
  return { ...progress, cards: { ...progress.cards, [char]: next } };
}

/**
 * 誤答札をミスキューへ登録する（不変更新）。
 * 既存の同一札エントリは新しい遅延で置き換える（重複キューを作らない）。
 * dueIn = MISS_REQUEUE_DELAY から始まり、他の札が 1 問出るたび advanceSession で 1 減る。
 */
export function noteMiss(session: Session, char: string): Session {
  const rest = session.missQueue.filter((m) => m.char !== char);
  return {
    ...session,
    missQueue: [...rest, { char, dueIn: MISS_REQUEUE_DELAY }],
  };
}

/**
 * 1 問出題し終えた後のセッション更新（不変更新）。
 *  - 出題した char は保留中の再出題を満たすのでキューから除外する。
 *    ※ 呼び出し順は「advanceSession → （誤答なら）noteMiss」。この順序により、
 *      誤答時に advanceSession が古い保留を消してから noteMiss が dueIn を貼り直す。
 *  - 残りエントリは「他の札が 1 問出た」ので dueIn を 1 減らす（0 でクランプ）。
 *  - lastChar を更新する。
 */
export function advanceSession(session: Session, char: string): Session {
  const missQueue = session.missQueue
    .filter((m) => m.char !== char)
    .map((m) => ({ char: m.char, dueIn: Math.max(0, m.dueIn - 1) }));
  return { lastChar: char, missQueue };
}

/**
 * 次の 1 文字を解放できるか。
 * 条件: まだ全解放しておらず、かつ解放済み全カードが box ≥ UNLOCK_BOX_THRESHOLD。
 * 累積/直近正答率は使わない（直近性は「誤答で box 0 に落ちる」ことで既に表現される）。
 */
export function isUnlockReady(deck: Card[], progress: DeckProgress): boolean {
  if (progress.unlockedCount >= deck.length) return false; // 上限（全解放済み）
  const unlocked = unlockedChars(deck, progress);
  return unlocked.every((c) => getStat(progress, c).box >= UNLOCK_BOX_THRESHOLD);
}

/**
 * 次の 1 文字を解放する（不変更新）。解放条件を満たさない/上限なら不変で返す。
 * 新カードはエントリを持たない = box 0（DEFAULT_CARD_STAT）として自然に入る。
 */
export function unlockNext(deck: Card[], progress: DeckProgress): DeckProgress {
  if (!isUnlockReady(deck, progress)) return progress;
  return { ...progress, unlockedCount: progress.unlockedCount + 1 };
}
