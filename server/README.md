# Motion Lab Home Server

Motion Lab の「ThinkCentre に保存」機能のバックエンド。動画を受け取り、ffmpeg で HLS 形式に変換 + サムネイルを生成し、SQLite にメタデータを保存する。

Node.js のみで動作する（ffmpeg は `ffmpeg-static` により自動でバイナリが同梱されるため、別途インストール不要）。

## ローカル開発（Mac/Windows共通）

```bash
cd server
cp .env.example .env
npm install
npm run dev
```

`http://localhost:4000/api/health` が `{"status":"ok"}` を返せば起動成功。

## ThinkCentre（Windows）での本番セットアップ

**Phase 1（今回のスコープ）— 認証なしで LAN/Tunnel 経由アクセス**

1. **Node.js をインストール**（LTS版）: https://nodejs.org/ja
2. このリポジトリを ThinkCentre に `git clone`（または `server/` フォルダのみコピー）
3. `server/` で `npm install`
4. `server/.env` を作成（`.env.example` をコピーして編集）。`CORS_ORIGIN` に `https://motion-lab-apa.pages.dev` を含めること
5. 起動確認: `npm run start`（開発中は `npm run dev` でも可）
6. **常駐化**: PC再起動時にも自動起動させたい場合、[PM2](https://pm2.keymetrics.io/) や Windows の「タスクスケジューラ」でスタートアップ時に `npm run start` を実行するよう設定する
   - 例（PM2）: `npm install -g pm2` → `pm2 start npm --name motion-lab-server -- run start` → `pm2 save` → `pm2 startup`
7. **Cloudflare Tunnel で外部公開**（ルーターのポート開放不要）:
   - `cloudflared` をインストール: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   - Cloudflare ダッシュボード（Zero Trust）で Tunnel を作成し、`localhost:4000`（`.env` の `PORT` と一致させる）へのルートを設定
   - 発行されたトンネルURL（例: `https://videos.yourdomain.com`）を Motion Lab の環境変数 `VITE_HOME_SERVER_URL` に設定（Cloudflare Pages のダッシュボード → Settings → Environment Variables）

**Phase 2（後日）— Cloudflare Access で友人のみに制限**

- 上記 Tunnel に対して Cloudflare Access のアプリケーションを設定し、許可するメールアドレスのリストを登録する
- ここまでは無料枠（50ユーザーまで）で完結する
- コード側の変更は基本不要（Access が Tunnel の手前でブロックするため）

## ディレクトリ

- `storage/originals/` — アップロードされた元動画（gitignore対象）
- `storage/hls/<id>/` — 変換済み HLS（`playlist.m3u8` + `segment_*.ts`）
- `storage/thumbnails/` — サムネイル JPEG
- `data/motionlab.db` — SQLite（動画メタデータ）

## 既知の制約（Phase 1）

- 認証なし。Tunnel URL を知っていれば誰でもアップロード・閲覧・API利用が可能
- HLSは単一画質のみ（アダプティブビットレートには非対応）
- アップロード上限 4GB（`src/routes/videos.ts` の `limits.fileSize`）
