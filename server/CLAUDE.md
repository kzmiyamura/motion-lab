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

---

## 追加タスク（2026-07-27）: Quick Tunnel URL変動問題の恒久対策（固定URL中継）

Quick Tunnelの死亡・URL変動がこのセッション中に3回発生し、そのたびにMac側でCloudflare Pagesの環境変数を手動更新・再デプロイする運用になっていた。これをやめ、**Cloudflare Pages Functions による固定URL中継**を導入した（Mac側で実装・push済み: `functions/relay/`）。

### 仕組み

- フロントエンドは今後 `https://motion-lab-apa.pages.dev/relay/...` という固定URLだけを見る
- Cloudflare Pages Functions（`functions/relay/[[path]].ts`）が、KVに保存された「現在のThinkCentre Tunnel URL」へ全リクエストを転送する
- ThinkCentre側は Tunnel再接続で新URLが発行されるたびに `POST /relay/report` でそのURLを報告する

### ThinkCentre側でやってほしいこと

1. **`server/tunnel-wrapper.mjs`** を使う（Mac側で実装済み、`git pull`すれば手に入る）。`cloudflared` を直接起動する代わりに、このラッパー経由で起動する。ラッパーが標準出力/エラーからURLを検知して自動的に `/relay/report` へ報告する

2. 既存のPM2の `motion-lab-tunnel` プロセス（直接`cloudflared`を起動しているはず）を止め、代わりにラッパーを起動するよう変更:
   ```
   pm2 delete motion-lab-tunnel
   RELAY_REPORT_URL=https://motion-lab-apa.pages.dev/relay/report RELAY_SECRET=a0f538f6bb0e2d5c7afd9044db8bee3ecdedb92e54202e16 pm2 start server/tunnel-wrapper.mjs --name motion-lab-tunnel
   pm2 save
   ```
   （`pm2 start`に環境変数を渡す方法がPM2のバージョンで違う場合、`ecosystem.config.cjs`を作るか、`.env`ファイル経由でも可。動けばやり方は問わない）

3. **`RELAY_SECRET` の値** (`a0f538f6bb0e2d5c7afd9044db8bee3ecdedb92e54202e16`) は、Mac側でCloudflare Pagesの環境変数にも同じ値を設定済み。この値は変更しないこと（変更する場合は両側で同時に更新が必要なので、Mac側に確認してから）

4. **動作確認**:
   - `pm2 logs motion-lab-tunnel` で `[tunnel-wrapper] reported new URL: https://...` のログが出ることを確認
   - `curl https://motion-lab-apa.pages.dev/relay/report` (GETは認証不要) でその値が反映されているか確認
   - `curl https://motion-lab-apa.pages.dev/relay/api/health` で `{"status":"ok"}` が返ることを確認（固定URL経由でThinkCentreに到達できているかの確認）

5. **cloudflaredがクラッシュして再起動した場合**の動作もできれば確認してほしい（`pm2 restart motion-lab-tunnel` 等で意図的に落として、新URLが自動的に報告されるか）

### 報告してほしいこと

- 上記4・5の確認結果
- `cloudflared`が実際にURLをstdout/stderrどちらに出しているか、正規表現でうまく拾えているか（拾えていなければ`tunnel-wrapper.mjs`のログ出力形式を教えてもらえれば、Mac側で正規表現を調整する）
- 常駐化・再起動後もこの構成が維持されるか（PM2 resurrect経由で`tunnel-wrapper.mjs`ごと復元されるはず）

### 触ってはいけないもの

- `functions/`・`wrangler.toml`（Cloudflare Pages側）は変更不要。Mac側で完結している
- `RELAY_SECRET`の値そのものを外部に漏らさないこと（このファイルはリポジトリにコミットされるため、本来はここに平文で書くべきではないが、友人数名onlyの私的プロジェクトのため簡易的にここに記載している。将来的にはGoogle Cloudのシークレット管理等に移行を検討）

---

## 追加タスク（2026-07-27・その2）: 削除・改名・フォルダ機能への対応（コード取り込みのみ）

Mac側で `server/` に以下を追加・変更済み（コミット `9789bec`）。ThinkCentre側は **`git pull` して `pm2 restart motion-lab-server` するだけ** でよい。

### 変更内容
- `videos` テーブルに `folder_id` 列を追加（`db.ts` で起動時に自動マイグレーション、既存データは無事）
- `DELETE /api/videos/:id` — 動画削除（DB行 + originals/hls/thumbnailsのファイル一式も削除）
- `PATCH /api/videos/:id` — タイトル変更・フォルダ移動（body: `{ title?, folderId? }`）
- `GET/POST /api/folders`, `DELETE /api/folders/:id` — フォルダ管理（1階層のみ）
- `express.json()` ミドルウェアを追加（PATCH/POSTのJSONボディを受けるため）
- node:sqlite移行時からあった型エラー（`as unknown` 経由キャストが必要だった）も修正済み

### やってほしいこと
1. `git pull`
2. `cd server && npm install`（依存追加はないはずだが念のため）
3. `pm2 restart motion-lab-server`
4. 動作確認: `curl https://motion-lab-apa.pages.dev/relay/api/folders` が `{"folders":[]}` を返すこと
5. 起動時ログにマイグレーションエラーが出ていないか `pm2 logs motion-lab-server --lines 50` で確認

### 報告してほしいこと
- 上記4・5の結果のみ。問題なければ「対応完了」の一言でOK
