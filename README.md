# Motion Lab — Dance Rhythm Trainer

**本番URL:** https://motion-lab-apa.pages.dev/

**デプロイ環境:** Cloudflare Pages（GitHub `main` ブランチ連携・自動ビルド）

**Cloudflare Pages 管理画面:** https://dash.cloudflare.com/ → Workers & Pages → motion-lab-apa

**技術スタック:** React 19.2 / TypeScript 5.9 / Vite 7.3 / PWA (vite-plugin-pwa + Workbox) / Vitest 4 / Testing Library

---

## 概要

サルサ・バチャータダンス練習用のリズムトレーナー PWA。

### Salsa モード
- **Salsa Clave** — Son / Rumba の 2-3 / 3-2 パターン表示・再生
- **Flip Clave** — 次のバー境界でクラーベを即時反転（アバニコ合図付き）
- **Rhythm Machine** — Conga Tumbao（Open / Slap / Heel）+ Cowbell（Low / High）

### Bachata モード
- **Bachata Rhythm** — 8カウント・Beat 4 & 8 アクセント表示
- **セクション切替** — Derecho / Majao / Mambo の3パターン（ゲイン・Güiraパターンが変化）
- **Rhythm Machine** — Bongo / Güira / Bass

### YouTube BPM 同期
- **BPM 測定** — 長押し（8拍）or 2タップでテンポを手動計測
- **再生速度自動連動** — 計測した BPM を基準に、スライダーで BPM を変えると YouTube の再生速度が自動追従（baseBpm / currentBpm 比）
- **URL 履歴** — Load した YouTube URL を最大5件保存（localStorage）、ワンタップで再ロード

### 共通
- **オフライン対応** — Service Worker で音源・UIをキャッシュ
- **PWA インストール** — iOS Safari / Android Chrome からホーム画面に追加可能
- **バックグラウンド再生** — iOS でも画面消灯・タブ切替後に継続再生

---

## 開発

```bash
npm install
npm run dev        # Vite dev server（HMR あり）
npm run dev:pages  # Wrangler Pages ローカルプレビュー
npm test           # Vitest（ウォッチモード）
npm test -- --run  # Vitest（単発実行・CI向け）
npm run test:ui    # Vitest UI（ブラウザで結果確認）
npm run build      # 本番ビルド → dist/
npm run lint       # ESLint
```

## テスト方針

- **フレームワーク:** Vitest 4 + jsdom + @testing-library/react
- 変更後は必ず `npm test -- --run` と `npm run build` で確認してからコミット
- タイマー系テストでは `vi.runAllTimersAsync()` を**使わない**（setInterval 無限ループになる）
  → 代わりに `vi.advanceTimersByTimeAsync(100)` を使う

## デプロイ

`main` ブランチへ push すると Cloudflare Pages が自動ビルド・デプロイします。

```bash
git push origin main
```

手動デプロイ（wrangler）:
```bash
npm run cf:deploy
```

---

## ディレクトリ構成（src/）

```
src/
├── App.tsx
├── components/      # UI コンポーネント + CSS Modules
├── engine/          # AudioEngine（Web Audio API）、パターン定義、storage
└── hooks/           # useAudioEngine、useBpmMeasure、useInstallPrompt 等
```

---

## PWA 設定メモ

- `registerType: 'autoUpdate'` + `skipWaiting: true` + `clientsClaim: true`
  → 新バージョン検知後、即座に旧キャッシュを上書き
- VSCO-2-CE サンプル音源（GitHub raw CDN）は `CacheFirst` でキャッシュ（30日）
- iOS Safari では `navigator.standalone` でスタンドアロン判定
- デバッグ: `?debug_pwa=true` を URL に付けるとインストール誘導UIを強制表示
