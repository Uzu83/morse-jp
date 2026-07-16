import "./style.css";

import { decode } from "../morse/decode";
import { encode, Mode } from "../morse/encode";
import { toDisplay } from "../morse/index";
import { playMorse } from "../audio/player";
import { MorseListener } from "../audio/decoder";
import {
  INITIAL_SESSION,
  advanceSession,
  applyResult,
  buildDeck,
  isUnlockReady,
  load,
  makeChoices,
  noteMiss,
  pickNext,
  save,
  unlockNext,
} from "../learn";
import type { Card, DeckProgress, Session } from "../learn";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let mode: Mode = "wabun";
let playAbort: AbortController | null = null;
let listener: MorseListener | null = null;

// ── モード切替 ──────────────────────────────
const modeBox = $("mode");
modeBox.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode as Mode;
    modeBox.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b === btn);
      // 選択状態は色だけでなく支援技術にも伝える（activity / learn-dir と同じ作法。
      // 学習ではこの切替がデッキ・出題・保存先まで変えるので状態の可視化は必須）
      b.setAttribute("aria-pressed", String(b === btn));
    });
    refreshEncode();
    refreshDecode();
    // 和文/欧文は学習ではデッキ切替も兼ねる。デッキが変われば出題中の札は無効なので
    // 捨てる（学習中なら即出し直し、変換中なら次に学習を開いたときに作られる）。
    question = null;
    if (activity === "learn") startLearn();
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
const light = $("light");
const flashOpt = $<HTMLInputElement>("flash-opt");
const vibeOpt = $<HTMLInputElement>("vibe-opt");
// Vibration API 非対応（iOS Safari 等）はチェックボックスごと無効化して理由を示す
if (!("vibrate" in navigator)) {
  vibeOpt.disabled = true;
  $("vibe-label").classList.add("unsupported");
  $("vibe-label").title = "この端末・ブラウザはバイブレーション非対応です";
}

// スライダー表示。速度・音程は変換と学習で共有する（同じ耳で聞くものを
// 2 組の設定に分けない）。学習側の再生も下の startPlayback 経由でこの値を読む。
const wpm = $<HTMLInputElement>("wpm");
const freq = $<HTMLInputElement>("freq");
wpm.addEventListener("input", () => ($("wpm-val").textContent = wpm.value));
freq.addEventListener("input", () => ($("freq-val").textContent = freq.value));

// セッション所有権トークン。旧セッションの後始末（abort listener・完了処理・
// エラー処理）が新セッションの点灯を上書きしないよう、光の操作は
// 「自分が最新のセッションであるときだけ」許す（ゲート2レビューで固定した競合防御）。
let playSession = 0;

/**
 * 再生セッションを 1 本だけ立てる。変換・学習の両方がここを通る。
 *
 * 共有する理由: playMorse は音・光・バイブの全出力を単一セッションが所有する設計
 * （player.ts の設計判断 1）。変換と学習が別々に AbortController を持つと、
 * 一方の再生中に他方が鳴らせてしまい所有権が壊れる。playAbort / playSession を
 * 1 組に保つことで「新しい再生は必ず古い再生を畳んでから始まる」が保たれる。
 *
 * lightEl だけは呼び出し側から渡す — 変換パネルと学習パネルは互いに非表示になるため、
 * 見えている側の光インジケータを点ける必要がある（所有権トークンの守り方は同じ）。
 */
async function startPlayback(morse: string, lightEl: HTMLElement) {
  playAbort?.abort();
  playAbort = new AbortController();
  const session = ++playSession;
  try {
    await playMorse(morse, {
      wpm: Number(wpm.value),
      freq: Number(freq.value),
      signal: playAbort.signal,
      onLight: flashOpt.checked
        ? (on) => {
            if (session === playSession) lightEl.classList.toggle("lit", on);
          }
        : undefined,
      vibrate: vibeOpt.checked,
    });
  } catch (e) {
    // 受入条件: エラーでも消灯（自分が最新セッションの場合のみ）
    if (session === playSession) lightEl.classList.remove("lit");
    console.error(e);
  }
}

