# Motion Lab — Salsa Rhythm Trainer

**本番URL:** https://motion-lab-apa.pages.dev/

**デプロイ環境:** Cloudflare Pages（GitHub `main` ブランチ連携・自動ビルド）

**Cloudflare Pages 管理画面:** https://dash.cloudflare.com/ → Workers & Pages → motion-lab-apa

**技術スタック:** React 19 / TypeScript 5.9 / Vite 7 / PWA (vite-plugin-pwa + Workbox) / Vitest 4

---

## 概要

サルサダンス向けのリズムトレーナー PWA。

- **Salsa Clave** — Son / Rumba の 2-3 / 3-2 パターン表示・再生
- **Flip Clave** — 次のバー境界でクラーベを即時反転（アバニコ合図付き）
- **Rhythm Machine** — Conga Tumbao（Open / Slap / Heel）+ Cowbell（Low / High）
- **オフライン対応** — Service Worker で音源・UIをキャッシュ
- **PWA インストール** — iOS Safari / Android Chrome からホーム画面に追加可能

---

## 開発

```bash
npm install
npm run dev        # Vite dev server
npm test           # Vitest（--run で単発実行）
npm run build      # 本番ビルド → dist/
```

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
├── engine/          # AudioEngine（Web Audio API）、salsaPatterns、storage
└── hooks/           # useAudioEngine、useInstallPrompt、useWakeLock 等
```

---

## PWA 設定メモ

- `registerType: 'autoUpdate'` + `skipWaiting: true` + `clientsClaim: true`
  → 新バージョン検知後、即座に旧キャッシュを上書き
- VSCO-2-CE サンプル音源（GitHub raw CDN）は `CacheFirst` でキャッシュ（30日）
- iOS Safari では `navigator.standalone` でスタンドアロン判定
- デバッグ: `?debug_pwa=true` を URL に付けるとインストール誘導UIを強制表示
