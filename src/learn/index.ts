// 学習モード（フラッシュカード）の純粋ロジック層のバレルエクスポート。
// UI（app/）はここから import する。DOM・音声・localStorage 副作用は
// storage（localStorage のみ）と UI に隔離し、deck/scheduler は完全に純粋。

export * from "./deck";
export * from "./scheduler";
export * from "./storage";
