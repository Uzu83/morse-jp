// モールスの再生セッション — 音（WebAudio）・光・バイブレーションを一括で駆動する。
//
// ── 設計判断（ゲート1レビュー 2 巡で確定。崩す前に読むこと） ──
//
// 1. **単一セッションが全出力を所有する**。音・光・振動を別々の呼び出しで始めると、
//    再クリック時に「旧セッションの後始末が新セッションの点灯を消す」競合や、
//    AudioContext.resume() の遅延分だけ振動が先行するズレが生じる。
//    開始・停止・abort の所有権は playMorse 1 箇所に置く。
// 2. **再生位置の基準は音声クロック（ctx.currentTime − t0）**。performance.now() を
//    基準にすると、バックグラウンドで AudioContext が suspend された時に音声だけ
//    止まり、光・振動が先に完走してしまう。performance 系は使わず、wall タイマーは
//    「次の境界まで待つ長さ」の目安にだけ使う（遅れても位置計算が正す）。
// 3. **タイミング規則は timeline.ts が唯一の定義**。旧実装はここに独自解釈を持ち、
//    語間が標準 7 unit でなく 9 unit になるバグがあった（修正済み・意図的変更）。
//    同じく、完了は「最後のトーン終了」時点になった（旧実装は末尾の符号内間 1 unit も
//    待っていた）。
// 4. **振動は Vibration API の一括パターンではなく ON 遷移ごとに vibrate(残り時間)**。
//    タイミングの出所がエポック一本になり、遅延復帰時は残り時間だけ振動し、
//    abort 時は vibrate(0) 一発で即止まる。

import { buildTimeline, TimelineSegment, timelineUnits } from "../morse/timeline";

export interface PlayOptions {
  /** 速度（WPM）。dit 長 = 1200 / wpm ミリ秒。 */
  wpm?: number;
  /** トーン周波数（Hz）。 */
  freq?: number;
  /** 中断用シグナル。 */
  signal?: AbortSignal;
  /** 光インジケータ用。ON/OFF 遷移ごとに呼ばれる。完了・中断時は必ず false で終わる。 */
  onLight?: (on: boolean) => void;
  /** true なら Vibration API で振動も出す（非対応環境では無視）。 */
  vibrate?: boolean;
}

/**
 * "." "-" と空白・"/" からなるモールス文字列を再生する。
 * Promise は再生完了（または中断）で解決する。
 */
export async function playMorse(
  morse: string,
  { wpm = 18, freq = 600, signal, onLight, vibrate }: PlayOptions = {}
): Promise<void> {
  const timeline = buildTimeline(morse);
  if (timeline.length === 0) return;
  const unit = 1.2 / wpm; // 秒

  const ctx = new (window.AudioContext ||
    (window as any).webkitAudioContext)();
  await ctx.resume();
  // resume() 待機中に停止ボタンが押されていた場合ここで拾う。
  // 後から abort listener を張るだけでは「既に発生済みの abort」を取りこぼす
  // （旧実装の潜在バグ。ゲート1レビュー指摘）。
  // ここで onLight(false) 等の出力操作をしてはいけない: このセッションはまだ
  // 何も出力しておらず、しかもこの分岐は abort より**後に非同期で**走るため、
  // 次のセッションが既に点けた光を消してしまう（ゲート2レビュー指摘）。
  // 原則: 非同期に遅延しうる後始末は共有出力（光・振動）に触らない。
  // 出力の消し込みは「abort listener からの同期 cleanup」だけが行う。
  if (signal?.aborted) {
    await ctx.close();
    return;
  }

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(gain);
  osc.start();

  // 共有エポック。音声はここから WebAudio に先行スケジュール、光・振動は
  // ランナーが同じ t0 を基準に追従する。+0.05s はスケジューリングの安全マージン。
  const t0 = ctx.currentTime + 0.05;
  const ramp = Math.min(0.005, unit * 0.15); // クリック音を抑える立ち上がり

  let t = t0;
  for (const seg of timeline) {
    const end = t + seg.units * unit;
    if (seg.on) {
      gain.gain.setValueAtTime(0, t - ramp);
      gain.gain.linearRampToValueAtTime(0.25, t);
      gain.gain.setValueAtTime(0.25, end - ramp);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    t = end;
  }

  // ランナーは光・振動が無くても常に走らせる — セッションの**完了判定そのもの**を
  // 音声クロック駆動のランナーに任せるため（wall タイマー単発で完了を決めると、
  // AudioContext が suspend された時に未再生分を打ち切ってしまう — ゲート2指摘）。
  // abort は外部 signal と「終了処理からの内部停止」の両方で起こしたいので
  // 内部 controller に集約する（ctx.close() 後は currentTime が凍結して
  // ランナーが自力で終端へ到達できないため、必ず止めてから閉じる）。
  const runnerCtl = new AbortController();
  const canVibrate = !!vibrate && "vibrate" in navigator;
  const runnerDone = runTimeline({
    timeline,
    unitSec: unit,
    t0,
    clock: () => ctx.currentTime,
    signal: runnerCtl.signal,
    onChange: (on, remainingMs) => {
      onLight?.(on);
      // suspend 中に振動が自然停止した場合の再発火はランナーの stall 検出が
      // remainingMs を縮めて再度ここを呼ぶ。vibrate(0) の明示は不要
      // （ms 指定の振動は指定時間で勝手に止まる）。
      if (canVibrate && on) navigator.vibrate(Math.round(remainingMs));
    },
  });

  const endTime = t0 + timelineUnits(timeline) * unit;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(backstop);
      runnerCtl.abort();
      // 出力の消し込みはセッションの責務（受入条件: 停止・完了・エラーで必ず消灯）。
      // この finish が走る経路は「abort listener（同期）」「ランナー自然完了」
      // 「バックストップ」のみで、いずれも直後に新セッションが上書きできる順序。
      if (canVibrate) navigator.vibrate(0);
      onLight?.(false);
      try {
        osc.stop();
        ctx.close();
      } catch {
        /* noop */
      }
      resolve();
    };
    // 自然完了 = ランナーが音声クロック上で終端に到達したとき。
    // +100ms は最終トーンのリリースランプ（〜5ms）と WebAudio の出力遅延の余裕。
    runnerDone.then(() => setTimeout(finish, 100));
    // バックストップ: AudioContext が死んでクロックが永久に進まない異常系でも
    // セッションを畳む。正常系では絶対に先着しない余裕（+30s）を取る。
    const backstop = setTimeout(
      finish,
      (endTime - ctx.currentTime) * 1000 + 30_000
    );
    signal?.addEventListener("abort", finish, { once: true });
    // スケジューリング中に abort されていた場合、addEventListener は発火しない
    // （発生済みイベントは配送されない）ので明示的に確認する。
    if (signal?.aborted) finish();
  });
}

