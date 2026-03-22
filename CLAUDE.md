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

### 第0原則：3D骨格比率（ps値）の絶対優先

**役割決定の唯一の正解は `ps = 3D肩幅 / 3D腰幅`（SHR）に基づく比較のみ。**
向き・Visibility・Z位置・ビート・高さ・dynamicsScore は全て「ノイズ」として無視する。

- **3D計測**: `Math.hypot(sR.x-sL.x, (sR.z??0)-(sL.z??0))` により横向き時も骨格の厚みから正確に計測
- **判定基準**: 男性（Leader）SHR > 1.10, 女性（Follower）SHR < 1.05
- **発火条件**: `shoulderSamples >= 8 && hipSamples >= 8`（両スロット同時）→ `assignRolesByProfile()` を即時実行
- **廃止済み**: BPM暫定判定（deltaZ）・「2人目が初めて検出されたとき逆ロール割り当て」は完全削除

### ロック階層

| フラグ | セット条件 | ブロックする処理 |
|--------|-----------|----------------|
| `genderLockedRef` | ps判定確定後 または face-api.js判定後 | justSeparated・Self-Healing・FirstTurn・プロファイル蓄積 |
| `faceLockedRef` | face-api.js 顔性別判定確定後 | SHR自動変更 |
| `manualRoleLockedRef` | ユーザーがSwapボタン押下 | psリアクティブチェックを含む全自動変更 |

### psリアクティブ整合チェック

`genderLockedRef=true && manualRoleLockedRef=false` の間、**毎フレーム**プロファイルのps大小関係とロールの整合性を確認。
逆転を検出したら即座に修正（1フレーム以内で復旧）。
→ どんなコードパスがロールを汚染しても自動復旧する守護層。

### プロファイル蓄積の停止

`genderLockedRef=true` の間はプロファイル蓄積ブロック（`shoulderSamples`・`hipSamples`・`maxShoulderX` 等）を**完全停止**。
→ ロール確定後に別人の骨格データが混入して ps 値が変動する汚染バグを防ぐ。

### スロット方式

- 最大 2 人を `RoleSlot[2]` で管理。`matchRoleSlots()` が Nearest Neighbor でスロット割り当て
- ID（スロット番号）と Role（色）は完全分離。スロット番号は空間位置の追跡器であり、色はps属性に依存
- **カラーコーディング**: Leader=青（`#0066ff`）、Follower=ピンク（`#ff00cc`）、その他=白50%
- **位相モニタリング（syncError）**: Leader/Follower の X 方向履歴（`PHASE_WINDOW=6` フレーム）が全て同じ符号 → 逆行エラーとして赤バナー表示
- **検出閾値**: `DETECT_CONFIDENCE=0.2` / `PRESENCE_CONFIDENCE=0.2` / `TRACKING_CONFIDENCE=0.2`

## デバッグログ仕様

- **エクスポート**: 「ログ出力」ボタン → `salsa_debug_log_<timestamp>.json` をダウンロード
- **構造**: `meta` + `annotations[]`。各アノテーションは Swap 直前 5 フレーム（`preSceneData`）+ 直後 5 フレーム（`postSceneData`）
- **FrameSnapshot フィールド**:
  - `isOccluded`: オクルージョン中フラグ
  - `zOrderFront`: 手前スロットインデックス（-1 = 未判定）
  - `persons[]`: 検出済みスロット + 遮蔽中スロットの両方を記録
    - 検出済み: hipX/Y/Z・velX/Y・shoulderWidth・bodyHeight・noseX/Y・omega。`predictedX/Y = -1`
    - 遮蔽中: hipX/Y（速度外挿済）・velX/Y・omega・`predictedX/Y`（ファントム座標）
- **分析時の注意点**: `distanceBetweenPersons` はスロットの last known 位置から計算するため、トラッキング途切れ中は stale 値が表示される

## 物理ステートマシン（CBL・連続ターンの動的ID追跡）

- **Z-order推論（`getZOrderFront()`）**: 肩幅 > 足首Y > Z座標の優先順位でカメラ手前の人を判定。`RoleSlot.zFront` に記録し遮蔽時にどちらが隠れているかを管理
- **連続ターン周期性解析**:
  - `omegaHist`（最大 90 フレームの生X座標）にピーク・バレーを検出 → `ω = π / halfPeriod`
  - `angCenter`, `angAmplitude`, `angPhase` をリアルタイム更新
  - 位相推定: `rawPhase = asin((hip.x - center) / amplitude)`、velX の符号で象限を決定
- **ファントム座標（`buildPhantomPos()`）**: 遮蔽中は速度外挿 + サイン波ブレンドで予測位置を生成
  - ω ≥ 0.05 かつ振幅 ≥ 0.05 のとき: `sineWeight = min(0.85, ω×4)` でサイン波を優先
  - それ以外: 純粋な速度外挿（従来通り）
  - 予測位置を `RoleSlot.phantomPos` に格納し、`hip` を上書きして Re-ID に利用

## ダンス動力学（Dance Dynamics）による役割推定

