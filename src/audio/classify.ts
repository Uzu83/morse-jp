// PulseClassifier — ON/OFF 遷移列からモールス文字列を組み立てる純粋クラス。
//
// AudioContext 非依存（入力は遷移と timestamp のみ）。旧実装（decoder.ts 内の
// 逐次確定ロジック）を置き換える（2026-07-15 codex レビューで確定した欠陥への対応）。
//
// ── 中心設計:「逐次確定」ではなく「履歴の再分類」（変更する前に読むこと） ──
//
// 旧実装はパルスを受けた瞬間に ./- や語間を確定していた。この方式には
// 構造的な欠陥が 4 つある（codex レビューで確定）:
//   a. 初手が長点だと初期 unit のまま誤分類が続く（単発パルスは原理的に長短を
//      識別できないのに、その場で確定してしまう）
//   b. いったん出力した語間・文字間を後から訂正できない
//   c. グリッチ併合は「未来の区間」を見ないと確定できないのに、見る前に確定する
//   d. 先頭の無音が偽の区切りとして出力される
// 本クラスは生の遷移履歴だけを保持し、read()/flush() のたびに履歴全体を
// 最新の unit 推定で分類し直す。UI 側（main.ts）は毎回全文を置き換えるため、
// 遡及訂正と表示が整合する。この前提を崩す（差分出力にする等）変更をしないこと。
//
// ── サポート範囲（README にも記載。逸脱は仕様外） ──
// ・公称 5〜20 WPM（unit 60〜240ms）の一定速度送信（±20% 程度の揺らぎまで）。
//   きれいな信号なら 25 WPM 程度まで動くが保証しない
// ・速度が途中で大きく変わる送信（区間別 unit 推定）は将来課題
// ・上限 20 WPM の根拠（緩めるときは全部を再検討すること）:
//   60fps サンプリングでは 1 フレーム（16.7ms）の検出反転と「高速の短点」が
//   持続時間だけでは原理的に分離できない。さらに検出エッジの非対称で ON は
//   最大 ~20ms 縮んで観測される（下のバイアス補正の説明を参照）。
//   「観測される短点 ≥ 2 フレーム」を保証するには unit − 20ms ≥ 33ms、
//   つまり unit ≥ 53ms（≈ 22 WPM）が必要 — 余裕を見て公称 20 WPM とした。
//   1 フレーム反転の除去は最終的に二段目（0.35×unit ≥ 21ms > 16.7ms）が保証する。
//   一段目（最短有意セグメント×0.35）はバイアスで縮んだ観測では 14ms まで下がりうるが、
//   その場合も 25ms トリムと中央値の頑健性が unit 推定を守り、二段目で除去される

/** read()/flush() の結果。 */
export interface ClassifyResult {
  /** 分類済みモールス文字列（"." "-" " " " / "）。 */
  morse: string;
  /**
   * 推定 dit 長（秒）。短点・長点の両クラスタが確定するまでは null。
   * null の間の morse は暫定（後続の入力で遡及訂正されうる）。UI は「測定中」を表示する。
   * 暫定でも出力する理由: 単発 "E"（短点 1 つ）が何も表示されないのは受信デモとして
   * 成立しない（codex レビュー 3 巡目で「暫定表示 + WPM 測定中」の組で合意）。
   */
  unit: number | null;
}

interface Segment {
  on: boolean;
  dur: number;
}

// ── 分類境界（標準比率 短点1 : 長点3 : 符号内間1 : 文字間3 : 語間7 の中点） ──
// 2×unit は 1 と 3 の、5×unit は 3 と 7 の中点。ちょうど境界値のケースは
// テストで固定してある（>= ではなく > を使う根拠もテストが持つ）。
const DASH_BOUNDARY = 2;
const WORD_BOUNDARY = 5;

// unit 推定に使う既定値（18 WPM 相当）。両クラスタもモデルスコアも使えない
// 最終フォールバック専用。判定の初期値としては使わない（旧実装の欠陥 a の原因）。
const DEFAULT_UNIT = 1.2 / 18;

// サポートする unit の範囲（30 WPM = 40ms 〜 5 WPM = 240ms。公称上限 20 WPM に
// 判定余裕を足した値 — 境界ぴったりだとジッターで正当な解釈を弾く）。
// 単一クラスタ時のモデル選択（短点解釈 vs 長点解釈）の妥当性判定に使う。
const UNIT_MIN = 1.2 / 30;
const UNIT_MAX = 1.2 / 5;

