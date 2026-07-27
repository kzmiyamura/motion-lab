# /relay — ThinkCentre固定URL中継

ThinkCentre の `server/`（Cloudflare Quick Tunnel経由で公開）は `cloudflared` が再接続するたびにURLが変わってしまう（`https://<ランダム文字列>.trycloudflare.com`）。これをフロントエンドが直接見に行くと、URLが変わるたびに Cloudflare Pages の環境変数を更新して再デプロイする必要があり非現実的。

この `/relay` は Cloudflare Pages Functions で実装したリバースプロキシで、フロントエンドからは常に固定URL（`https://motion-lab-apa.pages.dev/relay/...`）だけを見ればよくなる。裏側で「今生きているThinkCentreのURL」への転送を行う。

## 仕組み

- 現在のThinkCentre URLは KV namespace（`HOME_RELAY_KV`）に1つだけ保存する
- `GET/POST /relay/*` — KVに保存されたURLへそのまま転送（`functions/relay/[[path]].ts`）
- `POST /relay/report` — ThinkCentre側がTunnel再接続のたびに新URLをここに送って更新する（`functions/relay/report.ts`）。`X-Relay-Secret` ヘッダーで認証
- `GET /relay/report` — 現在保存されているURLを確認（デバッグ用、認証不要）

## セットアップ（初回のみ、Mac/管理者側）

1. KV namespace作成:
   ```
   npx wrangler login
   npx wrangler kv namespace create HOME_RELAY_KV
   ```
   出力された `id` を `wrangler.toml` の `[[kv_namespaces]]` セクションに設定する

2. Cloudflare Pages ダッシュボード → Settings → Environment Variables に追加:
   - `RELAY_SECRET` = ランダムな文字列（ThinkCentre側にも同じ値を伝える。再生成する場合は両方同時に更新すること）

3. フロントエンドの `VITE_HOME_SERVER_URL` を `https://motion-lab-apa.pages.dev/relay` に設定

## ThinkCentre側の対応

`cloudflared tunnel --url http://localhost:4000` 起動時に標準出力へ出るURLを検知し、以下を叩く:

```
curl -X POST https://motion-lab-apa.pages.dev/relay/report \
  -H "X-Relay-Secret: <RELAY_SECRETの値>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<新しいtrycloudflareのURL>"}'
```

これをTunnel起動・再接続のたびに自動実行するラッパーが必要。詳細タスクは `server/CLAUDE.md` を参照。
