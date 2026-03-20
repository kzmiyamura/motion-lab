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
| `src/hooks/usePoseEstimation.ts` | MediaPipe Pose 骨格推定・パターン検出・シーケンス生成フック |
| `src/components/FilePlayer.tsx` | ローカル動画プレイヤー（骨格オーバーレイ・シーケンスビュー含む） |
| `src/components/SequenceView.tsx` | サルサ技シーケンスのタイムライン表示・Markdown エクスポート |
| `src/components/SequenceView.module.css` | SequenceView のスタイル |
| `src/components/` | UI コンポーネント + CSS Modules |
| `docs/salsa-basics.md` | サルサ基礎知識・技仕様・インストラクターチェックポイント |
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

## シーケンス生成機能メモ

- **SequenceEvent**: `{ id, time, action, quality, beatNum? }` で状態管理。`usePoseEstimation` が `sequence: SequenceEvent[]` と `clearSequence()` を返す
- **パターン検出（`runPatternDetection()`）**: RAFループ内で毎フレーム実行。検出種別と判定条件：
  - `Turn`: 肩幅が基準の 40% 未満に縮小 × 4f以上
  - `SideStep`: 足首 X 偏差 > 0.20 × 3f以上
  - `Dip`: 鼻の Y 座標が腰中点 + 0.05 以上（画面下方向）× 5f以上
  - `CBL`: 腰中点の X 移動 > 0.20 × 5f以上
  - `Hammerlock`: 右肘角度 < 70° かつ手首が腰より下 × 4f以上
- **クールダウン**: 同アクション間の最小インターバル 1.5 秒（`COOLDOWN_SEC`）
- **SequenceView の表示条件**: 骨格 ON 中、または既存イベントがある場合に常時表示（骨格 OFF 時はオレンジの注釈バーを表示）
- **クリック→シーク**: イベント行・タイムラインチップクリックで `video.currentTime` をセット（再生/停止状態は維持）
- **Markdown エクスポート**: `navigator.clipboard.writeText()` で表形式コピー

## ロール判定（Leader/Follower）実装メモ

- **スロット方式**: 最大 2 人を `RoleSlot[2]` で管理。`matchRoleSlots()` が Nearest Neighbor（閾値 `ROLE_MATCH_DIST=0.35`）でスロット割り当て
- **初回判定**: ブレイクビート（On1=1拍、On2=2拍）での腰の Z 軸変化量（deltaZ）で判定。deltaZ < 0 = カメラに近づく = Leader
- **位相モニタリング（syncError）**: Leader/Follower の X 方向履歴（`PHASE_WINDOW=6` フレーム）が全て同じ符号 → 逆行エラーとして赤バナー表示
- **検出閾値**: `DETECT_CONFIDENCE=0.3` / `PRESENCE_CONFIDENCE=0.3` / `TRACKING_CONFIDENCE=0.3`（ペア密着時のオクルージョンに対応するため低めに設定。landmark の visibility チェックは別定数 `VIS_THRESHOLD=0.5`）
- **誤検知防止（3つのガード）**:
  1. `si0 >= 0 && si1 >= 0` — 両者が同フレームで追跡中のときのみフェーズチェックを実行
  2. `si < 0` のとき `xHistory = []` にリセット — トラッキング途切れ後の stale 履歴による誤発火を防止
  3. `SLOT_STALE_FRAMES=20` フレーム以上途切れたら `hip = null` にリセット → 再検出時に正しく再割り当て
- **ターン抑制**: ターン検出後 2 秒間はフェーズチェックを抑制（ターン中は両者が同方向に動くのが正常）
- **カラーコーディング**: Leader=青（`#0066ff`）、Follower=ピンク（`#ff00cc`）、その他=白50%

## デバッグログ仕様

- **エクスポート**: 「ログ出力」ボタン → `salsa_debug_log_<timestamp>.json` をダウンロード
- **構造**: `meta` + `annotations[]`。各アノテーションは Swap 直前 5 フレーム（`preSceneData`）+ 直後 5 フレーム（`postSceneData`）
- **FrameSnapshot**: `persons[]` に各スロットの hipX/Y/Z・velX/Y・shoulderWidth・bodyHeight・noseX/Y を記録。`persons:[]` は 0 人検出フレーム
- **分析時の注意点**: `distanceBetweenPersons` はスロットの last known 位置から計算するため、トラッキング途切れ中は stale 値が表示される

## アーキテクチャ制約メモ

- **OffscreenCanvas + WebWorker 非対応**: MediaPipe tasks-vision の GPU delegate は WebGL を使用。iOS Safari では WebWorker 内で WebGL コンテキスト（OffscreenCanvas）が利用不可のため Worker 移行は困難。代替として適応型サンプリングで対応
- **ステップ種別分類（Basic/Side/SuzyQ/Mambo）非実装**: Lite モデル（modelComplexity:0）の Z 軸は深度推定であり信頼性が低い。正確な分類には Full モデル + ワールド座標が必要（パフォーマンスとトレードオフ）