// unit 推定の入力から外れ値として捨てる下限（25ms ≈ rAF 1.5 フレーム）。
// 注意: セグメント列からの削除ではない（推定入力からの除外のみ）。
// 固定しきい値でセグメントを削除すると 40 WPM の正規短点（観測 16.7ms になりうる）を
// 消してしまう（codex レビュー 3 巡目 high 指摘）。実セグメントの併合は
// unit 確定後の相対しきい値でのみ行う。
const ESTIMATE_TRIM_SEC = 0.025;
// 相対グリッチしきい値: 0.35×unit 未満の ON/OFF は検出揺れとして併合する。
// 正規の最短要素は 1×unit なので 0.35 は十分な余裕を持って正規要素を残す。
const GLITCH_RATIO = 0.35;

// 履歴上限（遷移数）。60fps × 数十分でも遷移はこの桁に届かないが、
// 万一の暴走（検出器チャタリング等）でメモリと再分類コストが線形に伸び続けるのを
// 止める安全弁。超過時は先頭（最古）から捨てる = 古い受信内容が画面から消える。
const MAX_TRANSITIONS = 4000;

export class PulseClassifier {
  /** 遷移履歴。transitions[i] は「時刻 time に状態が on になった」。 */
  private transitions: Array<{ on: boolean; time: number }> = [];

  /** 状態遷移を記録する。同状態の連続 push は無視（呼び出し側を単純に保つ）。 */
  push(on: boolean, time: number): void {
    const last = this.transitions[this.transitions.length - 1];
    if (last && last.on === on) return;
    this.transitions.push({ on, time });
    if (this.transitions.length > MAX_TRANSITIONS) {
      // OFF 遷移境界まで落とすと状態整合の管理が増えるだけなので、単純に先頭を捨て、
      // 先頭が OFF 遷移になるよう 2 件単位で維持する。
      this.transitions.splice(0, 2);
    }
  }

  /**
   * 現時点の分類結果を返す。
   * - 進行中の ON は「まだ長さが確定していない」ので含めない
   * - 現在 OFF のときだけ、最後の遷移から now までを仮想 OFF として付加する
   *   （無音継続中に文字間 → 語間へ表示が育つ。ON 中に仮想 OFF を足すと送信中に
   *   偽の区切りが出る — codex レビュー 3 巡目 med 指摘で契約を固定）
   */
  read(now: number): ClassifyResult {
    return classify(this.buildSegments(now, /* finalizeOn */ false));
  }

  /**
   * 進行中の ON を time で打ち切って確定し、最終結果を返す（停止ボタン用）。
   * 旧実装は停止時に進行中の符号を捨てていた（codex レビュー med 指摘）。
   */
  flush(time: number): ClassifyResult {
    return classify(this.buildSegments(time, /* finalizeOn */ true));
  }

  /** 遷移履歴を (on, dur) のセグメント列へ展開する。 */
  private buildSegments(now: number, finalizeOn: boolean): Segment[] {
    const segs: Segment[] = [];
    const ts = this.transitions;
    for (let i = 0; i < ts.length; i++) {
      const end = i + 1 < ts.length ? ts[i + 1].time : now;
      const dur = end - ts[i].time;
      const inProgress = i + 1 >= ts.length;
      if (inProgress && ts[i].on && !finalizeOn) break; // 進行中 ON は未確定
      if (dur <= 0) continue;
      segs.push({ on: ts[i].on, dur });
    }
    return segs;
  }
}

// ────────────────────────────────────────────────────────────────
// 以下、分類パス本体（クラス外の純粋関数。テストは公開 API 経由で行う）
// ────────────────────────────────────────────────────────────────

