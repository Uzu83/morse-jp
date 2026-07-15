import { defineConfig } from "vitest/config";

// GitHub Pages で https://<user>.github.io/morse-jp/ に公開するため base を固定。
// 独自ドメインやルート公開時は "/" に変更する。
export default defineConfig({
  base: "/morse-jp/",
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
