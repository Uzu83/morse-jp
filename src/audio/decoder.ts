// マイク入力からモールス符号を復号する。
//
// 流れ: マイク → AnalyserNode で対象周波数帯のエネルギーを監視 →
// ヒステリシス付きしきい値で ON/OFF 判定 → ON/OFF の継続時間から
// 短点/長点・符号内間/文字間/語間を分類 → モールス文字列を組み立てる。
//
// dit 長は観測した最短 ON パルスから適応推定するので、送信速度が未知でも追従する。

export interface ListenOptions {
  /** 対象トーン周波数の中心（Hz）。既定 600。 */
  freq?: number;
  /** 部分的なモールス文字列が更新されるたびに呼ばれる。 */
  onMorse?: (morse: string) => void;
}

export class MorseListener {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private raf = 0;
  private analyser?: AnalyserNode;

  private on = false;
  private lastChange = 0;
  private unit = 0.08; // dit 長の推定（秒）。観測で更新。
  private morse = "";
  private pendingLetterGap = false;

  constructor(private opts: ListenOptions = {}) {}

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.1;
    src.connect(analyser);
    this.analyser = analyser;
    this.lastChange = this.ctx.currentTime;
    this.loop();
  }

  stop(): string {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    return this.morse;
  }

  /** 対象周波数帯のエネルギーを取り、しきい値で ON/OFF を判定する。 */
  private loop = () => {
    const analyser = this.analyser!;
    const ctx = this.ctx!;
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);

    const freq = this.opts.freq ?? 600;
    const nyquist = ctx.sampleRate / 2;
    const binHz = nyquist / bins.length;
    const center = Math.round(freq / binHz);
    const half = Math.max(1, Math.round(80 / binHz)); // ±80Hz 帯

    let energy = 0;
    let count = 0;
    for (let i = center - half; i <= center + half; i++) {
      if (i >= 0 && i < bins.length) {
        energy += bins[i];
        count++;
      }
    }
    const level = count ? energy / count / 255 : 0;

    // ヒステリシス: 立ち上がり 0.35、立ち下がり 0.20。
    const now = ctx.currentTime;
    if (!this.on && level > 0.35) this.transition(true, now);
    else if (this.on && level < 0.2) this.transition(false, now);
    else this.checkGap(now);

    this.raf = requestAnimationFrame(this.loop);
  };

  /** ON↔OFF が切り替わった瞬間に、直前区間の長さを分類する。 */
  private transition(toOn: boolean, now: number) {
    const dur = now - this.lastChange;
    this.lastChange = now;

    if (toOn) {
      // 直前は OFF（無音）区間 → 間の種類を判定。
      if (dur > this.unit * 5) {
        this.morse += " / "; // 語間
        this.pendingLetterGap = false;
      } else if (dur > this.unit * 2) {
        this.morse += " "; // 文字間
        this.pendingLetterGap = false;
      }
      this.on = true;
    } else {
      // 直前は ON（トーン）区間 → 短点/長点を判定。
      const isDash = dur > this.unit * 2;
      if (!isDash) {
        // 短点で dit 推定を更新（移動平均）。
        this.unit = this.unit * 0.7 + dur * 0.3;
      }
      this.morse += isDash ? "-" : ".";
      this.on = false;
      this.pendingLetterGap = true;
      this.emit();
    }
  }

  /** 送信が途切れたまま十分な無音が続いたら、文字/語の区切りを補う。 */
  private checkGap(now: number) {
    if (this.on || !this.pendingLetterGap) return;
    const gap = now - this.lastChange;
    if (gap > this.unit * 5) {
      this.morse += " / ";
      this.pendingLetterGap = false;
      this.emit();
    } else if (gap > this.unit * 2 && !this.morse.endsWith(" ")) {
      this.morse += " ";
      this.emit();
    }
  }

  private emit() {
    this.opts.onMorse?.(this.morse.trim());
  }
}