function classify(raw: Segment[]): ClassifyResult {
  // 1. 先頭の OFF（マイク開始〜最初のトーンまでの無音）は常に捨てる。
  //    旧実装はこれを文字間・語間として出力していた（codex レビュー med 指摘）。
  let segs = raw.slice();
  while (segs.length && !segs[0].on) segs.shift();
  if (segs.length === 0) return { morse: "", unit: null };

  // 2. 一段目のグリッチ併合。しきい値は「25ms 以上の最短セグメント（ON/OFF 両方）」から取る。
  //    unit 推定→併合→再推定という素直な二段は、長点が瞬断で 1.5u×2 に割れた
  //    ケースで一段目の推定自体が壊れて回復しない（クラスタが [1u,1.5u,1.5u] に
  //    汚染され、モデルスコアリングが誤った側を選ぶ — テストで実際に踏んだ）。
  //    モールスの最短実要素は ON でも OFF でも 1 unit なので、有意な最短セグメントは
  //    「1 unit そのもの」か「それより長い何か」— その 0.35 倍は常に
  //    『実要素は消さず、フレーム 1 個分の反転は消える』側に落ちる。
  //    ON だけから取ってはいけない: 長点しか無い履歴では最短 ON = 3u になり、
  //    しきい値 1.05u が実在の符号内間（1u の OFF）を丸ごと併合してしまう。
  const durs = segs.map((s) => s.dur);
  const significant = durs.filter((d) => d >= ESTIMATE_TRIM_SEC);
  const minSeg = Math.min(...(significant.length ? significant : durs));
  segs = mergeGlitches(segs, Math.min(minSeg, UNIT_MAX));

  // 3. cleaned 列で unit + バイアスを推定 → 相対しきい値でもう一度だけ併合 → 最終分類。
  //    再帰させない根拠: グリッチは希少事象で、クラスタ代表値に中央値を使っている
  //    ため 1〜2 パスの除去で推定は十分安定する。
  let est = estimateUnit(segs);
  const merged = mergeGlitches(segs, est.unit);
  if (merged.length !== segs.length) {
    segs = merged;
    est = estimateUnit(segs);
  }

  // ── バイアス補正について（消さないこと。統合テストの失敗から得た知見） ──
  // 検出器の立ち上がり/立ち下がりの非対称で、ON は一律 δ 縮み OFF は同量 δ 伸びる
  // （時間の合計は保存される。実測: FFT 窓 43ms の検出で ON −20ms / OFF +20ms）。
  // 単一 unit で OFF を分類すると、この δ だけで符号内間(1u+δ)が文字間境界(2u)を
  // 越えて全部の文字がバラバラになる。幸い両クラスタが立てば
  //   短点 = u+δ_on, 長点 = 3u+δ_on（δ_on は ON 側バイアス = −δ）
  // の連立から u = (長−短)/2, δ_on = 短 − u が解けるので、ON は −δ_on、
  // OFF は +δ_on を補正してから境界と比べる。
  let morse = "";
  for (const s of segs) {
    if (s.on) {
      morse += s.dur - est.bias < est.unit * DASH_BOUNDARY ? "." : "-";
    } else {
      const units = (s.dur + est.bias) / est.unit;
      if (units >= WORD_BOUNDARY) morse += " / ";
      else if (units >= DASH_BOUNDARY) morse += " ";
      // < 2 unit は符号内の間 → 区切りなし
    }
  }
  // 末尾が仮想 OFF 由来の区切りで終わるのは正常（無音継続中の表示）。trim して返す。
  return { morse: morse.replace(/\s+$/, ""), unit: est.confident ? est.unit : null };
}

interface UnitEstimate {
  /** 推定 dit 長（秒）。バイアス除去済みの「真の」unit。常に有限値。 */
  unit: number;
  /** ON 側の測定バイアス（秒）。ON は unit×n + bias、OFF は unit×n − bias と観測される。 */
  bias: number;
  /** 両クラスタが確定したか（= read() が unit を非 null で返してよいか）。 */
  confident: boolean;
}

/**
 * ON 長のクラスタリングで unit と測定バイアスを推定する。
 * - 両クラスタあり → u = (長中央値 − 短中央値) / 2, bias = 短中央値 − u（confident）
 * - 単一クラスタ → OFF 長によるモデルスコアリングで「全部短点」「全部長点」を選ぶ
 *   （confident=false・bias=0。単発パルスの長短は原理的に識別不能なため）
 */
