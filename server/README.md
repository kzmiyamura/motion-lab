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
6. **常駐化**: PM2 でプロセスを常駐させ、Windows起動時に自動復元する
   - `npm install -g pm2`
   - PM2はWindowsで `npm` 経由のスクリプト起動が失敗するため、`tsx` を直接指定して起動する:
     `pm2 start node_modules/tsx/dist/cli.mjs --name motion-lab-server --interpreter node -- src/index.ts`
   - `pm2 save` でプロセスリストを保存
   - **自動起動**: `pm2 startup` はWindowsの初期化システムを認識できず失敗する（Linuxのsystemd相当が無いため）。また `schtasks` の `onlogon` トリガー作成には管理者権限が必要でこのユーザー権限では作成不可だった。代わりに **スタートアップフォルダ**方式を使う:
     - `server/pm2-resurrect.cmd`（`pm2 resurrect` を呼ぶだけの薄いラッパー）を `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` にコピーする
     - これによりユーザーログオン時に自動で `pm2 resurrect` が走り、`pm2 save` した内容（motion-lab-server）が復元される
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

## 運用ツール（`server/tools/`）

どちらも `server/` をカレントにして `node` で直接実行する（tsx 不要）。

### `backfill-report-frames.mjs` — 過去レポートへの場面コマ画像の付け直し

```
node tools/backfill-report-frames.mjs [--dry-run] [<jobId> ...]
```

- status=done のジョブ（jobId 指定時はそれだけ）について、`analysis/make_report_frames.py` を
  jobWorker の `withSceneFrames` と同じ引数で走らせ、`out/report.md` と DB の `report_md` を更新する
- DB の `report_md` 末尾の「## 動画」節（`debugVideoSection` が付けたもの）はそのまま残す。
  保存済み本文が `report.md` 由来でないジョブ・元動画や tracks.json が無いジョブは飛ばす
- Claude は呼ばない。1件ずつ直列（メモリの少ない実機向け）。何度実行しても同じ結果になる
- `make_report_frames.py` の見出し解析のテスト: `python -m unittest discover -s server/analysis/tests`

### `auto-reanalyze.mjs` — パイプライン変更時の最新動画の自動再解析（pm2: `motion-lab-autoreanalyze`）

- 5分ごとに、解析結果に効くファイル（`analysis/**`（`eval_*` `measure_*` `prototype_*` `ground_truth/` `tests/` を除く）・
  `prompts/**`・`src/jobWorker.ts`・`src/claudeRunner.ts`・`src/presets.ts`）に触れた最新コミットを
  ローカルの `git log` で調べる
- 前回解析したコミットから変わっていて、コミットから20分以上・前回の自動再解析から2時間以上経ち、
  解析ジョブ（queued/running）が無く、空きメモリが 1.5GB 以上なら、指示書（salsa-pair）付きフォルダに入った
  最新の ready 動画を `POST /api/videos/:id/reanalyze` で再解析する（`API_WRITE_TOKEN` は `.env` から読む）
- `jobWorker.ts` / `claudeRunner.ts` / `presets.ts` がサーバー起動より後にコミットされていたら、
  先に `pm2 restart motion-lab-server` して health が戻るのを待つ
- 状態は `storage/auto-reanalyze.json`（`lastAnalyzedCommit` / `lastRunAt` / `lastJobId` / `lastSkipReason`）。
  初回は現在のコミットを記録するだけ。見送った理由は `lastSkipReason` と `pm2 logs motion-lab-autoreanalyze` に出る
- 常駐化:
  `pm2 start tools/auto-reanalyze.mjs --name motion-lab-autoreanalyze --cwd <server のフルパス>` → `pm2 save`
- 1回だけ判定を回す: `node tools/auto-reanalyze.mjs --once`

## 既知の制約（Phase 1）

- 認証なし。Tunnel URL を知っていれば誰でもアップロード・閲覧・API利用が可能
- HLSは単一画質のみ（アダプティブビットレートには非対応）
- アップロード上限 4GB（`src/routes/videos.ts` の `limits.fileSize`）