- **`updateDynamicsScores()`**: 3つの物理特徴を毎フレーム解析し `RoleSlot.dynamicsScore`（正=Leader的）に加算。毎フレーム `DYNAMICS_DECAY=0.993` で減衰（~100フレームで半減）
- **1. Inception Detection（先行動作）**: 手首（landmark 15/16）の速度 > `INCEPTION_VEL_THRESHOLD=0.012` への遷移（静止→運動）を検知。2人の動き出しタイミング差が `INCEPTION_FRAME_WINDOW=4f（~130ms）` 以内なら先行者に `+0.5` 加算
- **2. Centripetal Logic（向心力）**: 両者 `omega > 0.05`（ターン中）のとき、`angAmplitude` が小さい方（回転中心軌道 = 大きな円弧を描いていない方）を Leader と判定。振幅差が 25% 以上のとき毎フレーム `+0.12` 加算
- **3. Space Management（スロット理論）**: 2人の距離が `OCCLUSION_DIST * 2.5` 未満かつ接近中のとき、速度ベクトルの接近線への「垂直率」が 65% 超かつ相手より 30% 以上大きい方（軸をずらして道を作った）を Leader と判定し `+0.7` 加算
- **動的ロール再評価**: 確定後も `dynamicsScore` 差が `DYNAMICS_REASSIGN_THRESHOLD=4.0` を超えた場合にロール再割り当て。Sticky 期間中は閾値を 2.5 倍に強化。`syncError` 発生時は閾値を 0.6 倍に緩和
- **デバッグログ**: `FrameSnapshot.persons[].dynamicsScore` にリアルタイムスコアを記録

## 身長ベース判定の動的減衰（Dynamic Weighting）

- **`heightWeight` 削減**: `assignRolesByProfile()` の身長重み `3 → 1.5`（遠近法影響を抑える）
- **Re-ID サーチ中心のファントム化**: `matchRoleSlots()` で `omega > 0.05` のとき、スロットの `hip` の代わりに `buildPhantomPos(slot, 1)`（1フレーム先予測）をサーチ中心に使う → 回転の連続性で Re-ID 精度を最大化
- **ターンモード身長サスペンド**: `justSeparated` 時に `omega > 0.05` → 頭身比率チェックを完全にスキップし、**ファントム予測距離**で割り当てを検証
  - スワップ距離が現在割り当ての 70% 未満のときのみ修正（保守的）
- **通常モード閾値厳格化**: `justSeparated` 通常時の自動スワップ閾値 `0.80 → 0.60`（20% 差 → 40% 差が必要）
- **粘り強い追跡（Sticky Tracking）**: `roleStableFramesRef >= STICKY_MIN_FRAMES(45f)` かつ `!syncError` の間は `justSeparated` スワップをガード → 移動ベクトル矛盾（`syncError`）が発生しない限りロール反転しない

## ハイブリッドアーキテクチャ（デバイス別解析最適化）

- **分岐判定**: `IS_IOS` 定数（`navigator.userAgent` + `maxTouchPoints` で判定）でデバイスを自動識別
- **全デバイス共通**: メインスレッドで MediaPipe を実行（Worker は npm パッケージがプロダクションビルドでバンドルされないため廃止）
- **iOS パス**:
  - 再生速度 ≤ 0.5x のとき 2パスカスケード解析を有効化
    - Pass 1: `landmarker.detectForVideo(video, now)` で通常検出
    - Pass 2: 検出済み人物をグレー矩形でマスクした HTMLCanvasElement を渡して再検出 → マージ
    - 結果を `analysisCacheRef`（最大 600 フレーム、時間許容 ±0.5 秒）に保存
  - 再生速度 > 0.5x のとき: キャッシュ優先、キャッシュミス時は単一パス検出
- **PC パス**: 常に 2パスカスケードを実行（キャッシュなし）
- **共通**: `isPoseCoherent()` による合成人体フィルタは両パスで適用

## face-api.js 顔性別判定メモ

- **ロード方式**: CDN `<script>` タグを `loadFaceApiFromCDN()` で動的挿入（npm バンドル不可 — Rollup が解決できないため）
- **並行起動**: `init()` の先頭で face CDN ロードを開始し、MediaPipe の await と並行して実行（iOS で CDN+モデルロードに最大13秒かかるため）
- **SHR サスペンド**: `initTimeRef.current` から `FACE_SCAN_SUSPEND_MS=15000ms` 以内は SHR ロックを待機（face 優先）
  - face モデルが15秒以内にロード完了 → face-api 判定を使用
  - 15秒を超えてもロード失敗 → SHR 判定にフォールバック
- **スキャン**: 500ms ごと、fire-and-forget。2人以上検出時のみ実行。`genderConfidence >= 0.90` の結果のみ採用
- **ロック確定**: male/female 各1名以上の高信頼結果が揃ったとき `faceLockedRef=true & genderLockedRef=true`
- **CBL_FIX**: `justSeparated` 直後の si0/si1 逆転を `slot.nose`（旧位置）との距離比較で検出・修正
  - 修正発動: `[CBL_FIX]` ログ
  - スキップ（閾値未達）: `[CBL_FIX_SKIP] ratio=X.XXX ...` ログ
  - スキップ（顔ランドマーク不足）: `[CBL_FIX_SKIP] missing nose: ...` ログ
- **可視化**: canvas 上に顔 bbox を描画。信頼度 ≥ 0.90 は実線枠、未満は点線枠。M/F + スコアラベル付き

## アーキテクチャ制約メモ

- **OffscreenCanvas + WebWorker（iOS）非対応**: iOS Safari は Worker 内 WebGL コンテキスト（GPU delegate）が利用不可。全デバイスでメインスレッド処理に統一済み
- **Web Worker 廃止理由**: `await import('@mediapipe/tasks-vision')` がプロダクションビルドの Worker 内で失敗する（npm パッケージはメインスレッドにしかバンドルされない）。`src/workers/salsaAnalyzer.worker.ts` は参照用に残存
- **ステップ種別分類（Basic/Side/SuzyQ/Mambo）非実装**: Lite モデル（modelComplexity:0）の Z 軸は深度推定であり信頼性が低い。正確な分類には Full モデル + ワールド座標が必要（パフォーマンスとトレードオフ）
