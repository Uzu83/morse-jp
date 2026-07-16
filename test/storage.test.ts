import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PersistedState,
  STORAGE_KEY,
  StorageLike,
  load,
  save,
} from "../src/learn/storage";

/** テスト用のメモリ内 StorageLike。localStorage を差し替えて副作用を決定的にする。 */
function memStorage(initial?: string): StorageLike {
  let value: string | null = initial ?? null;
  return {
    getItem: (key) => (key === STORAGE_KEY ? value : null),
    setItem: (key, v) => {
      if (key === STORAGE_KEY) value = v;
    },
  };
}

/** setItem が常に throw するストレージ（プライベートブラウズ・容量超過の模擬）。 */
const throwingStorage: StorageLike = {
  getItem: () => null,
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

test("storage: 往復同値（save→load で正規化済み状態が復元される）", () => {
  const mem = memStorage();
  const state: PersistedState = {
    version: 1,
    decks: {
      wabun: { unlockedCount: 5, cards: {} },
      international: {
        unlockedCount: 6,
        cards: { K: { box: 2, seen: 3, correct: 3 } },
      },
    },
  };
  save(state, mem);
  assert.deepEqual(load(mem), state);
});

test("storage: 空（未保存）は既定状態（両デッキ unlockedCount=5・cards 空）", () => {
  const loaded = load(memStorage());
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.decks.wabun, { unlockedCount: 5, cards: {} });
  assert.deepEqual(loaded.decks.international, { unlockedCount: 5, cards: {} });
});

test("storage: 壊れた JSON は全捨てして既定へ", () => {
  const loaded = load(memStorage("{not valid json"));
  assert.deepEqual(loaded.decks.international, { unlockedCount: 5, cards: {} });
  assert.deepEqual(loaded.decks.wabun, { unlockedCount: 5, cards: {} });
});

test("storage: ルートが object でない（配列）も全捨てして既定へ", () => {
  const loaded = load(memStorage("[1,2,3]"));
  assert.deepEqual(loaded.decks.international, { unlockedCount: 5, cards: {} });
});

test("storage: 部分破損は壊れたエントリだけ破棄し他は保持", () => {
  const mem = memStorage(
    JSON.stringify({
      version: 1,
      decks: {
        international: {
          unlockedCount: 7,
          cards: {
            K: { box: 2, seen: 5, correct: 4 }, // 正常 → 保持
            M: { box: 99, seen: 3, correct: 1 }, // box を 4 にクランプして保持
            Z: { box: "x", seen: 3, correct: 1 }, // box が数値でない → 破棄
            "9": { box: 1, seen: 2, correct: 5 }, // correct>seen → 2 に切り詰め
            "😀": { box: 1, seen: 1, correct: 1 }, // デッキに無い文字 → 破棄
            "": { box: 0, seen: 0, correct: 0 }, // 空文字（デッキに無い）→ 破棄
          },
        },
        // wabun 欠損 → そのデッキだけ既定へ
      },
    })
  );
  const loaded = load(mem);
  assert.deepEqual(loaded.decks.international.cards, {
    K: { box: 2, seen: 5, correct: 4 },
    M: { box: 4, seen: 3, correct: 1 },
    "9": { box: 1, seen: 2, correct: 2 },
  });
  assert.equal(loaded.decks.international.unlockedCount, 7);
  assert.deepEqual(loaded.decks.wabun, { unlockedCount: 5, cards: {} });
});

test("storage: box/seen/correct/unlockedCount のクランプ", () => {
  const mem = memStorage(
    JSON.stringify({
      decks: {
        international: {
          unlockedCount: 999, // デッキサイズ(41)へクランプ
          cards: { K: { box: -3, seen: -1, correct: 10 } }, // box→0, seen→0, correct→0
        },
        wabun: {
          unlockedCount: 1, // 下限 INITIAL_UNLOCKED(5)へクランプ
          cards: {},
        },
      },
    })
  );
  const loaded = load(mem);
  assert.equal(loaded.decks.international.unlockedCount, 41);
  assert.deepEqual(loaded.decks.international.cards.K, {
    box: 0,
    seen: 0,
    correct: 0,
  });
  assert.equal(loaded.decks.wabun.unlockedCount, 5);
});

test("storage: unlockedCount が数値でない場合は下限へ", () => {
  const mem = memStorage(
    JSON.stringify({ decks: { international: { unlockedCount: "abc", cards: {} } } })
  );
  assert.equal(load(mem).decks.international.unlockedCount, 5);
});

test("storage: setItem 例外は throw せずメモリ継続を許す", () => {
  const state = load(memStorage());
  assert.doesNotThrow(() => save(state, throwingStorage));
});

test("storage: 明示 null ストレージなら読み書きしても throw しない", () => {
  assert.doesNotThrow(() => {
    const s = load(null);
    save(s, null);
  });
  // null 指定でも load は既定状態を返す。
  assert.deepEqual(load(null).decks.wabun, { unlockedCount: 5, cards: {} });
});
