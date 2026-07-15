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
$("listen").addEventListener("click", async () => {
  if (listener) return;
  listenHint.textContent = "受信中…";
  listener = new MorseListener({
    freq: Number(freq.value),
    onMorse: (m) => {
      morseIn.value = toDisplay(m);
      refreshDecode();
    },
  });
  try {
    await listener.start();
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
});

// 初期表示
refreshEncode();
refreshDecode();
