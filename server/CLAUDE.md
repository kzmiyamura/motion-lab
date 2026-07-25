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