$("play").addEventListener("click", () => {
  const { morse } = encode(textIn.value, mode);
  if (!morse) return;
  void startPlayback(morse, light);
});
$("stop-play").addEventListener("click", () => playAbort?.abort());

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
  const l = new MorseListener({
    freq: Number(freq.value),
    onMorse: (m) => {
      morseIn.value = toDisplay(m);
      refreshDecode();
    },
    onStatus: renderStatus,
  });
  listener = l;
  try {
    await l.start();
    // start() の getUserMedia 待ちの間に停止ボタンや学習への切替で stopListening()
    // が走っていると、listener は差し替わっている（null か新セッション）。その場合
    // ここで開いたばかりのマイクを即座に畳む — stopListening() は stream 取得前の
    // listener に対しては何も止められないため、待ち明けのここで畳むしかない
    // （ゲート2レビュー指摘: 放置すると参照を失った録音セッションが残り続ける）。
    if (listener !== l) {
      l.stop();
      return;
    }
    meter.hidden = false;
  } catch (e) {
    // 自分が現役のときだけ UI を触る（待機中に停止済みなら、学習画面のヒントを
    // 上書きしたり、後続の新セッションを null で消したりしてはいけない）。
    if (listener === l) {
      listenHint.textContent = "マイクを開始できませんでした";
      listener = null;
    }
    console.error(e);
  }
});
/**
 * マイク受信を畳む。停止ボタンと、学習アクティビティへの切替の両方から呼ぶ
 * （切替でパネルごと隠れると停止ボタンに手が届かなくなるため。無音のまま
 * 録音が続く状態を作らないのが受入条件）。listener が無ければ何もしない。
 */
function stopListening() {
  if (!listener) return;
  listener.stop();
  listener = null;
  listenHint.textContent = "";
  meter.hidden = true;
}
$("stop-listen").addEventListener("click", stopListening);

// ── アクティビティ切替（変換 / 学習）────────
type Activity = "convert" | "learn";

let activity: Activity = "convert";

const activityBox = $("activity");
const learnPanel = $("learn");
const convertPanels = document.querySelectorAll<HTMLElement>('[data-panel="convert"]');

activityBox.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => setActivity(btn.dataset.activity as Activity));
});

/**
 * アクティビティを切り替える。切替は表示/非表示のみ（DOM は破壊しない）。
 *
 * 後始末が要る理由: 隠れたパネルの停止ボタンには手が届かない。出力（音・光・バイブ）と
 * 入力（マイク）を跨いだまま切り替えると、止める手段が画面から消えたまま走り続ける。
 * どちら向きの切替でも再生を abort し、学習へ入るときはマイクも畳む。
 * （逆向き＝学習→変換でマイクを止めないのは、そもそも学習中にマイクを開始できないため）
 */
function setActivity(next: Activity) {
  if (next === activity) return;
  playAbort?.abort();
  if (next === "learn") stopListening();

  activity = next;
  const learning = next === "learn";
  convertPanels.forEach((p) => (p.hidden = learning));
  learnPanel.hidden = !learning;
  activityBox.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    const on = b.dataset.activity === next;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });

  // 出題は学習パネルを実際に開いたときに初めて作る（変換だけ使う利用者に
  // 出題や localStorage 書き込みを一切起こさない）。既に出題中なら引き継ぐ。
  if (learning && !question) startLearn();
}

// ── 学習モード（フラッシュカード）──────────
type Direction = "listen" | "recall";

/** 出題中の 1 問。answered は二重採点の防止も兼ねる。 */
interface Question {
  readonly char: string;
  readonly code: string;
  readonly choices: string[];
  played: boolean;
  revealed: boolean;
  answered: boolean;
  picked: string | null;
}

