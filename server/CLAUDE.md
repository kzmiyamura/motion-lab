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

---

## 追加タスク（2026-07-28）: Tunnelがまた落ちている（`motion-lab-tunnel`の復旧）

`/relay/report` で確認したところ、ThinkCentreから最後にURLが報告されたのは前日13:43で止まっている。`motion-lab-tunnel`（`tunnel-wrapper.mjs`経由のcloudflared）がまた落ちているか、報告に失敗していると思われる。ほぼ1日周期で発生している。

### やってほしいこと
1. `pm2 list` で `motion-lab-tunnel` の状態を確認（`stopped`/`errored`になっていないか）
2. `pm2 logs motion-lab-tunnel --lines 100` でクラッシュ理由・エラーを確認
3. `pm2 restart motion-lab-tunnel` で復旧
4. 復旧後、`curl https://motion-lab-apa.pages.dev/relay/report` を叩いて `updatedAt` が最新時刻に更新されていることを確認
5. 可能であれば、なぜ落ちたのか（`cloudflared`自体がクラッシュ？ネットワーク断？）をログから特定してほしい。**これがほぼ毎日発生しているなら、`tunnel-wrapper.mjs`の自動復旧ロジック（プロセスexit時の再spawn）が効いていない可能性がある** ので、そちらの調査も含めて報告してほしい

### 報告してほしいこと
- 上記1〜5の結果
- 落ちた原因の所感（cloudflared自体の問題か、ネットワークか、他の要因か）
- 再発防止のためにできる対策があれば提案してほしい（例: ヘルスチェック用のcronで定期的に`/relay/report`の`updatedAt`と実際の生存確認をして、古ければ`pm2 restart motion-lab-tunnel`を自動実行する、等）

---

## 追加タスク（2026-07-28・その2）: 回転速度解析パイプライン（Python + MediaPipe）の導入

新機能: 動画内の人物の回転速度（RPM）を計測する。CPUのみでも「遅くていいので裏でしっかり解析する」方針のため、リアルタイム性は不要。Mac側でNode.js〜Pythonサブプロセス連携・API・フロントエンドまで実装済み（コミット済み）。ThinkCentre側はPython環境のセットアップと動作確認のみお願いします。

### 背景・設計
- `server/analysis/analyze_rotation.py` — MediaPipe Pose Landmarker **Heavyモデル**（精度優先、リアルタイム不要なのでHeavyを選択）で動画を1フレームずつ解析し、肩ラインの向き角度（`atan2(dz, dx)`）の時系列をunwrapしながら算出しJSON出力する
- `server/src/analysisJob.ts` — Node.jsから`child_process.spawn`でこのPythonスクリプトを起動し、完了時にDBへ結果を保存する。メモリ上の`running`フラグで多重実行を防止
- 解析中は`POST /api/videos`（アップロード）がブロックされる（`409 analysis_in_progress`）。CPU負荷が重なるのを避けるため
- 新API: `POST /api/videos/:id/analyze`（解析開始）, `GET /api/videos/:id/analysis`（結果取得、フロントはこれをポーリング）
- モデルファイルは**リポジトリにコミットしていない**（30MB超のバイナリのため）。`.gitignore`で`server/models/`を除外済み

### やってほしいこと

1. **Pythonインストール確認**（無ければ https://www.python.org/downloads/windows/ からインストール、pipも一緒に入るバージョンを選ぶ）
   ```
   python --version
   pip --version
   ```

2. **依存パッケージインストール**
   ```
   cd server/analysis
   pip install -r requirements.txt
   ```
   `mediapipe`・`opencv-python`ともWindows向けビルド済みwheelが配布されているはずなので、`better-sqlite3`の時のようなビルドツール地獄にはならない見込み。**もしビルドが必要というエラーが出たら、無理にビルドツールを入れず、まずMac側に報告してください**（別の対処法を検討します）

3. **Heavyモデルのダウンロード**（PowerShellで実行、`server/models/`ディレクトリに保存）
   ```powershell
   New-Item -ItemType Directory -Force -Path server/models
   Invoke-WebRequest -Uri "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task" -OutFile "server/models/pose_landmarker_heavy.task"
   ```
   ダウンロード後、ファイルサイズが30MB前後あることを確認（0KBやHTMLエラーページになっていないか）

