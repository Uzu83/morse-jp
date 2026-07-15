// モールス符号を WebAudio でビープ音として再生する。
// タイミングは標準比率: 短点=1, 長点=3, 符号内間=1, 文字間=3, 語間=7（単位: dit）。

export interface PlayOptions {
  /** 速度（WPM）。dit 長 = 1200 / wpm ミリ秒。 */
  wpm?: number;
  /** トーン周波数（Hz）。 */
  freq?: number;
  /** 中断用シグナル。 */
  signal?: AbortSignal;
}

/**
 * "." "-" と空白・"/" からなるモールス文字列を再生する。
 * Promise は再生完了（または中断）で解決する。
 */
export async function playMorse(
  morse: string,
  { wpm = 18, freq = 600, signal }: PlayOptions = {}
): Promise<void> {
  const unit = 1.2 / wpm; // 秒
  const ctx = new (window.AudioContext ||
    (window as any).webkitAudioContext)();
  await ctx.resume();

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  osc.connect(gain);
  osc.start();

  let t = ctx.currentTime + 0.05;
  const ramp = Math.min(0.005, unit * 0.15); // クリック音を抑える立ち上がり

  const beep = (durUnits: number) => {
    const on = t;
    const off = t + durUnits * unit;
    gain.gain.setValueAtTime(0, on - ramp);
    gain.gain.linearRampToValueAtTime(0.25, on);
    gain.gain.setValueAtTime(0.25, off - ramp);
    gain.gain.linearRampToValueAtTime(0, off);
    t = off;
  };
  const silence = (durUnits: number) => {
    t += durUnits * unit;
  };

  for (let i = 0; i < morse.length; i++) {
    const c = morse[i];
    if (c === ".") {
      beep(1);
      silence(1); // 符号内間
    } else if (c === "-") {
      beep(3);
      silence(1);
    } else if (c === " ") {
      silence(2); // 直前の符号内間(1) と合わせて文字間 3
    } else if (c === "/") {
      silence(4); // 語間 7（前後の間と合わせて）
    }
  }

  const totalMs = (t - ctx.currentTime) * 1000;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        osc.stop();
        ctx.close();
      } catch {
        /* noop */
      }
      resolve();
    };
    const timer = setTimeout(finish, totalMs + 100);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
