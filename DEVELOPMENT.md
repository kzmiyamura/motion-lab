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
7. [テスト戦略](#7-テスト戦略)

---

## 1. プロジェクト概要

**Motion Lab** は、サルサダンス練習専用のリズムトレーナー PWA です。

- **本番 URL:** https://motion-lab-apa.pages.dev/
- **インフラ:** Cloudflare Pages（`main` push → 自動ビルド・デプロイ）
- **スタック:** React 19 / TypeScript 5.9 / Vite 7 / Vitest 4

### ディレクトリ構成

```
src/
  engine/
    AudioEngine.ts       # Web Audio スケジューラ（シングルトン）
    salsaPatterns.ts     # クラーベ・パターン定義
    bpmCategories.ts     # BPM カテゴリ（スロー/ミディアム等）
    storage.ts           # localStorage 読み書きユーティリティ
  hooks/
    useAudioEngine.ts    # React フック（エンジンラッパー）
    useWakeLock.ts       # Screen Wake Lock API
    useSilentAudio.ts    # iOS バックグラウンド維持（無音ループ + Media Session）
    useInstallPrompt.ts  # PWA インストール誘導
  components/            # UI コンポーネント + CSS Modules
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

```
# ❌ 失敗するパターン（GraphQL）
gh issue comment $ISSUE_NUMBER --body "$RESPONSE"
# → HTTP 503: 503 Service Unavailable
```

`actions/github-script@v7` の REST API（`github.rest.issues.createComment`）に切り替えることで安定動作を確認しました。

```javascript
// ✅ 安定するパターン（REST API）
await github.rest.issues.createComment({
  owner: context.repo.owner,
  repo: context.repo.repo,
  issue_number: context.issue.number,
  body: `**🤖 Claude:**\n\n${response}`,
});
```

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

// スケジューラは setInterval(25ms) で駆動
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
 DynamicsCompressor  ← LOUDNESS トグルで ON/OFF（threshold, ratio 等）
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
> これらは iOS バックグラウンド維持専用。`masterGainNode` を経由しないので
> ボリューム操作の影響を受けない。振幅は −84〜−90dB と**人間には不可聴**に設定。
> **重要:** これらの振幅を −60dB 以上に上げると、ボリューム 0 でも「サー」ノイズが聞こえる。

#### TRACK_GAIN の設計思想

```typescript
const TRACK_GAIN: Record<TrackId, number> = {
  clave:         0.55,
  'conga-open':  0.70,
  'conga-slap':  0.28,
  'conga-heel':  0.42,
  'cowbell-low':  0.30,
  'cowbell-high': 0.35,
};
```

各楽器を **0dBFS を超えない（≤0.70）** 水準に抑えることで、コンプレッサーへの入力レベルを低く保ちます。
これにより **コンプレッサーのメイクアップゲインがノイズ床を持ち上げない**（ノイズ床 ≈ −60dBFS はしきい値 −8dBFS を大幅に下回る）。
失われた音量は `outputGainNode`（固定 4.0×, +12dB）で後段補償します。

#### DynamicsCompressor（LOUDNESS）パラメータ

```typescript
// LOUDNESS ON: スマホスピーカー向け音圧確保（ピーク抑制のみ）
compressor.threshold.value = -8;   // -8dBFS 以上のピークのみ圧縮
compressor.knee.value      = 20;   // ワイドニー（透明感重視）
compressor.ratio.value     = 4;    // 4:1（穏やか）
compressor.attack.value    = 0.003;
compressor.release.value   = 0.30;

// LOUDNESS OFF: コンプレッサーを透過状態に（ratio=1 で実質バイパス）
compressor.threshold.value = 0;
compressor.ratio.value     = 1;
```

> **ratio=12 を使わない理由:** 高 ratio はメイクアップゲインが大きく（≈17dB）、
> ノイズ床も同量ブーストされてしまう。ratio=4 + 後段 outputGainNode で同等の音圧を
> ノイズなしで実現。

#### ハイシェルフ・フィルター（高域ノイズ対策）

白色ノイズを使うコンガ・スラップ、コンガ・ヒール、リバーブ IR は本質的に高域成分を含みます。
コンプレッサーがこれらを増幅した結果、「シャー」という高域ノイズが目立つ問題が発生しました。

```typescript
this.highShelfNode.type            = 'highshelf';
this.highShelfNode.frequency.value = 10000; // 10kHz
this.highShelfNode.gain.value      = -6;    // −6dB カット
```

人間の聴覚が「耳障り」と感じる帯域（10kHz 以上）を物理的にカットします。
打楽器の胴鳴り・アタック感（200Hz〜5kHz）は保持されます。

#### ゼロクロス・フェード（クリックノイズ防止）

すべての合成音源・サンプル再生でゲインの「段差」を 3ms のランプで平滑化します。

```typescript
gainNode.gain.setValueAtTime(0.0001, time);
gainNode.gain.exponentialRampToValueAtTime(gain, time + 0.003); // 3ms アタック
```

`setValueAtTime(gain, t)` で瞬時に値をセットすると、前の値からの段差がパチッというクリックになります。
`0.0001`（ほぼゼロ）から始めることでゼロクロス遷移が滑らかになります。

#### ノイズゲート（無音時のノイズ遮断）

```typescript
// 音符スケジュール時にゲートを開く
private openNoiseGate(time: number) {
  const g = this.noiseGateNode.gain;
  g.cancelScheduledValues(time);          // 前のクローズ予約をキャンセル
  g.setTargetAtTime(1.0, time, 0.002);    // τ=2ms でアタック（≈6ms で 95%）
  const holdUntil = time + 1.5;           // リバーブ残響（1.2s）+ バッファ
  g.setValueAtTime(1.0, holdUntil);
  g.linearRampToValueAtTime(0.0, holdUntil + 0.08); // 80ms フェードアウト
}
```

連続再生中は新しい音符のたびに `cancelScheduledValues` でクローズをキャンセルするため、
ゲートは演奏中ずっと開いたまま。最後の音符から 1.5 秒後に静かに閉じます。

---

## 4. モバイル最適化

### Screen Wake Lock API

`src/hooks/useWakeLock.ts` が実装。`isPlaying` が true の間、`navigator.wakeLock.request('screen')` でデバイスのスリープを防止します。

```typescript
export function useWakeLock(isPlaying: boolean) {
  // isPlaying に連動して取得 / 解放
  useEffect(() => {
    if (isPlaying) acquire();
    else release();
    return () => { release(); };
  }, [isPlaying]);

  // タブ切り替えで OS が自動解除する → 復帰時に再取得
  useEffect(() => {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isPlaying) acquire();
    });
  }, [isPlaying]);
}
```

**タブ切り替え時の再取得が必要な理由:** ブラウザ仕様により、タブが非表示になると Wake Lock は自動解除されます。
`visibilitychange` イベントで `visible` への遷移を検知し、再生中なら即再取得します。

**未対応ブラウザへの対応:** `'wakeLock' in navigator` チェックで機能検出し、未対応環境ではサイレントに無効化。

### iOS バックグラウンド再生（3層防衛）

`src/hooks/useSilentAudio.ts` が担当。

| 層 | 手段 | 役割 |
|----|------|------|
| 1 | `<audio>` 要素で無音 WAV をループ | iOS audio session を「再生中」として保持 |
| 2 | Media Session API | ロック画面のコントロール表示・OS への再生状態通知 |
| 3 | `visibilitychange → audioEngine.resumeIfSuspended()` | AudioContext の suspend からの明示的復帰 |

さらに `AudioEngine.ts` 内でコンテキストレベルの監視も行います：

```typescript
// iOS が AudioContext を interrupt/suspend したとき自動 resume
this.context.addEventListener('statechange', () => {
  if (!this._isPlaying || !this.context) return;
  if (this.context.state === 'suspended') {
    this.context.resume().catch(() => {});
  }
});
```

**`backgroundPlay` デフォルトは `true`:**
画面消灯時に `visibilitychange: hidden` が発火し、`backgroundPlay=false` だとエンジンが止まってしまいます。
デフォルトを `true` にすることで、スマホを置いたまま演奏し続けられます。

### iOS での `start()` 非同期処理

iOS Safari は `AudioContext` が `suspended` 状態で作成されます。
`ctx.resume()` を `await` せずにスケジューラを開始すると、サスペンドのまま音が鳴らないケースが発生します。

```typescript
async start(): Promise<void> {
  const ctx = this.getContext();
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  this._isPlaying = true;
  // ここからスケジューラ開始 → resume() 完了後なので安全
  this.schedulerTimer = setInterval(() => this.schedule(), LOOKAHEAD_MS);
}
```

### PWA インストール誘導（iOS/Android 差異）

| 環境 | 挙動 |
|------|------|
| iOS Safari | `beforeinstallprompt` 非対応 → `navigator.standalone !== true` を検出して手動でバナーを表示し、Safari の共有メニューから「ホーム画面に追加」を案内 |
| Android Chrome | `beforeinstallprompt` イベントを補足してネイティブインストールダイアログを起動 |
| iOS Chrome (CriOS) | PWA インストールは Safari 限定 → 「Safari で開く」ボタンを表示 |
| LINE / Instagram | in-app ブラウザ → `?openExternalBrowser=1` で外部ブラウザに強制リダイレクト |

---

## 5. PWA 設計

### Service Worker 更新戦略

```typescript
// vite.config.ts
workbox: {
  skipWaiting: true,   // 新 SW を即アクティブ化（待機なし）
  clientsClaim: true,  // 既存タブを即コントロール下に置く
  registerType: 'autoUpdate',
}
```

`skipWaiting + clientsClaim` の組み合わせにより、デプロイ後のリロードなしで最新版が配信されます。
`useRegisterSW` フックと `UpdateToast` コンポーネントで更新を UI に通知します。

### オフライン対応

VSCO-2-CE サンプル音源（外部 GitHub raw）は `CacheFirst` でキャッシュ（30日間）。
一度ダウンロードすれば、電波のない場所でも完全動作します。

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

### マイグレーション

トラック構成が変わるたびに `SCHEMA_VERSION` をインクリメントし、旧ミュート状態をリセットします。
ストレージ読み込み時（モジュール import 時）に一度だけ実行されます。

```typescript
const SCHEMA_VERSION = 2; // v1: cowbell分割, v2: conga分割

