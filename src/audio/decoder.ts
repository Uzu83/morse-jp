// マイク入力からモールス符号を復号する — ブラウザ結合層。
//
// 流れ: マイク → AnalyserNode → 毎フレーム getFloatFrequencyData →
//       ToneDetector（ON/OFF 判定・純粋） → PulseClassifier（符号組み立て・純粋）
//
// 本ファイルは意図的に「薄い」。判定・分類のロジックをここに書き足さないこと。
// 2026-07-15 の改修で、旧実装（固定しきい値 0.35/0.20 + 逐次確定）が持っていた
// ロジックはすべて detect.ts / classify.ts へ移した。理由と設計判断の履歴は
// 両ファイルの冒頭コメントにある（固定しきい値・byte スペクトラム・逐次確定へ
// 戻さないこと — codex レビューで欠陥として確定済み）。
//
// 既知の制約（仕様）:
// - rAF 駆動なのでタブが非表示になると受信が止まる。バックグラウンド受信が
//   必要になったら AudioWorklet 化する（ロードマップ記載の将来課題）。
// - サポート範囲は 5〜40 WPM の一定速度送信。詳細は classify.ts 冒頭。

import { PulseClassifier } from "./classify";
import { ToneDetector } from "./detect";

/** 受信状態（UI メーター用）。dB はすべてノイズ床からの相対値。 */
export interface ListenStatus {
  /** 現フレームの信号レベル（ノイズ床比 dB）。 */
  snrDb: number;
  /** トーン ON 判定中か。 */
  on: boolean;
  /** 検出可能な状態か（信号とノイズの分離が確保できているか）。 */
  ready: boolean;
  /** 推定送信速度（WPM）。短点・長点の両クラスタ確定まで null（UI は「測定中」）。 */
  wpm: number | null;
  /** ON 判定しきい値（ノイズ床比 dB）。メーターのマーカー位置。 */
  onThreshDb: number;
  /** OFF 判定しきい値（ノイズ床比 dB）。 */
  offThreshDb: number;
}

export interface ListenOptions {
  /** 対象トーン周波数の中心（Hz）。既定 600。 */
  freq?: number;
  /** モールス文字列が変化するたびに呼ばれる（毎回全文を渡す — 遡及訂正があるため）。 */
  onMorse?: (morse: string) => void;
  /** 毎フレームの受信状態。UI メーター用。 */
  onStatus?: (status: ListenStatus) => void;
}

export class MorseListener {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private raf = 0;
  private analyser?: AnalyserNode;
  private detector?: ToneDetector;
  private classifier = new PulseClassifier();
  // TS 5.7+ の DOM 型は getFloatFrequencyData に ArrayBuffer 背景の配列を要求する
  private spectrum?: Float32Array<ArrayBuffer>;
  private lastMorse = "";

  constructor(private opts: ListenOptions = {}) {}

  async start(): Promise<void> {
    // echoCancellation 等の音声通話向け処理はトーンを「エコー」として抑圧しうるので
    // 明示的に切る（ブラウザ既定は on のことが多い）。
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    // 時間方向の平滑化はパルスのエッジを鈍らせる（短点の立ち上がり検出が遅れる）ので
    // 0 にする。平滑化の役割は ToneDetector のトラッカーが担う。
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    this.analyser = analyser;
    this.detector = new ToneDetector({
      sampleRate: this.ctx.sampleRate,
      fftSize: analyser.fftSize,
      freq: this.opts.freq ?? 600,
    });
    this.spectrum = new Float32Array(analyser.frequencyBinCount);
    this.loop();
  }

  /** 受信を停止し、進行中の符号を確定した最終モールス文字列を返す。 */
  stop(): string {
    cancelAnimationFrame(this.raf);
    // 進行中の ON・末尾の区切りを flush で確定してから通知する
    // （旧実装は停止時に進行中の符号を捨てていた）。
    const now = this.ctx?.currentTime ?? 0;
    const { morse } = this.classifier.flush(now);
    if (morse !== this.lastMorse) this.opts.onMorse?.(morse);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    return morse;
  }

  private loop = () => {
    const analyser = this.analyser!;
    const ctx = this.ctx!;
    const spectrum = this.spectrum!;
    analyser.getFloatFrequencyData(spectrum);

    // 時刻は rAF の値ではなく音声クロック（AudioContext.currentTime）を使う。
    // rAF のタイムスタンプは描画クロックで、スロットリング時に音声とずれる。
    const now = ctx.currentTime;
    const frame = this.detector!.update(spectrum, now);
    this.classifier.push(frame.on, now);

    const { morse, unit } = this.classifier.read(now);
    if (morse !== this.lastMorse) {
      this.lastMorse = morse;
      this.opts.onMorse?.(morse);
    }
    this.opts.onStatus?.({
      snrDb: frame.snrDb,
      on: frame.on,
      ready: frame.ready,
      wpm: unit === null ? null : Math.round(1.2 / unit),
      onThreshDb: frame.onThreshDb,
      offThreshDb: frame.offThreshDb,
    });

    this.raf = requestAnimationFrame(this.loop);
  };
}