let direction: Direction = "listen";
let question: Question | null = null;

/**
 * 乱数の注入点はここ 1 箇所だけ。deck/scheduler を純粋（決定的にテスト可能）に
 * 保つため、Math.random に触れてよいのは UI 層のこの境界に限る。
 */
const rng = () => Math.random();

// デッキは静的なので起動時に 1 度だけ構築する（buildDeck は encode 由来で純粋）。
const decks: Record<Mode, Card[]> = {
  wabun: buildDeck("wabun"),
  international: buildDeck("international"),
};

// 永続進捗は起動時に一度読み、以後はこのメモリ上の state を正とする。
// localStorage が使えない環境でも save が黙って no-op になるだけで学習は続く。
let learnState = load();

// セッション（ミスキュー・直前札）はデッキごとに独立。モード切替で別デッキの
// 文字がミスキューに残ると pickNext の前提（解放済み札のみ）が崩れるため。
const sessions: Record<Mode, Session> = {
  wabun: INITIAL_SESSION,
  international: INITIAL_SESSION,
};

const dirBox = $("learn-dir");
const learnStageQ = $("learn-q");
const learnChar = $("learn-char");
const learnCode = $("learn-code");
const learnReveal = $("learn-reveal");
const learnPlay = $("learn-play");
const learnStop = $("learn-stop");
const learnLight = $("learn-light");
const learnChoices = $("learn-choices");
const learnSelf = $("learn-self");
const learnFeedback = $("learn-feedback");
const learnUnlock = $("learn-unlock");
const learnNext = $("learn-next");
const learnProgress = $("learn-progress");

dirBox.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.dir as Direction;
    if (next === direction) return;
    direction = next;
    dirBox.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    // 出題中の札は捨てて出し直す。提示のしかたが変わるだけでなく、
    // 「聞き取りで答えを見てから想起へ逃げる」採点の抜け道も塞ぐ。
    startLearn();
  });
});

/**
 * 1 デッキ分の進捗を差し替える。キーを静的に書き分けているのは、計算キー
 * （{ ...decks, [mode]: p }）では PersistedState の「wabun と international が
 * 必ず揃う」構造を TypeScript が保てないため。型を緩めるより分岐を書くほうが安い。
 */
function setDeckProgress(m: Mode, p: DeckProgress) {
  learnState = {
    ...learnState,
    decks:
      m === "wabun"
        ? { ...learnState.decks, wabun: p }
        : { ...learnState.decks, international: p },
  };
}

/**
 * テキストを「変わったときだけ」書き込む。
 * 同じ文字列の再代入でもテキストノードは置き換わるため、aria-live 領域では
 * 再描画のたびに読み上げが繰り返される（▶ 聞くを押しただけで出題文が読み直される）。
 */
function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

/** 学習を（再）開始する。デッキ切替・方向切替・初回表示の共通入口。 */
function startLearn() {
  nextQuestion(); // 出題のリセット（解放通知・正誤表示のクリアも含む）はここが担う
  renderProgress();
}

/** 次の札を出題する。前問の音は畳む（新しい問題に古い音が被らないように）。 */
function nextQuestion() {
  playAbort?.abort();
  const deck = decks[mode];
  const progress = learnState.decks[mode];
  const char = pickNext(deck, progress, sessions[mode], rng);
  const card = deck.find((c) => c.char === char);
  if (!card) return; // pickNext は deck 由来の文字しか返さない（到達しない保険）
  // 選択肢は解放済み枚数を超えられない（未解放文字を distractor に出さない）
  const unlocked = Math.min(progress.unlockedCount, deck.length);
  const q: Question = {
    char,
    code: card.code,
    choices: makeChoices(deck, progress.unlockedCount, char, rng, Math.min(4, unlocked)),
    played: false,
    revealed: false,
    answered: false,
    picked: null,
  };
  question = q;
  setText(learnFeedback, "");
  learnFeedback.className = "learn-feedback";
  setText(learnUnlock, "");
  buildChoices(q);
  renderQuestion();
}

