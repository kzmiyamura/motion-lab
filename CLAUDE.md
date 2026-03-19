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

## ターゲットロック実装メモ

- **座標変換の注意点**: overlay のタップ座標はビジュアル座標（CSS transform 後）。canvas の描画座標系（transform 前）に逆変換してから `lockAt()` に渡す
  - ミラーなし: `canvasX = cw/2 + (tapX - cw/2 - zoom.x) / zoom.scale`
  - ミラーあり: `canvasX = cw/2 + (-tapX + cw/2 - zoom.x) / zoom.scale`
  - Y 共通: `canvasY = ch/2 + (tapY - ch/2 - zoom.y) / zoom.scale`
- **追跡アルゴリズム**: 速度予測付き Nearest Neighbor — landmark 23/24（Mid-Hip）で距離比較。オクルージョン時は速度ベクトルで最大 12 フレーム位置を予測し、超えたらロック自動解除
- **デバッグ表示**（ロック中のみ）: 赤い点（タップ位置）・青い大きな丸（追跡中の腰）・距離・オクルージョンカウント
- **VizMode**: `off` / `full`（全身33点）/ `salsa`（中心軸＋傾き角度）/ `trail`（足首軌跡）の 4 段階

## 骨格解析機能メモ

- **Salsa_Focus モード**: 垂直中心軸の傾き角度（鼻→腰中点、度数表示）・肩/腰の水平傾き角度をリアルタイム表示。ミラー時は `ctx.scale(-1,1)` でテキストを反転補正
- **Step Trail モード**: 足首（landmark 27/28）の過去 10 フレームの軌跡を描画。左足＝シアン、右足＝オレンジ。全身骨格のゴースト表示と組み合わせ
- **ビートフェーズインジケーター**: BPM + video.currentTime からビート番号（1/8〜8/8）を計算。1, 5 拍目はアクセント（赤）表示。BPM が 0 のときは非表示
- **適応型サンプリング**: 腰の移動量が閾値（0.015 正規化座標）を超えたら 33ms（~30fps）、静止時は 100ms（~10fps）に自動調整。iPhone バッテリー節約

## アーキテクチャ制約メモ

- **OffscreenCanvas + WebWorker 非対応**: MediaPipe tasks-vision の GPU delegate は WebGL を使用。iOS Safari では WebWorker 内で WebGL コンテキスト（OffscreenCanvas）が利用不可のため Worker 移行は困難。代替として適応型サンプリングで対応
- **ステップ種別分類（Basic/Side/SuzyQ/Mambo）非実装**: Lite モデル（modelComplexity:0）の Z 軸は深度推定であり信頼性が低い。正確な分類には Full モデル + ワールド座標が必要（パフォーマンスとトレードオフ）
