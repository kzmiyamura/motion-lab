# DEVELOPMENT.md — Motion Lab 技術設計書

このドキュメントは、Motion Lab の設計思想・実装上の重要な判断・落とし穴をまとめたものです。
未来の自分や他の開発者が「なぜそうなっているのか」を迷わず理解できることを目的としています。

---

## 目次

1. [プロジェクト概要](#1-プロジェクト概要)
2. [CI/CD インフラ構成](#2-cicd-インフラ構成)
3. [オーディオ・アーキテクチャ](#3-オーディオアーキテクチャ)
4. [モバイル最適化](#4-モバイル最適化)
5. [PWA 設計](#5-pwa-設計)
6. [状態管理と永続化](#6-状態管理と永続化)
7. [YouTube BPM 同期](#7-youtube-bpm-同期)
8. [テスト戦略](#8-テスト戦略)

---

## 1. プロジェクト概要

**Motion Lab** は、サルサ・バチャータダンス練習専用のリズムトレーナー PWA です。

- **本番 URL:** https://motion-lab-apa.pages.dev/
- **インフラ:** Cloudflare Pages（`main` push → 自動ビルド・デプロイ）
- **スタック:** React 19 / TypeScript 5.9 / Vite 7 / Vitest 4

### ディレクトリ構成

```
src/
  engine/
    AudioEngine.ts       # Web Audio スケジューラ（シングルトン）
    salsaPatterns.ts     # サルサ・クラーベパターン定義
    bachataPatterns.ts   # バチャータリズムパターン定義
    bpmCategories.ts     # BPM カテゴリ（スロー/ミディアム等）
    presets.ts           # プリセット定義
    storage.ts           # localStorage 読み書きユーティリティ
  hooks/
    useAudioEngine.ts    # React フック（エンジンラッパー）
    useBpmMeasure.ts     # 長押し / 2タップ BPM 計測
    useUrlAnalysis.ts    # URL パラメータ読み取り（?bpm=&vid=）
    useWakeLock.ts       # Screen Wake Lock API
    useSilentAudio.ts    # iOS バックグラウンド維持（無音ループ + Media Session）
    useInstallPrompt.ts  # PWA インストール誘導
    useMediaSession.ts   # Media Session API
    useTapTempo.ts       # タップテンポ
  components/
    App.tsx              # ルートコンポーネント
    ControlPanel         # BPM スライダー、Start/Stop、音量、各種トグル
    RhythmMachine        # トラック一覧（ミュート切替）
    ClaveBeatGrid        # クラーベグリッド表示
    ClavePatternSelector # クラーベパターン選択
    FlipIndicator        # Flip Clave 状態表示
    YouTubeControl       # YouTube 埋め込み + BPM 計測
    InstallPrompt        # PWA インストール誘導 UI
    UpdateToast          # SW 更新通知
    SamplesStatus        # 音源ロード状態表示
functions/               # Cloudflare Pages Functions (API ルート)
```

---

## 2. CI/CD インフラ構成

### GitHub Actions × Claude Code

`.github/workflows/claude-code.yml` は、Issue コメントに `@claude` を含む投稿を検知して Claude Code CLI を実行し、実装結果を自動コミット・プッシュする仕組みです。

```yaml
- name: Run Claude Code
  run: |
    PROMPT="${COMMENT_BODY/@claude/}"
    claude --dangerously-skip-permissions "$PROMPT" > /tmp/claude_response.txt 2>&1 || true
```

#### `--dangerously-skip-permissions` が必須な理由

Claude Code は通常、ファイル書き込み・コマンド実行の前に対話的な確認プロンプトを出します。
GitHub Actions の CI 環境では TTY（端末）が存在しないため、プロンプトが発生すると処理が永久に停止します。
このフラグによって確認プロンプトをスキップし、非対話モードで完全に動作させます。

> ⚠️ **セキュリティ注意:** このフラグは信頼できるリポジトリ・ブランチ保護設定が前提です。
> 外部コントリビューターの PR からトリガーされないよう、`issues: write` 権限を持つメンバーのみがコメントできるリポジトリ設定を推奨します。

#### REST API 採用の背景（GraphQL 503 エラー対策）

当初 `gh issue comment` コマンドで結果を返す実装を試みましたが、GitHub Actions 環境での GraphQL エンドポイントが高頻度で HTTP 503 を返す問題が発生しました。

`actions/github-script@v7` の REST API（`github.rest.issues.createComment`）に切り替えることで安定動作を確認しました。

---

## 3. オーディオ・アーキテクチャ

### シングルトン設計

`AudioEngine` はモジュールレベルのシングルトンとして export されています。
React の StrictMode による二重初期化や、複数コンポーネントからの競合を防ぐためです。

```typescript
// AudioEngine.ts の末尾
export const audioEngine = new AudioEngine();
```

### ルック・アヘッド・スケジューラ

iOS・Android のタイマー精度は低く、`setInterval` を 1ms で動かしても実際の発火間隔はばらつきます。
`AudioContext.currentTime`（サンプル精度）を基準として 100ms 先まで先行スケジューリングすることで、人間が知覚できないレベルのタイミング精度を実現しています。

```typescript
const SCHEDULE_AHEAD_TIME = 0.1;  // 100ms 先まで先行スケジュール
const LOOKAHEAD_MS        = 25;   // スケジューラ呼び出し間隔

this.schedulerTimer = setInterval(() => this.schedule(), LOOKAHEAD_MS);

private schedule() {
  const ctx = this.getContext();
  const horizon = ctx.currentTime + SCHEDULE_AHEAD_TIME;
  while (this.nextBeatTime < horizon) {
    this.scheduleBeat(ctx, this.nextBeatTime, this.currentBeat);
    this.advanceBeat();
  }
}
```

### start() の delayMs ガード

`ControlPanel` の onClick から `start()` を呼ぶとき、React SyntheticEvent が誤って `delayMs` に渡るケースがあった（`onClick={onStart}` の形で渡すと引数に Event が入る）。
防衛的に型チェックで潰している。

```typescript
// AudioEngine.start()
const safeDelay = (typeof delayMs === 'number' && isFinite(delayMs))
  ? Math.max(0, delayMs)
  : 0;
this.nextBeatTime = ctx.currentTime + safeDelay / 1000;
```

> **教訓:** `onClick={fn}` ではなく `onClick={() => fn()}` と書かないと Event が引数に流れ込む。

### オーディオ・シグナルチェーン（ルーティング）

```
各楽器（個別 GainNode × TRACK_GAIN）
        │
        ▼
 masterGainNode  ← ユーザー操作（VOL スライダー 0–100%）
        │
        ▼
 noiseGateNode   ← 無音時は gain=0（ノイズゲート）
        │
        ▼
 DynamicsCompressor  ← LOUDNESS トグルで ON/OFF
        │
        ▼
 BiquadFilter（highshelf）  ← 10kHz 以上を −6dB カット（高域ノイズ除去）
        │
        ▼
 outputGainNode（固定 4.0×）  ← TRACK_GAIN 削減分の補償
        │
        ▼
 AudioContext.destination  →  スピーカー
```

**別経路（バイパス）:**
```
silentSource（≈−90dB ノイズループ）→ ctx.destination  直結
<audio> 要素（≈−84dB WAV ループ）  → システムオーディオ 直結
```
> iOS バックグラウンド維持専用。振幅は −84〜−90dB と**人間には不可聴**に設定。
> これらの振幅を −60dB 以上に上げると、ボリューム 0 でも「サー」ノイズが聞こえる。

#### Parallel Send-Return Reverb（並列センド・リターン型リバーブ）

```
【Dry 経路】
各楽器 GainNode → masterGainNode → noiseGateNode → compressor → … → destination

【Wet 経路（Send-Return）】
masterGainNode ──(Send tap)──► reverbSendGain ──► ConvolverNode
                                                        │
                                               reverbWetGain（クロスフェード制御）
                                                        │
                                              ◄── masterGainNode（Return）
```

- **単一インスタンス**: ノードは `getContext()` で一度だけ生成・接続。
- **クロスフェード切り替え**: `exponentialRampToValueAtTime`（20ms）でクリックノイズなし。
- **ミュート**: `type === 'none'` のとき `reverbWetGain.gain` を `0.0001` まで下げて無効化。

#### TRACK_GAIN（現在値）

```typescript
const TRACK_GAIN: Record<TrackId, number> = {
  // Salsa（YouTube 再生に埋もれないよう強め）
  clave:         1.10,
  'conga-open':  0.90,
  'conga-slap':  0.50,
  'conga-heel':  0.65,
  'cowbell-low':  0.55,
  'cowbell-high': 0.60,
  // Bachata
  'bongo-low':  0.60,
  'bongo-high': 0.35,
  'guira':      0.20,
  'bass':       0.65,
};
```

各楽器を 0dBFS を超えない水準に抑え、失われた音量は `outputGainNode`（固定 4.0×）で後段補償します。

#### DynamicsCompressor（LOUDNESS）パラメータ

```typescript
// LOUDNESS ON: スマホスピーカー向け音圧確保
compressor.threshold.value = -8;   // -8dBFS 以上のピークのみ圧縮
compressor.knee.value      = 20;   // ワイドニー（透明感重視）
compressor.ratio.value     = 4;    // 4:1（穏やか）
compressor.attack.value    = 0.003;
compressor.release.value   = 0.30;

// LOUDNESS OFF: ratio=1 で実質バイパス
compressor.threshold.value = 0;
compressor.ratio.value     = 1;
```

#### ノイズゲート

```typescript
private openNoiseGate(time: number) {
  const g = this.noiseGateNode.gain;
  g.cancelScheduledValues(time);
  g.setTargetAtTime(1.0, time, 0.002);    // τ=2ms でアタック
  const holdUntil = time + 1.5;           // リバーブ残響（1.2s）+ バッファ
  g.setValueAtTime(1.0, holdUntil);
  g.linearRampToValueAtTime(0.0, holdUntil + 0.08); // 80ms フェードアウト
}
```

連続再生中は `cancelScheduledValues` でクローズをキャンセルするため、ゲートは演奏中ずっと開いたまま。最後の音符から 1.5 秒後に静かに閉じます。

---

## 4. モバイル最適化

### Screen Wake Lock API

`src/hooks/useWakeLock.ts` が実装。`isPlaying` が true の間、`navigator.wakeLock.request('screen')` でデバイスのスリープを防止します。タブ切り替えで OS が自動解除するため、`visibilitychange` で復帰時に再取得します。

### iOS バックグラウンド再生（3層防衛）

`src/hooks/useSilentAudio.ts` が担当。

| 層 | 手段 | 役割 |
|----|------|------|
| 1 | `<audio>` 要素で無音 WAV をループ | iOS audio session を「再生中」として保持 |
| 2 | Media Session API | ロック画面のコントロール表示・OS への再生状態通知 |
| 3 | `visibilitychange → audioEngine.resumeIfSuspended()` | AudioContext の suspend からの明示的復帰 |

**`backgroundPlay` デフォルトは `true`:**
画面消灯時に `visibilitychange: hidden` が発火し、`backgroundPlay=false` だとエンジンが止まってしまいます。

### iOS での `start()` 非同期処理

```typescript
async start(): Promise<void> {
  const ctx = this.getContext();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  // resume() 完了後にスケジューラ開始 → 安全
  this.schedulerTimer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
}
```

### PWA インストール誘導（iOS/Android 差異）

| 環境 | 挙動 |
|------|------|
| iOS Safari | `beforeinstallprompt` 非対応 → `navigator.standalone !== true` を検出してバナー表示 |
| Android Chrome | `beforeinstallprompt` イベントを補足してネイティブダイアログ起動 |
| iOS Chrome (CriOS) | 「Safari で開く」ボタンを表示 |
| LINE / Instagram | in-app ブラウザ → `?openExternalBrowser=1` で外部ブラウザにリダイレクト |

---

## 5. PWA 設計

### Service Worker 更新戦略

```typescript
// vite.config.ts
workbox: {
  skipWaiting: true,   // 新 SW を即アクティブ化
  clientsClaim: true,  // 既存タブを即コントロール下に
  registerType: 'autoUpdate',
}
```

`UpdateToast` コンポーネントで更新を UI に通知します。

### オフライン対応

VSCO-2-CE サンプル音源（外部 GitHub raw）は `CacheFirst` でキャッシュ（30日間）。一度ダウンロードすれば電波なしで完全動作します。

---

## 6. 状態管理と永続化

### localStorage スキーマ

`src/engine/storage.ts` が全設定の読み書きを一元管理します。

| キー | デフォルト | 型 | 用途 |
|------|-----------|-----|------|
| `motionlab:schemaVersion` | — | number | マイグレーション管理 |
| `motionlab:bpm` | 180 | number | BPM |
| `motionlab:patternId` | `'son-2-3'` | string | クラーベパターン |
| `motionlab:mutedTracks` | `[コンガ3, カウベル2]` | string[] | ミュート中トラック |
| `motionlab:backgroundPlay` | `true` | boolean | バックグラウンド再生 |
| `motionlab:masterVolume` | `1.0` | number | マスター音量 |
| `motionlab:loudness` | `true` | boolean | コンプレッサー ON/OFF |
| `motionlab:yt-history` | `[]` | string[] | YouTube URL 履歴（最大5件） |

### マイグレーション

トラック構成が変わるたびに `SCHEMA_VERSION` をインクリメントし、旧ミュート状態をリセットします。

```typescript
const SCHEMA_VERSION = 2; // v1: cowbell分割, v2: conga分割

;(function migrate() {
  const savedVersion = load(KEYS.schemaVersion, 0, Number);
  if (savedVersion < SCHEMA_VERSION) {
    localStorage.removeItem(KEYS.mutedTracks);
    save(KEYS.schemaVersion, String(SCHEMA_VERSION));
  }
})();
```

---

## 7. YouTube BPM 同期

### 仕組み

1. ユーザーが `YouTubeControl` の BPM 測定ボタン（長押し or 2タップ）でテンポを計測 → `baseBpm` に保存
2. ControlPanel の BPM スライダーを動かすと `bpm`（currentBpm）が変化
3. `useEffect` が `bpm / baseBpm` の比率を計算して YouTube の `setPlaybackRate()` を呼ぶ

```typescript
useEffect(() => {
  if (!playerReadyRef.current || !baseBpm || !playerRef.current) return;
  const rate = Math.min(2, Math.max(0.25, bpm / baseBpm));
  playerRef.current.setPlaybackRate(rate);
}, [bpm, baseBpm]);
```

**制約:** YouTube IFrame API の `setPlaybackRate` は 0.25〜2.0 の範囲のみ対応。

### URL 履歴

`motionlab:yt-history` キーで最大5件を localStorage に保存。Load ボタン押下時に追記し、重複は除去します。

### URL パラメータ連携

`useUrlAnalysis` フックが `?bpm=` を読んで初期 BPM を適用します。スマホとPCで同じ設定を共有したい場合に URL をコピーして渡すことができます。

---

## 8. テスト戦略

### Web Audio モック

`src/__tests__/setup.ts` で `MockAudioContext` を定義し、`window.AudioContext` を置き換えます。

**重要な制約:**

```typescript
// ❌ 無限ループになる
await vi.runAllTimersAsync();

// ✅ これを使う（100ms 分 = ルックアヘッド1サイクル）
await vi.advanceTimersByTimeAsync(100);
```

### テストカバレッジ方針

- `AudioEngine.test.ts`: スケジューラの start/stop、BPM クランプ、コールバック、stop→restart サイクル
- `ControlPanel.test.tsx`: UI インタラクション（スライダー変更、ボタンクリック）
- iOS 固有動作（Wake Lock、AudioContext resume）はブラウザ依存が強いため**手動テスト**で確認

---

## 付録: よくある落とし穴

| 症状 | 原因 | 対処 |
|------|------|------|
| iOS で Start を押しても音が出ない | `ctx.resume()` を await していない | `async start()` で `await ctx.resume()` |
| ボリューム 0 でも「サー」ノイズ | 無音ループが `masterGainNode` をバイパス | 振幅を ≤−84dB に保つ |
| バックグラウンドで音が止まる | `backgroundPlay=false` + `visibilitychange:hidden` | デフォルト `true`、`statechange` リスナーで自動 resume |
| Start ボタンを押しても動かない | `onClick={onStart}` で React SyntheticEvent が `delayMs` に流れ込む | `onClick={() => onStart()}` と書く |
| LINE ブラウザでインストールできない | in-app ブラウザは PWA インストール非対応 | `?openExternalBrowser=1` リダイレクト |
| iOS Chrome でインストールできない | Apple 制限で PWA インストールは Safari 限定 | CriOS 検出 → Safari 誘導 |
| Cloudflare Pages ビルドエラー（lockfile 競合） | Node.js バージョン違いで `npm ci` が失敗 | `package-lock.json` を削除 → `npm install` |