// ────────────────────────────────────────────────────────────────
// タイムラインランナー（純粋: クロック注入・環境非依存。テストは fake timers で行う）
// ────────────────────────────────────────────────────────────────

export interface RunTimelineOptions {
  timeline: TimelineSegment[];
  /** dit 長（秒）。 */
  unitSec: number;
  /** clock() 上の開始時刻（秒）。 */
  t0: number;
  /** 再生位置の基準クロック（秒）。本番は () => ctx.currentTime。 */
  clock: () => number;
  signal?: AbortSignal;
  /**
   * 状態遷移ごとに呼ばれる。remainingMs は現在セグメントの残り時間 —
   * 遅延して途中から復帰した場合は全長より短くなる（振動はこの値だけ振動させる）。
   */
  onChange: (on: boolean, remainingMs: number) => void;
}

/**
 * タイムラインに沿って onChange を発火する。位置は毎 wake で clock から絶対計算し、
 * タイマー遅延で失われた遷移は**再生せず現在状態へスキップ**する（ゲート1で固定した
 * 仕様 — タブ非表示から復帰したとき、過去の点滅を高速リプレイしない）。
 * クロックが停止（AudioContext suspend）している間は位置が進まず、境界間隔で
 * ポーリングして復帰を待つ。**停止からの再開を検出したら、同一 ON セグメント内でも
 * 残り時間つきで再発火する** — wall 時間で指定した振動は suspend 中に自然停止して
 * いるため、再開後の残り区間を振動させ直す必要がある（ゲート2レビュー指摘）。
 * 終了時（自然完了・abort とも）は必ず off を報告する。
 */
export function runTimeline(opts: RunTimelineOptions): Promise<void> {
  const { timeline, unitSec, t0, clock, signal, onChange } = opts;
  // 各セグメントの開始位置（秒）を前計算
  const starts: number[] = [];
  let acc = 0;
  for (const seg of timeline) {
    starts.push(acc);
    acc += seg.units * unitSec;
  }
  const total = acc;

  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let lastIndex = -1;
    let lastState = false;
    let lastPos = -Infinity;
    let stalled = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (lastState) onChange(false, 0);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener("abort", finish, { once: true });

    const tick = () => {
      if (done) return;
      const pos = clock() - t0;
      if (pos >= total) {
        finish();
        return;
      }
      let delaySec: number;
      if (pos < 0) {
        delaySec = -pos; // 開始前 — t0 まで待つ
      } else {
        // 現在セグメントを線形探索（セグメント数は高々数百。二分探索は過剰）
        let i = lastIndex < 0 ? 0 : lastIndex;
        while (i + 1 < starts.length && starts[i + 1] <= pos) i++;
        const seg = timeline[i];
        const segEnd = i + 1 < starts.length ? starts[i + 1] : total;
        // クロック停止（suspend）→再開の検出。frozen クロックは同値を返すので
        // 厳密比較でよい（通常 wake は最低 10ms 進む）。
        const resumed = stalled && pos > lastPos;
        // 発火条件: 状態が変わった / 新しい ON セグメントに入った（スキップ時の
        // 振動再発火のため）/ 停止から同一 ON セグメント内へ再開した
        if (seg.on !== lastState || (seg.on && (i !== lastIndex || resumed))) {
          onChange(seg.on, (segEnd - pos) * 1000);
        }
        lastIndex = i;
        lastState = seg.on;
        stalled = pos === lastPos;
        lastPos = pos;
        delaySec = segEnd - pos;
      }
      // クロック停止中は pos が進まず同じ境界を待ち続ける形になる。
      // 最低 10ms を敷いてビジーループ化を防ぐ（境界間隔でのポーリングに落ちる）。
      timer = setTimeout(tick, Math.max(delaySec * 1000, 10));
    };
    tick();
  });
}
