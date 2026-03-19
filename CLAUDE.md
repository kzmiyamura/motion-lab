# CLAUDE.md — Motion Lab

このファイルは Claude Code がリポジトリを操作する際の指示書です。

## プロジェクト概要

**Motion Lab** — サルサダンス向けリズムトレーナー PWA

- 本番URL: https://motion-lab-apa.pages.dev/
- デプロイ: `main` ブランチ push → Cloudflare Pages 自動ビルド

## 権限

Claude はこのリポジトリのコードを自由に読み書き・修正してよい。
コミット・プッシュも許可する。

## 技術スタック

- React 19 / TypeScript 5.9 / Vite 7
- PWA: vite-plugin-pwa + Workbox (`skipWaiting: true`, `clientsClaim: true`)
- テスト: Vitest 4 + jsdom（`npm test`）
- ビルド: `npm run build`

## 開発ルール

- 変更後は必ず `npm test -- --run` と `npm run build` で確認してからコミットする
- `vi.runAllTimersAsync()` は使わない（setInterval 無限ループ）→ `vi.advanceTimersByTimeAsync(100)` を使う
- コミットメッセージは日本語 or 英語どちらでもよい

## 主要ファイル

| パス | 役割 |
|------|------|
| `src/engine/AudioEngine.ts` | Web Audio API スケジューラ（シングルトン） |
| `src/hooks/useAudioEngine.ts` | React フック（エンジンラッパー） |
| `src/hooks/useInstallPrompt.ts` | PWA インストール誘導（iOS/Android 判定） |
| `src/hooks/usePoseEstimation.ts` | MediaPipe Pose による骨格推定フック |
| `src/components/FilePlayer.tsx` | ローカル動画プレイヤー（骨格オーバーレイ含む） |
| `src/components/` | UI コンポーネント + CSS Modules |
| `vite.config.ts` | Vite + PWA 設定 |
| `wrangler.toml` | Cloudflare Pages 設定 |

## MediaPipe Pose 実装メモ

- **対象**: `FilePlayer.tsx`（ローカル動画）のみ。YouTube は CORS 制約で対象外
- **モデル**: `modelComplexity: 0`（Lite）、モデルファイルは CDN（jsdelivr）から動的ロード
- **Canvas**: `<video>` 直上・`pointer-events: none`・同じ CSS transform（mirror/zoom）を同期
- **letterbox 補正**: `object-fit: contain` のオフセットを計算して landmark 座標をマッピング
- **パフォーマンス**: RAF ループで 1 フレームずつ処理（`processing` フラグで詰まり防止）
- **クリーンアップ**: `pose.close()` でアンマウント時にメモリ解放
