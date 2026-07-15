// ToneDetector — FFT スペクトラム 1 フレームから対象トーンの ON/OFF を判定する純粋クラス。
//
// AudioContext 非依存（入力は dB 値の Float32Array と timestamp のみ）。
// ブラウザ密結合だった判定ロジックを単体テスト可能にするため分離した
// （2026-07-15 codex レビュー high 指摘:「検出器が無検証のまま」への対応）。
//
// ── 設計判断の履歴（変更する前に読むこと） ──────────────────────────
//
// 1. 入力は getFloatFrequencyData の dB 値。getByteFrequencyData は使わない。
//    byte 値は dB を 0–255 に写像したもので、平均や差分の演算は尺度上不正確
//    （codex レビュー high 指摘で旧実装の欠陥として確定）。dB 差はそのまま
//    SNR[dB] として意味を持つため、自動ゲイン（マイク音量の絶対値への非依存）も
//    「対象帯域 − 参照帯域」の差分で自然に成立する。
//
// 2. しきい値は「レート制限付きノイズ床 + ピークホールド」で追跡する。
//    - 分位点方式（ローリング窓の p20/p90）を最初に計画したが、codex レビューで
//      「長い連続 ON で p20 が信号側に引かれて強制 OFF になる」
//      「長無音明けは信号標本が溜まるまで ~300ms 検出できない」と指摘され破綻が
//      確定したため差し替えた。分位点方式に戻さないこと。
//    - ON/OFF の判定結果をしきい値学習に使わない（判定非依存）。判定結果に
//      依存させると誤判定から回復できないロック状態が生じる（同レビュー high 指摘）。
//
// 3. Goertzel フィルタは v1 では不採用（AnalyserNode + ガード帯域で十分、コード量 1/3）。
//    ただし本クラスが純粋である限り、同じテストのまま Goertzel 実装へ差し替えて
//    比較できる。実環境で精度不足が観測されたら差し替えを検討する（codex と合意済み）。

/** 検出器の生成オプション。AnalyserNode の実パラメータをそのまま渡す。 */
export interface DetectorOptions {
  /** AudioContext.sampleRate（Hz）。 */
  sampleRate: number;
  /** AnalyserNode.fftSize。スペクトラム長はこの半分。 */
  fftSize: number;
  /** 対象トーンの中心周波数（Hz）。 */
  freq: number;
}

/** update() が返す 1 フレーム分の判定結果。dB 値はすべてノイズ床からの相対値。 */
export interface DetectorFrame {
  /** トーン ON と判定したか。 */
  on: boolean;
  /** 現フレームの信号レベル（ノイズ床比 dB）。UI メーターにそのまま使える。 */
  snrDb: number;
  /**
   * 検出可能な状態か（ピーク − 床 > READY_DB）。false の間は常に OFF。
   * 無音・白色雑音だけの環境で誤発火しないためのゲート。
   */
  ready: boolean;
  /** ON 判定しきい値（ノイズ床比 dB）。メーターのマーカー表示用。 */
  onThreshDb: number;
  /** OFF 判定しきい値（ノイズ床比 dB）。ヒステリシスの下側。 */
  offThreshDb: number;
}

// ── 帯域レイアウト（bin 単位で明示。codex レビュー med 指摘への対応） ──
// 対象帯域:   |Δf| ≤ 40Hz   … トーン本体。±40Hz は WPM 30 のキーイングサイドバンド
//                              （≈ 25Hz）を包含しつつ隣接楽音を拾わない幅。
// ガード帯域: 40 < |Δf| ≤ 80 … 集計から除外。Blackman 窓の漏れが参照側に
//                              「自分自身」として混入し SNR を過小評価するのを防ぐ。
// 参照帯域:   80 < |Δf| ≤ 240 … 環境ノイズの推定。左右両側を使い、Nyquist/0Hz で
//                              クランプ。片側が空なら他方のみ使用する。
const TARGET_HZ = 40;
const GUARD_HZ = 80;
const REF_HZ = 240;

// getFloatFrequencyData は無音 bin で -Infinity を返しうる。演算を汚染しないよう
// クランプする。-120dB は 16bit 量子化ノイズ床よりさらに下で、実信号と混同しない。
const SILENCE_DB = -120;

