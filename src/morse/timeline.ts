// モールス文字列 → 送出タイムライン（ON/OFF セグメント列）の変換。純粋・環境非依存。
//
// タイミング規則の**唯一の定義場所**。音声再生（player.ts）・光・バイブ・
// テスト信号合成（test/helpers/signal.ts）はすべてここを消費する。
// 規則を別の場所に複製しないこと（2026-07-16 の改修前は player とテストヘルパーが
// それぞれ独自解釈を持ち、player は語間を 9 unit にする不一致バグを抱えていた）。
//
// 標準比率（単位 = dit）: 短点 1 / 長点 3 / 符号内の間 1 / 文字間 3 / 語間 7。

export interface TimelineSegment {
  /** トーン ON か（false = 無音）。セグメントは必ず ON/OFF が交互に並ぶ。 */
  on: boolean;
  /** 継続時間（unit 数）。 */
  units: number;
}

/**
 * モールス文字列（"." "-" " " "/"）をタイムラインへ変換する。
 *
 * 間の扱いは「保留ギャップの max 更新」方式:
 * 要素を出すたび保留 = 1、" " で max(保留,3)、"/" で max(保留,7) とし、
 * 次の要素の直前に off セグメントとして確定する。
 * **置換や加算にしないこと** — encode() の正規形 " / "（スラッシュの前後に空白）を
 * 置換で処理すると後続の " " が 7 を 3 に潰し、加算だと 1+2+4+2=9 unit になる
 * （どちらも実際に踏んだ誤り。ゲート1レビューで確定）。
 *
 * - 先頭の区切り（無音）は出力しない
 * - 末尾の無音も出力しない（再生完了 = 最後のトーン終了。旧 player は末尾に
 *   1 unit の無音を待っていたが、意図的に変更した）
 * - "." "-" " " "/" 以外の文字は無視する
 */
export function buildTimeline(morse: string): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  let pendingGap = 0; // 次の要素の前に置く無音（unit）。0 = まだ要素が無い
  let started = false;

  for (const c of morse) {
    if (c === "." || c === "-") {
      if (started) out.push({ on: false, units: pendingGap });
      out.push({ on: true, units: c === "." ? 1 : 3 });
      started = true;
      pendingGap = 1; // 符号内の間
    } else if (c === " ") {
      pendingGap = Math.max(pendingGap, 3); // 文字間
    } else if (c === "/") {
      pendingGap = Math.max(pendingGap, 7); // 語間
    }
  }
  return out;
}

/** タイムラインの総時間（unit 数）。 */
export function timelineUnits(timeline: TimelineSegment[]): number {
  return timeline.reduce((acc, s) => acc + s.units, 0);
}