function estimateUnit(segs: Segment[]): UnitEstimate {
  // 25ms 未満の ON は推定入力から外す（グリッチがクラスタを作るのを防ぐ）。
  // ただし短い ON しか無い場合（40 WPM の正規短点が 1 フレームに量子化された等）は
  // 全 ON を使う — 全部捨てると推定不能になるため。
  const allOns = segs.filter((s) => s.on).map((s) => s.dur);
  if (allOns.length === 0) return { unit: DEFAULT_UNIT, bias: 0, confident: false };
  const trimmed = allOns.filter((d) => d >= ESTIMATE_TRIM_SEC);
  const ons = trimmed.length >= 3 ? trimmed : allOns;

  const clusters = twoMeans(ons);
  if (clusters) {
    const unit = (clusters.longMedian - clusters.shortMedian) / 2;
    // バイアスの上限は ±0.75u。それを超える値が出るのはクラスタ比 1.8 付近の
    // ジッター起因で、実バイアスなら符号内間が潰れて先に併合されているはず。
    const bias = Math.max(
      -0.75 * unit,
      Math.min(0.75 * unit, clusters.shortMedian - unit)
    );
    return { unit, bias, confident: true };
  }

  // ── 単一クラスタ: OFF 長の説明力で候補モデルを選ぶ（codex レビュー対案を採用） ──
  // 候補 A「全部短点」: unit = ON 中央値。候補 B「全部長点」: unit = ON 中央値 / 3。
  // バイアスは連立が組めないため 0 と仮定する（どうせ暫定 = 遡及訂正される）。
  const onMedian = median(ons);
  const offs = segs.filter((s) => !s.on).map((s) => s.dur);
  const candidates = [onMedian, onMedian / 3];
  if (offs.length > 0) {
    // 各 OFF が 1u/3u/7u のどれかにどれだけ近いかの平均誤差が小さい候補を採る。
    const score = (u: number) =>
      offs.reduce((acc, d) => {
        const errs = [1, 3, 7].map((m) => Math.abs(d / u - m) / m);
        return acc + Math.min(...errs);
      }, 0) / offs.length;
    const [a, b] = candidates.map(score);
    if (a !== b) {
      return {
        unit: a < b ? candidates[0] : candidates[1],
        bias: 0,
        confident: false,
      };
    }
  }
  // OFF が無い（単発パルス）か同点: WPM 範囲 5〜40 に収まる解釈を優先。
  // 両方収まるなら短点解釈（"E" "I" "S" など短点始まりの送信が現実に多く、
  // 誤っても後続入力で遡及訂正される）。
  const fitsA = candidates[0] >= UNIT_MIN && candidates[0] <= UNIT_MAX;
  const fitsB = candidates[1] >= UNIT_MIN && candidates[1] <= UNIT_MAX;
  if (fitsA) return { unit: candidates[0], bias: 0, confident: false };
  if (fitsB) return { unit: candidates[1], bias: 0, confident: false };
  return { unit: DEFAULT_UNIT, bias: 0, confident: false };
}

/**
 * 決定論的 2-means（1 次元）。
 * 仕様（codex レビュー 2 巡目 med 指摘で固定）:
 * 初期値 = min/max、反復 ≤ 10、代表値 = 各クラスタの中央値（外れ値耐性）、
 * 有効条件 = 各クラスタ ≥2 標本（総数 <4 のときは ≥1）かつ 代表値比 ≥ 1.8。
 * 無効なら null（単一クラスタ扱い）。
 */
function twoMeans(
  values: number[]
): { shortMedian: number; longMedian: number } | null {
  if (values.length < 2) return null;
  let c1 = Math.min(...values);
  let c2 = Math.max(...values);
  let g1: number[] = [];
  let g2: number[] = [];
  for (let iter = 0; iter < 10; iter++) {
    g1 = [];
    g2 = [];
    for (const v of values) {
      (Math.abs(v - c1) <= Math.abs(v - c2) ? g1 : g2).push(v);
    }
    const n1 = g1.length ? g1.reduce((a, b) => a + b, 0) / g1.length : c1;
    const n2 = g2.length ? g2.reduce((a, b) => a + b, 0) / g2.length : c2;
    if (n1 === c1 && n2 === c2) break;
    c1 = n1;
    c2 = n2;
  }
  const minSamples = values.length < 4 ? 1 : 2;
  if (g1.length < minSamples || g2.length < minSamples) return null;
  const shortMedian = median(g1);
  const longMedian = median(g2);
  // 長短比 1.8 未満は「同じ長さの揺らぎ」とみなす（標準比は 3。ジッターを見込んで
  // 1.8 まで許容するが、それ未満を別クラスタ扱いすると単一速度の揺らぎを
  // 短点/長点に割ってしまう）。
  if (longMedian / shortMedian < 1.8) return null;
  return { shortMedian, longMedian };
}

/**
 * 相対しきい値（GLITCH_RATIO × unit）未満の ON/OFF を併合する。
 * - 短 ON（スパイク）: 捨てて前後の OFF を 1 つに繋ぐ
 * - 短 OFF（トーン中の瞬断）: 前後の ON を 1 つに繋ぐ
 * 履歴全体を毎回作り直すので「確定後の取り消し」問題は起きない。
 */
function mergeGlitches(segs: Segment[], unit: number): Segment[] {
  const limit = unit * GLITCH_RATIO;
  const out: Segment[] = [];
  for (const seg of segs) {
    const prev = out[out.length - 1];
    const isGlitch = seg.dur < limit && out.length > 0;
    if (isGlitch && prev.on !== seg.on) {
      // グリッチは直前セグメントに吸収（時間は保存し、種別は直前に従う）。
      prev.dur += seg.dur;
      continue;
    }
    if (prev && prev.on === seg.on) {
      // 直前がグリッチ吸収済みで同種が連続したら繋ぐ。
      prev.dur += seg.dur;
      continue;
    }
    out.push({ ...seg });
  }
  // 先頭に回り込んだ OFF（グリッチ削除で先頭が OFF になった場合）を再度除去。
  while (out.length && !out[0].on) out.shift();
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