// ── トラッカー設計の注意（実測に基づく。安易に「即時追従」へ戻さないこと） ──
// 床・ピークとも「極値」ではなく「典型値」を追う。当初は 床=即時min / ピーク=即時max
// で実装したが、白色雑音だけでも 4bin 帯域平均の SNR は σ≈4dB で揺れ、200 フレームも
// 観測すると極値同士の差（p2p）は実測 17.8dB に達した — 極値追従では雑音だけで
// ready 判定を突破し、偽パルスが連発する（統合テストで "SOS" が "ASOS" になった）。

// ノイズ床の上昇レート上限（dB/秒）。トーン（短点数十 ms〜長点 720ms@5WPM）程度では
// 床が信号レベルまで登れない値。この制限の帰結として、連続トーンの保持時間は
// おおむね (SNR − READY_DB) / 3 秒 — 例: SNR 58dB で ~15 秒、SNR 20dB で ~2.7 秒。
// それを超える連続トーンで ready が閉じて OFF になるのは仕様（モールスに
// そんな要素は無い）。README には控えめに「数秒〜十数秒（信号強度に依存）」と記載。
const FLOOR_RISE_DB_PER_SEC = 3;
// ノイズ床の下降時定数（秒）。即時 min 追従にしない理由は上のトラッカー設計の注意を参照。
// 0.5s = 語間（7u ≈ 1.7s @18WPM）の無音で床が十分再固定され、かつ雑音の
// 単発の深い谷（1 フレーム）には引きずられない値。
const FLOOR_FALL_TAU_SEC = 0.5;
// ピークの上昇時定数（秒）。即時 max にすると雑音の 3σ 外れ値 1 フレームで ready が
// 開いてしまう。50ms = 実トーンの立ち上がり（数十 dB）は 1〜2 フレームで追従しつつ、
// 単発外れ値は 3 割しか反映しない値。
const PEAK_RISE_TAU_SEC = 0.05;
// ピークの減衰レート（dB/秒）。語間の無音では ready を維持し、送信が完全に
// 止まったら数秒で非 ready に戻る値。
const PEAK_DECAY_DB_PER_SEC = 5;
// ready 判定に要求する ピーク−床 の最小分離（dB）。
// 白色雑音のみの環境で、EMA トラッカーの典型値スパンは実測 ~9dB（σ≈4dB）。
// 12dB はその上に余裕を置いた値で、雑音だけでは開かない（テストで拘束）。
// 帰結として帯域内 SNR ~12dB 未満の微弱信号は検出できない — v1 の仕様。
const READY_DB = 12;
// ヒステリシス: ON は分離の 55%、OFF は 35% を跨いだとき。
// 中点 45% を挟んで ±10% の不感帯を置き、境界揺れでのチャタリングを防ぐ。
// さらに絶対下限（ON は READY_DB、OFF はその 6 割）を敷く — span が小さいときに
// しきい値が雑音の揺れの中に沈むのを防ぐため。
const ON_RATIO = 0.55;
const OFF_RATIO = 0.35;
const ON_MIN_DB = READY_DB;
const OFF_MIN_DB = READY_DB * 0.6;
// rAF はタブ非表示等で長時間止まる。復帰フレームの巨大 dt でトラッカーが
// 暴走しないよう dt をクランプする（codex レビュー med 指摘への対応）。
const MAX_DT_SEC = 0.1;

export class ToneDetector {
  private readonly targetBins: [number, number]; // [開始, 終了] 閉区間
  private readonly refBins: Array<[number, number]>;

  // トラッカー状態。初期値は「最初のフレームのレベル」で床・ピークとも同値に置く。
  // 起動時からトーンが鳴っている場合は分離が生まれず ready=false のままだが、
  // 最初の無音で床が速やかに下がり（下降 EMA τ=0.5s）、次のトーンで ready になる。
  // この「起動直後にトーンが鳴りっぱなしだと最初の無音まで検出しない」挙動は
  // 仕様（codex レビュー 3 巡目で合意。テストで固定済み）。
  private floor = Number.NaN;
  private peak = Number.NaN;
  private lastTime = Number.NaN;
  private on = false;

