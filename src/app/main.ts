import "./style.css";

import { decode } from "../morse/decode";
import { encode, Mode } from "../morse/encode";
import { toDisplay } from "../morse/index";
import { playMorse } from "../audio/player";
import { MorseListener } from "../audio/decoder";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let mode: Mode = "wabun";
let playAbort: AbortController | null = null;
let listener: MorseListener | null = null;

// ── モード切替 ──────────────────────────────
const modeBox = $("mode");
modeBox.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode as Mode;
    modeBox
      .querySelectorAll("button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    refreshEncode();
    refreshDecode();
  });
});

// ── テキスト → モールス ─────────────────────
const textIn = $<HTMLTextAreaElement>("text-in");
const morseOut = $("morse-out");
const skipped = $("skipped");

function refreshEncode() {
  const { morse, skipped: skip } = encode(textIn.value, mode);
  morseOut.textContent = toDisplay(morse);
  skipped.textContent = skip.length
    ? `対応外でスキップ: ${[...new Set(skip)].join(" ")}`
    : "";
}
textIn.addEventListener("input", refreshEncode);

// 再生
$("play").addEventListener("click", async () => {
  const { morse } = encode(textIn.value, mode);
  if (!morse) return;
  playAbort?.abort();
  playAbort = new AbortController();
  const wpm = Number($<HTMLInputElement>("wpm").value);
  const freq = Number($<HTMLInputElement>("freq").value);
  try {
    await playMorse(morse, { wpm, freq, signal: playAbort.signal });
  } catch (e) {
    console.error(e);
  }
});
$("stop-play").addEventListener("click", () => playAbort?.abort());

// スライダー表示
const wpm = $<HTMLInputElement>("wpm");
const freq = $<HTMLInputElement>("freq");
wpm.addEventListener("input", () => ($("wpm-val").textContent = wpm.value));
freq.addEventListener("input", () => ($("freq-val").textContent = freq.value));

// ── モールス → テキスト ─────────────────────
const morseIn = $<HTMLTextAreaElement>("morse-in");
const textOut = $("text-out");

function refreshDecode() {
  textOut.textContent = decode(morseIn.value, mode);
}
morseIn.addEventListener("input", refreshDecode);

// マイク受信
const listenHint = $("listen-hint");
const meter = $("meter");
const meterBar = $("meter-bar");
const meterMark = $("meter-mark");

// メーターの表示レンジ（dB）。SNR 0〜30dB を幅 0〜100% にマップする。
// 30dB = 静かな室内でスピーカー音を拾ったときの典型的な上限。これ以上は飽和表示でよい。
const METER_RANGE_DB = 30;

function renderStatus(s: import("../audio/decoder").ListenStatus) {
  const pct = (db: number) =>
    `${Math.max(0, Math.min(100, (db / METER_RANGE_DB) * 100))}%`;
  meterBar.style.width = pct(s.snrDb);
  meterBar.classList.toggle("on", s.on);
  // マーカーは ON しきい値（「ここを超えれば発火する」が受信者の知りたい情報。
  // OFF しきい値でないのは codex レビューで固定した仕様）。
  meterMark.style.left = pct(s.onThreshDb);
  meterMark.style.display = s.ready ? "" : "none";
  listenHint.textContent = !s.ready
    ? "受信中… 信号を探しています"
    : s.wpm === null
      ? "受信中… 速度を測定中"
      : `受信中 · 約 ${s.wpm} WPM`;
}

$("listen").addEventListener("click", async () => {
  if (listener) return;
  listenHint.textContent = "受信中…";
  listener = new MorseListener({
    freq: Number(freq.value),
    onMorse: (m) => {
      morseIn.value = toDisplay(m);
      refreshDecode();
    },
    onStatus: renderStatus,
  });
  try {
    await listener.start();
    meter.hidden = false;
  } catch (e) {
    listenHint.textContent = "マイクを開始できませんでした";
    listener = null;
    console.error(e);
  }
});
$("stop-listen").addEventListener("click", () => {
  if (!listener) return;
  listener.stop();
  listener = null;
  listenHint.textContent = "";
  meter.hidden = true;
});

// 初期表示
refreshEncode();
refreshDecode();