/** 現在の出題状態を DOM へ反映する（唯一の描画経路）。 */
function renderQuestion() {
  const q = question;
  if (!q) return;
  const listen = direction === "listen";
  const showAnswer = q.revealed || q.answered;

  setText(learnStageQ, listen ? "この符号はどの文字？" : "この文字の符号は？");
  // 聞き取りでは答えが出るまで文字を伏せる。想起では文字が問題そのもの。
  learnChar.hidden = listen && !q.answered;
  setText(learnChar, q.char);
  learnCode.hidden = !showAnswer;
  setText(learnCode, toDisplay(q.code));

  // 想起は答えを見る前に鳴らせない（音は答えそのものなので、聞けたら自己採点が無意味になる）
  learnPlay.hidden = !listen && !showAnswer;
  setText(learnPlay, q.played ? "▶ もう一度聞く" : "▶ 聞く");
  learnReveal.hidden = listen || showAnswer;
  learnSelf.hidden = listen || !q.revealed || q.answered;
  learnChoices.hidden = !listen;
  learnNext.hidden = !q.answered;
  // 聞き取りの次問はクリック起点でそのまま鳴らす（ラベルの ▶ でそれを予告する）
  setText(learnNext, listen ? "次の問題 ▶" : "次の問題 →");

  if (listen) updateChoices(q);
}

/**
 * 選択肢ボタンを組み立てる。1 問につき 1 回だけ（nextQuestion から）。
 *
 * 描画のたびに作り直さない理由: renderQuestion は ▶ 聞く のたびにも走る。
 * そこでボタンを差し替えると、キーボードで選択肢にフォーカスしている利用者の
 * フォーカスが毎回 body へ飛ぶ。状態の変化は updateChoices が現物を書き換える。
 * クリックは #learn-choices への委譲で受けるので、個別の listener は張らない。
 */
function buildChoices(q: Question) {
  learnChoices.replaceChildren(
    ...q.choices.map((c, i) => {
      const b = document.createElement("button");
      b.className = "choice";
      b.dataset.char = c;
      // 数字キーの割当を見た目にも出す（キーボードで回答できることの発見可能性）
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = String(i + 1);
      const mark = document.createElement("span");
      mark.className = "mark";
      b.append(key, document.createTextNode(c), mark);
      return b;
    })
  );
}

/** 回答後の選択肢の状態（無効化・正誤マーク）を現物のボタンへ反映する。 */
function updateChoices(q: Question) {
  learnChoices.querySelectorAll<HTMLButtonElement>("button.choice").forEach((b) => {
    const c = b.dataset.char;
    b.disabled = q.answered;
    const isCorrect = q.answered && c === q.char;
    const isWrong = q.answered && c === q.picked && c !== q.char;
    b.classList.toggle("correct", isCorrect);
    b.classList.toggle("wrong", isWrong);
    // 正誤は記号でも示す（色だけに依存しない。a11y 要件）
    const mark = b.querySelector<HTMLElement>(".mark");
    if (mark) setText(mark, isCorrect ? "○" : isWrong ? "×" : "");
  });
}

/** 進捗表示（解放数 / デッキ総数・正答率）。cards は疎なので値の総和で足りる。 */
function renderProgress() {
  const deck = decks[mode];
  const p = learnState.decks[mode];
  let seen = 0;
  let correct = 0;
  for (const s of Object.values(p.cards)) {
    seen += s.seen;
    correct += s.correct;
  }
  const rate = seen > 0 ? Math.round((correct / seen) * 100) : null;
  learnProgress.textContent =
    `解放 ${p.unlockedCount} / ${deck.length} 文字` +
    (rate === null ? " · 正答率 —" : ` · 正答率 ${rate}%（${correct}/${seen}）`);
}