  constructor(opts: DetectorOptions) {
    const binHz = opts.sampleRate / opts.fftSize;
    const binCount = opts.fftSize / 2;
    const centerBin = opts.freq / binHz;

    const span = (hz: number) => hz / binHz;
    const clamp = (b: number) => Math.max(0, Math.min(binCount - 1, b));

    const tLo = clamp(Math.ceil(centerBin - span(TARGET_HZ)));
    const tHi = clamp(Math.floor(centerBin + span(TARGET_HZ)));
    this.targetBins = [tLo, tHi];

    // 参照帯域は左右それぞれ [中心+80Hz, 中心+240Hz]（と負側）。クランプ後に
    // 幅が消えた側は捨てる。
    const refs: Array<[number, number]> = [];
    const rLoL = clamp(Math.ceil(centerBin - span(REF_HZ)));
    const rHiL = clamp(Math.floor(centerBin - span(GUARD_HZ)));
    if (rHiL > rLoL) refs.push([rLoL, rHiL]);
    const rLoR = clamp(Math.ceil(centerBin + span(GUARD_HZ)));
    const rHiR = clamp(Math.floor(centerBin + span(REF_HZ)));
    if (rHiR > rLoR) refs.push([rLoR, rHiR]);
    this.refBins = refs;

    // 対象 or 参照が確保できない中心周波数は構成ミス。実行時に黙って劣化するより
    // 生成時に落とす（codex レビュー med 指摘:「Nyquist 範囲外の場合が無い」への対応）。
    if (tHi < tLo || refs.length === 0) {
      throw new RangeError(
        `ToneDetector: freq=${opts.freq}Hz は sampleRate=${opts.sampleRate} で帯域を確保できない`
      );
    }
  }

  /**
   * スペクトラム 1 フレームを処理して ON/OFF 判定を返す。
   * @param spectrumDb getFloatFrequencyData で得た dB 値（長さ fftSize/2）
   * @param time フレームの時刻（秒）。AudioContext.currentTime を想定
   */
  update(spectrumDb: Float32Array, time: number): DetectorFrame {
    // 帯域平均は dB 値のままではなく**線形パワーに戻してから**取る。
    // Rayleigh 分布のノイズ bin は深いヌル（dB で -60 以下）を頻繁に含み、
    // dB 領域の算術平均はそれに引きずられてフレーム間で ±9dB 揺れる
    // （実測 p2p 17.4dB — ノイズだけで ready 判定を突破していた）。
    // パワー領域の平均なら支配的な bin が代表し、揺れは数 dB に収まる。
    const meanDb = ([lo, hi]: [number, number]) => {
      let sum = 0;
      for (let i = lo; i <= hi; i++) {
        const db = Math.max(SILENCE_DB, spectrumDb[i]);
        sum += 10 ** (db / 10);
      }
      return 10 * Math.log10(sum / (hi - lo + 1));
    };

    // 信号レベル = 対象帯域平均 − 参照帯域平均（dB 差 = SNR）。
    // マイクの絶対音量・OS の AGC は両帯域に等しく掛かるので差分で相殺される。
    const refMean =
      this.refBins.reduce((acc, r) => acc + meanDb(r), 0) / this.refBins.length;
    const level = meanDb(this.targetBins) - refMean;

    // ── トラッカー更新（判定結果に依存しない。依存させるとロックする） ──
    if (Number.isNaN(this.floor)) {
      this.floor = level;
      this.peak = level;
      this.lastTime = time;
    }
    const dt = Math.min(Math.max(0, time - this.lastTime), MAX_DT_SEC);
    this.lastTime = time;

    // 床: 下降は EMA（時定数 FLOOR_FALL_TAU）、上昇はレート制限。
    if (level < this.floor) {
      this.floor += (level - this.floor) * (1 - Math.exp(-dt / FLOOR_FALL_TAU_SEC));
    } else {
      this.floor += Math.min(FLOOR_RISE_DB_PER_SEC * dt, level - this.floor);
    }
    // ピーク: 上昇は EMA（時定数 PEAK_RISE_TAU）、下降はレート制限の減衰。
    if (level > this.peak) {
      this.peak += (level - this.peak) * (1 - Math.exp(-dt / PEAK_RISE_TAU_SEC));
    } else {
      this.peak -= Math.min(PEAK_DECAY_DB_PER_SEC * dt, this.peak - level);
    }

    const span = this.peak - this.floor;
    const ready = span > READY_DB;
    const onThresh = this.floor + Math.max(span * ON_RATIO, ON_MIN_DB);
    const offThresh = this.floor + Math.max(span * OFF_RATIO, OFF_MIN_DB);

    if (!ready) this.on = false;
    else if (!this.on && level > onThresh) this.on = true;
    else if (this.on && level < offThresh) this.on = false;

    return {
      on: this.on,
      snrDb: level - this.floor,
      ready,
      onThreshDb: onThresh - this.floor,
      offThreshDb: offThresh - this.floor,
    };
  }
}