;(function migrate() {
  const savedVersion = load(KEYS.schemaVersion, 0, Number);
  if (savedVersion < SCHEMA_VERSION) {
    localStorage.removeItem(KEYS.mutedTracks); // 旧構成をリセット
    save(KEYS.schemaVersion, String(SCHEMA_VERSION));
  }
})();
```

---

## 7. テスト戦略

### Web Audio モック

`src/__tests__/setup.ts` で `MockAudioContext` を定義し、`window.AudioContext` を置き換えます。
各ノード（GainNode、BiquadFilterNode 等）は `vi.fn()` を持つ最小限のモックオブジェクトを返します。

**重要な制約:**

```typescript
// ❌ これは無限ループになる
await vi.runAllTimersAsync();
// AudioEngine の setInterval が無限に発火し続けるため

// ✅ これを使う
await vi.advanceTimersByTimeAsync(100);
// 100ms 分だけ進める → ルック・アヘッドの 1 サイクル分
```

### テストカバレッジ方針

- `AudioEngine.test.ts`: スケジューラの start/stop、BPM クランプ、コールバック、サンプルロード
- `ControlPanel.test.tsx`: UI インタラクション（スライダー変更、ボタンクリック、カテゴリ選択）
- iOS 固有動作（Wake Lock、AudioContext resume）はブラウザ依存が強いため**手動テスト**で確認

---

## 付録: よくある落とし穴

| 症状 | 原因 | 対処 |
|------|------|------|
| iOS で Start を押しても音が出ない | `ctx.resume()` を await していない | `async start()` で `await ctx.resume()` |
| ボリューム 0 でも「サー」ノイズ | 無音ループが `masterGainNode` をバイパス | 振幅を ≤−84dB に保つ |
| バックグラウンドで音が止まる | `backgroundPlay=false` + `visibilitychange:hidden` | デフォルト `true`、`statechange` リスナーで自動 resume |
| LINE ブラウザでインストールできない | in-app ブラウザは PWA インストール非対応 | `?openExternalBrowser=1` リダイレクト |
| iOS Chrome でインストールできない | Apple 制限で PWA インストールは Safari 限定 | CriOS 検出 → Safari 誘導 |
| Cloudflare Pages ビルドエラー（lockfile 競合） | Node.js バージョン違いで `npm ci` が失敗 | `package-lock.json` を削除 → `npm install` |