4. **環境変数設定**（`server/.env`に追記。`python`がPATHに無ければフルパスを指定）
   ```
   PYTHON_BIN=python
   ```

5. **サーバー再起動**
   ```
   pm2 restart motion-lab-server
   ```

6. **動作確認**（実際に人物が映っている短い動画で。数十秒〜数分かかる想定）
   ```
   # 動画IDを控えておく（アップロード済みのものでOK。status:readyであること）
   curl -X POST http://localhost:4000/api/videos/<動画ID>/analyze
   # 数秒後、アップロードがブロックされるか確認（409が返ればOK）
   curl -X POST http://localhost:4000/api/videos -F "file=@dummy.mp4"
   # 解析完了まで待ってから結果確認（processingの間は繰り返し叩く）
   curl http://localhost:4000/api/videos/<動画ID>/analysis
   ```
   `status: "ready"`になり、`detectedFrames`が0より大きく（＝人物を検出できている）、`samples`に角度の時系列が入っていればOK

### 報告してほしいこと
- 上記6の結果（特に`detectedFrames`の数字、`fps`、サンプル数）
- pip installでエラーが出た場合はそのログ
- 解析1本あたりどれくらい時間がかかったか（動画の長さと合わせて）
- ローカル（Mac、Apple Silicon）ではPython版MediaPipeがMetal(GPU)を自動的に使っていたが、ThinkCentre（Windows、GPU無し）ではCPUのみでの動作になる見込み。体感の遅さも教えてほしい

### 触ってはいけないもの
- `functions/`・`wrangler.toml`（Cloudflare Pages側、無関係）
- モデルファイルの中身（`.task`）は書き換えない

---

## 追加タスク（2026-07-29）: フォルダ別MD解析パイプライン P0（配管）の取り込み

Mac側で「フォルダごとに解析指示書（MD）を持たせ、動画投入で自動解析する」パイプラインの配管（P0）を実装した。設計は `docs/folder-analysis-design.md`（基本）と `docs/folder-analysis-detailed-design.md`（詳細）を参照。**P0 は配管の疎通のみで、CV解析（P1）・Claude判断（P2）は未配線**。ThinkCentre側は取り込みと動作確認のみお願いします。

### やってほしいこと

1. `git pull` && `cd server && npm install`（依存追加は無いはずだが念のため）
2. `.env` に以下を追記（`.env.example` 参照）:
   ```
   API_WRITE_TOKEN=<Mac側と相談して決めた値。当面は空でもよい（無認証素通し）>
   JOB_TIMEOUT_MS=3600000
   JOB_MAX_RETRY=3
   ```
3. `pm2 restart motion-lab-server`
4. 起動ログに `[jobWorker] started` が出ることを確認
5. 動作確認（配管E2E）:
   ```
   # フォルダ作成 → 指示書保存
   curl -X POST -H "Content-Type: application/json" -d '{"name":"解析テスト"}' http://localhost:4000/api/folders
   curl -X PUT -H "Content-Type: application/json" \
     -d '{"markdown":"---\npreset: salsa-pair\nversion: 1\n---\n\n# テスト"}' \
     http://localhost:4000/api/folders/<フォルダID>/spec
   # ready済みの適当な動画をフォルダへ移動（これがエンキューのトリガー）
   curl -X PATCH -H "Content-Type: application/json" -d '{"folderId":"<フォルダID>"}' \
     http://localhost:4000/api/videos/<動画ID>
   # 15秒待ってからジョブ確認（status: done、report_md に「配管テスト」が入っていればOK）
   curl http://localhost:4000/api/videos/<動画ID>/jobs
   ```
6. `curl http://localhost:4000/api/health` に `claude` フィールドが追加されている（現時点では `unavailable` か `unchecked` で正常。claude CLI のインストールは P2 で実施予定なので**今はまだ不要**）

### 報告してほしいこと
- 上記4〜6の結果。問題なければ「P0対応完了」の一言でOK
- `storage/specs/` と `storage/analysis-jobs/` が作成されているか
