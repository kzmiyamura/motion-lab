# CLAUDE.md — Motion Lab Home Server（ThinkCentre セットアップ）

このファイルは、ThinkCentre（Windows, CPUのみ）上で `server/` を本番稼働させるための Claude Code 向け作業指示書です。
このリポジトリを Mac 側で開発した Claude Code が `server/README.md` にアーキテクチャ説明を残しています。まずそちらを読んでから着手してください。

## 前提

- OS: Windows（ThinkCentre、GPUなし・CPUのみ）
- 目的: `server/` を常駐プロセスとして起動し、Cloudflare Tunnel で外部公開する
- 認証（Cloudflare Access）は Phase 2 で別途対応。今回のタスクには含めない

## タスク（順番に実施）

1. **Node.js 確認/インストール**
   - `node -v` で確認。LTS（20系以上）が入っていなければ https://nodejs.org/ja からインストール

2. **依存インストール**
   - `cd server && npm install`

3. **.env 作成**
   - `.env.example` を `.env` にコピー
   - `CORS_ORIGIN` に `https://motion-lab-apa.pages.dev` と `http://localhost:5173` が含まれていることを確認（デフォルトのままでOK）

4. **起動確認**
   - `npm run start`
   - 別ターミナルで `curl http://localhost:4000/api/health` → `{"status":"ok"}` が返ること

5. **実機での変換動作確認（重要）**
   - 適当な短い mp4（数秒でよい）を用意し、以下でアップロードテスト:
     ```
     curl -F "file=@sample.mp4" -F "title=test" http://localhost:4000/api/videos
     ```
   - 数秒後 `curl http://localhost:4000/api/videos` を叩き、`status` が `"ready"` になっていること
   - `server/storage/hls/<id>/playlist.m3u8` と `server/storage/thumbnails/<id>.jpg` が生成されていること
   - これは `ffmpeg-static`/`ffprobe-static` の同梱バイナリが Windows 実機で正しく動くかの検証を兼ねる。失敗する場合はエラーメッセージを報告すること

6. **常駐化（PC再起動後も自動起動するように）**
   - 推奨: [PM2](https://pm2.keymetrics.io/) + [pm2-windows-startup](https://www.npmjs.com/package/pm2-windows-startup)
     ```
     npm install -g pm2 pm2-windows-startup
     pm2-startup install
     pm2 start npm --name motion-lab-server -- run start
     pm2 save
     ```
   - 代替: Windows タスクスケジューラで「ログオン時」に `npm run start`（`server/` をカレントディレクトリにして）を実行するタスクを作成してもよい

7. **Cloudflare Tunnel で外部公開**
   - `cloudflared` をインストール: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   - Cloudflare Zero Trust ダッシュボードで Tunnel を作成
   - Public Hostname のルートとして `localhost:4000`（`.env` の `PORT` と一致させる）を設定
   - 発行された公開URL（例: `https://videos.yourdomain.com`）を控える

## 完了後、人間（PCの持ち主）に報告すること

- 発行された Tunnel の公開URL（これを Cloudflare Pages 側の環境変数 `VITE_HOME_SERVER_URL` に設定してもらう必要がある）
- ステップ5の実機変換テストの結果（成功/失敗、失敗ならエラーメッセージ）
- 常駐化の方式（PM2 か タスクスケジューラか）
- `npm run start` のログに何かエラーや警告が出ていればそれも共有

## 触ってはいけないもの

- Cloudflare Access の設定（Phase 2、今回はスコープ外）
- Mac側リポジトリの `src/`（フロントエンド）や `wrangler.toml`（Cloudflare Pages側の設定）は無関係。`server/` 以外は触らないこと

---

## 追加タスク（2026-07-25）: アップロードが大きいファイルでタイムアウトする問題の診断

`server/REPORT_FROM_THINKCENTRE.md` の作業は完了済み、ありがとうございます。実運用で新しい問題が見つかったので追加調査をお願いします。

### 症状

Mac側から Quick Tunnel 経由でサイズ別にアップロードテストしたところ、明確な帯域律速が見つかりました:

| サイズ | 結果 |
|---|---|
| 1MB | 12.5秒で成功 |
| 5MB | 25秒で成功 |
| 10MB | 40秒でタイムアウト（失敗） |
| 20MB | 40秒でタイムアウト（失敗） |

実効速度は **約200KB/s（≈1.6Mbps）** 程度しか出ていません。実際のスマホ動画（66.4MB）もアップロード中にネットワークエラーになったと報告あり。Mac側の回線は安定したWiFiなので、テストする側の問題ではなさそうです。

### 調査してほしいこと

1. **ThinkCentreの生の上り回線速度**（Tunnelを経由しない）を測定
   - 例: https://fast.com や https://www.speedtest.net をブラウザで開いて実測、または `speedtest-cli` があれば使う
   - 上り(Upload) Mbpsを報告してください

2. **Tunnelを経由しない、LAN内からのアップロード速度**（切り分け用）
   - ThinkCentre自身から `curl -F "file=@<10MB程度のファイル>" http://localhost:4000/api/videos` を実行し、かかった時間を計測
   - これが速ければ「サーバー側処理は問題なし、Tunnelがボトルネック」と確定できる

3. **cloudflared のログ確認**
   - Quick Tunnel は無料・ベストエフォートのサービスで、Cloudflare公式にも「本番利用非推奨」と明記されている。ログに帯域制限やエラーの兆候がないか確認
   - `pm2 logs motion-lab-tunnel --lines 100` 等で確認

### 報告してほしいこと

- 上記1〜3の結果
- ThinkCentreの契約回線がそもそも上り1〜2Mbps程度なのか、それとも高速なのにTunnel/cloudflaredが絞っているように見えるのか、の所感
- もし本当に home回線の上り帯域が細い場合、動画アップロード機能自体の実用性に関わる重大な制約になるため、正直な数値を優先してください（体裁を整える必要はありません）

この調査結果を踏まえて、次の対策（チャンクアップロード実装 / Tunnel方式の見直し / 動画の事前圧縮 等）をMac側で判断します。