/** 現在の札を再生する。学習側の光は #learn-light（変換パネルは隠れている）。 */
function playCurrent() {
  const q = question;
  if (!q) return;
  q.played = true;
  renderQuestion();
  void startPlayback(q.code, learnLight);
}

learnPlay.addEventListener("click", playCurrent);
learnStop.addEventListener("click", () => playAbort?.abort());
learnReveal.addEventListener("click", () => {
  if (!question || question.answered) return;
  question.revealed = true;
  renderQuestion();
});
learnNext.addEventListener("click", () => {
  nextQuestion();
  // ボタンクリック＝ユーザー操作なので、聞き取りはそのまま出題音へ繋ぐ。
  // 「自動再生しない」の趣旨は gesture 無しの発音を禁じることで、これは満たす。
  if (direction === "listen") playCurrent();
});

learnChoices.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button.choice");
  const picked = btn?.dataset.char;
  if (!picked || !question) return;
  answer(picked === question.char, picked);
});

learnSelf.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-self]");
  if (!btn) return;
  answer(btn.dataset.self === "1", null);
});

// 数字キー 1-4 で選択肢に回答できる（マウス以外の操作手段。a11y 要件）。
// 入力欄にフォーカスがあるとき・修飾キー併用時はキーを横取りしない。
document.addEventListener("keydown", (e) => {
  if (activity !== "learn" || direction !== "listen") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  const q = question;
  if (!q || q.answered) return;
  const i = Number(e.key) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= q.choices.length) return;
  e.preventDefault();
  answer(q.choices[i] === q.char, q.choices[i]);
});

/**
 * 1 問を採点して進捗へ反映する。
 *
 * 呼び出し順の契約（scheduler.ts）: applyResult → advanceSession →（誤答なら）noteMiss。
 * advanceSession が古い保留を消してから noteMiss が dueIn を貼り直すので、
 * 誤答札は「他の札を 2 問挟んだ直後」に必ず再出題される。
 */
function answer(correct: boolean, picked: string | null) {
  const q = question;
  if (!q || q.answered) return; // 連打・キー重複での二重採点を防ぐ
  q.answered = true;
  q.revealed = true;
  q.picked = picked;

  const deck = decks[mode];
  let progress = applyResult(learnState.decks[mode], q.char, correct);
  let session = advanceSession(sessions[mode], q.char);
  if (!correct) session = noteMiss(session, q.char);
  sessions[mode] = session;

  // 解放は採点後の進捗で判定する（今の正答で条件を満たしたら即座に解放したい）
  let unlockedChar: string | null = null;
  if (isUnlockReady(deck, progress)) {
    const before = progress.unlockedCount;
    progress = unlockNext(deck, progress);
    if (progress.unlockedCount > before) {
      unlockedChar = deck[progress.unlockedCount - 1].char;
    }
  }

  // updatedAt は表示専用。ロジック層は Date に触れない契約なので UI 層で付ける。
  setDeckProgress(mode, { ...progress, updatedAt: Date.now() });
  save(learnState);

  setText(
    learnFeedback,
    correct
      ? `○ 正解 — ${q.char}（${toDisplay(q.code)}）`
      : `× 不正解 — 正解は ${q.char}（${toDisplay(q.code)}）`
  );
  learnFeedback.className = `learn-feedback ${correct ? "ok" : "ng"}`;
  setText(
    learnUnlock,
    unlockedChar ? `🎉 新しい文字「${unlockedChar}」が解放されました` : ""
  );

  renderQuestion();
  renderProgress();
  // 回答した選択肢/自己採点ボタンは disabled か非表示になり、そのままだとフォーカスが
  // body へ落ちてキーボード操作が途切れる。次の操作先へ明示的に渡す。
  learnNext.focus();
}

// 初期表示
refreshEncode();
refreshDecode();
