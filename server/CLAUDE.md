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

---

## 追加タスク（2026-07-29・その2）: P1（CV計測）の取り込みと実動画検証

P1 として `analysis/analyze_pair.py`（2人分の骨格計測・SHR判定・contested区間抽出）と
`analysis/extract_keyframes.py`（contested区間のJPEG書き出し）を追加した。
preset `salsa-pair` に配線済みのため、**取り込むだけで解析ジョブが実際にCV計測を行うようになる**。
Python 環境・Heavyモデルは回転解析（2026-07-28・その2）で構築済みのものをそのまま使う。

### やってほしいこと

1. `git pull` && `pm2 restart motion-lab-server`
2. **実動画検証（重要）**: サルサペアが映っている ready 済み動画を、指示書を保存したフォルダに移動（または UI/curl で再解析）
   ```
   curl -X POST http://localhost:4000/api/videos/<動画ID>/reanalyze
   # 完了まで待つ（動画長の数倍かかる想定。10fps間引き済み）
   curl http://localhost:4000/api/videos/<動画ID>/jobs
   curl http://localhost:4000/api/jobs/<ジョブID>
   ```
3. レポート（reportMd）を確認:
   - Leader 判定（スロット0/1）と SHR 平均値が出ているか
   - contested 区間がある場合、`storage/analysis-jobs/<ジョブID>/out/keyframes/` に JPEG が書き出されているか

### 報告してほしいこと
- 実動画1本あたりの解析所要時間（動画の長さと合わせて）
- slot0/slot1 の SHR 平均値と、**その判定が実際の男女と合っているか**（人間の目で答え合わせ）
- contested 区間の数と、キーフレーム JPEG が人間の目で見て「確かに判定が難しい瞬間」か
- 判定が間違っている場合はその動画の特徴（体格差・向き・オクルージョンの多さ等）

---

## 追加タスク（2026-07-29・その3）: 申し送り3件の修正取り込みと再検証

`NOTES_TO_MAC_CLAUDE.md` の申し送りありがとう。コード根拠つきの指摘は全て妥当だったので、#1・#2・#4 を修正した。#3（contested過検出）は「動画の性質の指標として使える」という見立てに同意し、今回は閾値をいじらず様子見とする。

### 修正内容
1. **背景第三者フィルタ**（申し送り#1）: `num_poses=4` で候補を多めに取り、bbox面積（全ランドマークのx/yスパン）上位2人をペアとして採用
2. **verdict母集団のクリーン化**（申し送り#2）: SHR平均を「非オクルージョンフレームのみ」から算出。クリーンサンプルが両スロット10未満なら全フレームにフォールバック（`verdictByRule.basis` に `clean` / `all_frames_fallback` を明示）
3. **回転解析の10fps間引き**（申し送り#4）: `analyze_rotation.py` に `TARGET_FPS=10` 導入。実時間4.4倍→大幅短縮の見込み
4. `.env.example` に Windows の PYTHON_BIN フルパス必須の注記を反映

### やってほしいこと
1. `git pull` && `pm2 restart motion-lab-server`
2. **同じ動画（2fda2815、「P1検証」フォルダに入ったままでOK）で再解析**:
   ```
   curl -X POST http://localhost:4000/api/videos/2fda2815.../reanalyze
   ```
3. 前回（slot0=1.6318/120、slot1=1.5904/226、拮抗）と比較して報告:
   - スロットのサンプル数の偏りが減ったか（第三者フィルタの効果）
   - `verdictByRule.basis` がどちらになったか、SHR差が開いて Leader を当てられるようになったか
   - この動画はオクルージョン7割なので `all_frames_fallback` になる可能性が高い。それ自体は正常挙動（P2のClaude裁定対象）
4. 可能なら**背景に人がいない・オクルージョン少なめの動画**でも1本検証（前回提案してくれたやつ。SHR判定の素の精度測定）
5. 回転解析も同じ動画で再実行し、所要時間の変化を報告（前回2分20秒）

### 報告してほしいこと
- 上記3・5の前回比。4をやった場合はその動画での答え合わせ結果

### P2 予告（まだ作業不要）
- claude CLI の導入は次フェーズ。**非管理者アカウントで入れられる方式**（ユーザーローカルの npm global または公式インストーラのユーザーモード）を指示書で指定する予定。今は何も入れなくてよい

---

## 追加タスク（2026-07-29・その4）: 同一性リーク修正（申し送り#8/#9）の取り込みと再検証

その3再検証と申し送り#8（位置ベーススロットの同一性リーク → 符号反転リスク）の指摘、極めて有益だった。
指摘どおり提案(A)を採用して修正した（#9 の機械可読信頼度も対応）。

補足: 現行コードは初回のみ hipX ソートで以降は NN トラッキングだが、8割オクルージョン＋交差では
NN が入れ替わるため「スロット平均に両者が混ざる」という結論はそのまま成立する。良い指摘だった。

### 修正内容
1. **verdict をフレーム内 high/low 分離に変更**（#8 提案A）: スロット平均を捨て、各ペアフレームで
   「SHRが高い側 / 低い側」を集計。人物追跡に依存せず符号一貫性を保証。
   - `verdictByRule` の新形式: `{ leaderExists, separation, highMean, lowMean, confidence, basis, leaderAtStart: {side, t}, highSideConsistency }`
   - `leaderAtStart`: 開始時（最初の5ペアフレーム多数決）に高SHR側が画面左右どちらか
   - `highSideConsistency`: 高SHR側が同じ側に居続けた割合（低い＝交差が多い）
   - スロット別サマリは参考情報として残存（同一性リークがあり得る旨をコメント明記）
2. **reliability の機械可読出力**（#9）: `{ cleanPairFrames, allPairFrames, cleanRatio }` を
   measurements.json の summary と ジョブの resultJson 両方に出力

### やってほしいこと
1. `git pull` && `pm2 restart motion-lab-server`
2. 同じ動画（2fda2815）で再解析し、以下を報告:
   - `verdictByRule.separation`（前回の左右平均差0.047に相当する新指標。フレーム内比較なので大きくなるはず）
   - `leaderExists` が true になったか。true の場合 `leaderAtStart.side` が **right（=男性側）** になっているか（←これが答え合わせの本丸）
   - `highSideConsistency` の値（この動画の交差の多さの数値化）
   - `reliability.cleanRatio`
3. クリーン動画（背景に人なし・オクルージョン少）での検証は引き続き保留中。動画が用意でき次第依頼する

### 報告してほしいこと
- 上記2の結果。特に leaderAtStart.side の正否

---

## 追加タスク（2026-07-29・その5）: ROIマスク（背景の物理排除）の取り込みと再検証

クリーン動画が用意できないため、**CV側で背景を消す**方針を採った（ロードマップ⑦の前倒し）。
前フレームで確定したペアの bbox+マージンの外側をグレーで塗りつぶしてから検出することで、
鏡の第三者を検出器の視野から物理的に排除する。

### 実装内容
1. **ROIマスク**（analyze_pair.py）: ペア追従ROI。crop でなくマスク方式（座標系保持のため）。
   1人検出（オクルージョン中）はマージン2倍で維持、0人が2連続で全画面フォールバック
2. **デバッグ動画**: マスク適用後フレーム+検出枠（金=ROI、緑=採用ペア、赤=除外人物）を
   `out/debug_roi.mp4` に出力（jobWorker が H.264 変換）。`/analysis-output/<jobId>/out/debug_roi.mp4` で配信
3. reliability に `roiMaskedFrames` / `roiResets` を追加

### やってほしいこと
1. `git pull` && `cd server && npm install`（依存追加なしのはずだが念のため）&& `pm2 restart motion-lab-server`
2. 同じ動画（2fda2815）で再解析し、報告:
   - その4の指標（leaderAtStart.side の正否・separation・highSideConsistency・cleanRatio）
   - `reliability.roiMaskedFrames`（ROIが効いたフレーム数）と `roiResets`
   - 検出サンプルの偏り（前回124:214）が改善したか（鏡の第三者が消えたか）
3. **デバッグ動画のURLを報告**（人間がブラウザで見て背景マスクを確認したいとのこと）:
   `https://motion-lab-apa.pages.dev/relay/analysis-output/<ジョブID>/out/debug_roi.mp4`
   が再生できることを確認して、このURLをそのまま報告に書く

### 報告してほしいこと
- 上記2・3。特にデバッグ動画URLは必須（人間が目視確認する）

---

## 追加タスク（2026-07-29・その6）: ペア解析の検出器を YOLOv8-pose へ全面移行

**【重要】その4・その5の再検証は未実施のままで構わない（スキップしてよい）。**
Mac側での実測で MediaPipe Heavy が本質的ボトルネックと判明したため（検証動画 2fda2815 で
2人同時検出 12/315 フレーム = 4%。YOLOv8s-pose プロトタイプは 283/315 = 89%）、
MediaPipe 前提だったその4/その5の再検証は意味を失った。このその6の検証がそれを兼ねる。

### 変更内容（git pull で入る）
1. `analysis/analyze_pair.py` を YOLOv8s-pose ベースに全面書き換え
   - SHR は 2D（COCO 17キーポイントに z が無いため）。肩=kp5,6 / 腰=kp11,12
   - ROIマスク・bbox面積上位2人選別・フレーム内high/low分離verdict・contested抽出・
     デバッグ動画は従来ロジックをそのまま移植（measurements.json のスキーマもほぼ同じ。
     `shr3d` → `shr2d` に改名、`detector`/`shrMode` フィールド追加）
   - **見切れガード（新規）**: bbox が画面左右端に接している人物を含むフレームは verdict
     母集団から除外（`reliability.edgeClippedPairFrames` に件数を出力）。検証動画の冒頭で
     男性が右端に見切れて SHR が 0.73 に潰れ leaderAtStart を誤る問題を Mac 側で確認・修正済み
2. `src/jobWorker.ts`: モデルパスを `YOLO_MODEL_PATH`（既定 `server/models/yolov8s-pose.pt`）に変更。
   回転解析（analyze_rotation.py）は従来どおり MediaPipe Heavy + `POSE_MODEL_PATH` を使う（変更なし）
3. `analysis/requirements.txt` に `ultralytics` を追加

### やってほしいこと
1. `git pull`
2. **ultralytics のインストール**（非管理者でOK。PYTHON_BIN のフルパスと同じ Python に入れること）:
   ```
   <PYTHON_BINのフルパス> -m pip install --user ultralytics
   ```
   - torch（CPU版）が依存で入る。数百MBのダウンロードになるが CPU 版で問題ない
   - proxy やビルドエラーが出たら無理をせず、エラーログを添えて報告してほしい
3. **YOLOモデルのダウンロード**（PowerShell）:
   ```powershell
   Invoke-WebRequest -Uri "https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8s-pose.pt" -OutFile "server/models/yolov8s-pose.pt"
   ```
   - **ダウンロード後に必ずファイルサイズを確認**: 約 22.4MB（23,513,657 bytes）であること。
     Mac側で「破損DLした .pt を読み込むと謎のハングを起こす」事象を確認済み。
     サイズが合わなければ削除して再ダウンロードすること
4. `pm2 restart motion-lab-server`
5. **同じ動画（2fda2815、「P1検証」フォルダ）で再解析**:
   ```
   curl -X POST http://localhost:4000/api/videos/2fda2815-2073-4cd6-94d5-3d9dca9108ce/reanalyze
   ```
6. スタンドアロン動作確認が必要なら:
   ```
   <PYTHON_BIN> server/analysis/analyze_pair.py <動画パス> server/models/yolov8s-pose.pt out.json debug.mp4
   ```

### 報告してほしいこと（Mac側ローカル実測との一致確認）

Mac側（Apple Silicon）で同じ動画・同じコードの実測値は以下。ThinkCentre（CPU）でも
ほぼ同じ数値になるはずなので、大きくズレたらその旨を報告してほしい:

| 指標 | Mac実測 | 意味 |
|---|---|---|
| 2人同時検出 | 279/315 (88.6%) | MediaPipe 時代は 4%。移行の本丸 |
| `reliability.allPairFrames` | 148 | 上記から見切れフレームを除いた verdict 母集団 |
| `reliability.edgeClippedPairFrames` | 131 | 画面端見切れで除外（この動画は縦画面で見切れ多） |
| `verdictByRule.leaderExists` | true | |
| **`leaderAtStart`** | **`{side: right, t: 1.7}`** | **右=男性で正解** |
| `separation` | 0.3652 | |
| `highSideConsistency` | 0.594 | 交差（ターン）が多い動画なので低くて正常 |
| `reliability.cleanRatio` | 0.966 | |
| 解析所要時間 | 31.5秒動画で約1分30秒 | MediaPipe Heavy より速いはず |

- 解析所要時間（CPU での実測。Mac比でどの程度か）
- デバッグ動画URL（人間が目視確認する）:
  `https://motion-lab-apa.pages.dev/relay/analysis-output/<ジョブID>/out/debug_roi.mp4`

### 補足
- pip install で `--user` が効かない・PATH問題等で詰まったら、venv 方式
  （`<PYTHON_BIN> -m venv server/analysis/venv` → その python を PYTHON_BIN に設定）でもよい。
  動けば方式は問わない
- MediaPipe / Heavy モデルは**削除しないこと**（回転解析で引き続き使用中）

---

## 追加タスク（2026-07-29・その7）: P2（Claude裁定）の有効化 + デバッグ動画の色分け改善の取り込み

P2 を実装した。`salsa-pair` プリセットは今後 CV計測 → **claude CLI によるヘッドレス裁定** → レポート生成まで自動で行う。**claude CLI が未導入のままだとジョブが `[CLAUDE]` エラーで止まる**ので、その6（YOLO移行）とまとめて以下を実施してほしい。

### 変更内容（git pull で入る）
1. `src/claudeRunner.ts` — ジョブ作業ディレクトリで `claude -p` をヘッドレス実行（プロンプトは stdin 渡し、`--allowedTools "Bash(python*) Read Write"`、`--output-format json`）
2. `src/jobWorker.ts` — Claude 失敗の5分岐（レート制限→バックオフ付きリトライ / ログイン失効→即エラー / タイムアウト・その他→1回リトライ）
3. `prompts/runner-prompt.md` — 裁定プロンプト（result.json スキーマは「開始時点の左右」方式）
4. `src/presets.ts` — `salsa-pair` の `useClaude: true` に切り替え済み
5. **デバッグ動画の色分け改善**（analyze_pair.py）: 服装・肌の色ヒストグラムで人物を追跡し、
   動画全体の SHR 集計で決めた Leader=青 / Follower=ピンク を全編一貫して塗る
   （従来のフレーム毎 SHR 勝負は横向きで色がチラつく問題があった。Mac側で全編検証済み）

### やってほしいこと

1. `git pull` && `cd server && npm install`
2. **claude CLI の導入（非管理者アカウントで可能な方式）**:
   ```powershell
   # npm のグローバル先をユーザーローカルに変更（管理者権限不要にする）
   npm config set prefix "$env:USERPROFILE\.npm-global"
   npm install -g @anthropic-ai/claude-code
   # PATH にユーザー環境変数として追加（PowerShell。既存PATHは壊さないこと）
   [Environment]::SetEnvironmentVariable("Path", $env:Path + ";$env:USERPROFILE\.npm-global", "User")
   ```
   - 新しいターミナルで `claude --version` が通ることを確認
   - `claude` を**対話起動して初回ログイン**（Anthropic アカウント。Max サブスクの認証情報は PC の持ち主に確認）
3. `.env` に `CLAUDE_BIN` を設定（PATH が pm2 経由で通らない場合に備えフルパス推奨）:
   ```
   CLAUDE_BIN=C:\Users\<ユーザー名>\.npm-global\claude.cmd
   ```
4. `pm2 restart motion-lab-server` → `curl http://localhost:4000/api/health` の `claude` が `"ok"` になることを確認
5. 同じ動画（2fda2815）で再解析。今回は Claude 裁定まで走る:
   ```
   curl -X POST http://localhost:4000/api/videos/2fda2815-2073-4cd6-94d5-3d9dca9108ce/reanalyze
   ```

### 報告してほしいこと
- health の `claude` フィールドの値
- ジョブの reportMd（Claude が書いたレポート）と `out/result.json` の中身
- Claude 裁定パートの所要時間（CV計測と別に）
- デバッグ動画URL（色分けが全編で正しいか人間が目視確認する）
- claude CLI 導入で詰まった場合はその状況（管理者権限を要求された等）を正直に

### 注意
- `RELAY_SECRET` と同様、Claude のログインセッションはこの PC 固有。`claude` の認証情報をリポジトリにコミットしないこと
- レート制限（Max サブスクの使用量上限）に当たるとジョブは自動で15分×N のバックオフ再試行になる。`pm2 logs` に `rate-limited` が出ていたら異常ではない

---

## 追加タスク（2026-07-30・その8）: 技イベント検出（Turn/CBL タイムスタンプ）の取り込み

ロードマップ②の第一弾。`analyze_pair.py` に技イベント候補の検出を追加した。
レポートに「0:12 ターン（フォロワー）」「0:19 クロスボディリード」のようなタイムラインが載るようになる。

### 変更内容（git pull で入る）
1. **Turn 検出（向き反転方式）**: COCO の左肩/右肩の画面上の並び順（符号）は体の向きを直接表す。
   「1.5秒以内の2回反転（=一回転）+ 反転前後にしっかり正面/背面まで振れた」をターンとする。
   初版の「肩幅の収縮」方式は見逃し・誤帰属が多く廃止（人間の目視評価でNG）
2. **リーダーの随伴回転フィルタ**: CBL の±1.2秒・フォロワーのターンの±1.2秒以内の
   「リーダーのターン」は棄却（CBLのピボット動作・相手を回すときの上体回転はターンではない）。
   リーダーの単独ターンのみ検出される
3. **CBL 検出**: 2人の腰X座標の交差（左右の入れ替わり）。交差前後2秒以内に十分な分離があるものだけ採用（密着ジッタを除外）
4. 出力: `measurements.json` の `summary.events[]` = `{t, type: "Turn"|"CBL", by: "leader"|"follower"|"pair"}`。同種イベントは2.5秒のクールダウン
5. デバッグ動画に検出瞬間の黄色ラベル（`TURN (follower)` 等）を1.2秒焼き込み
6. runner-prompt: Claude が events 候補を検分し、明らかな誤検出を落としてレポートの「技のタイムライン」表に載せる
7. サルサ（ペア）フォルダの指示書を version 2 に更新済み（Mac側からリモートで実施済み — ThinkCentre側の作業不要）

### やってほしいこと
1. `git pull` && `pm2 restart motion-lab-server`
2. 同じ動画（2fda2815）で再解析し、以下を報告:
   - `summary.events` の件数と内訳（Mac実測: **14件 = CBL 6 + フォロワーのターン 8、リーダーのターン 0**。
     目視答え合わせ済みで、ターンは全て実際に女性が回っている瞬間だった）
   - Claude レポートの「技のタイムライン」表が妥当か（Claude が何件落としたか）
   - デバッグ動画URL（黄色い技ラベルの焼き込み確認用）

### 既知の限界（報告不要・情報共有）
- 密着すれ違いの瞬間に片方が完全に隠れると、鏡の撮影者が一瞬ペアの2人目として拾われることがある（8.9秒付近で実例確認済み。すぐ復帰するため実害は小）
- 「両者が同時に回る技（ダブルターン等）」ではリーダー側が随伴回転フィルタで消される（precision優先の設計判断）
- この検証動画の**末尾2秒は録画停止時のiPhoneコントロールセンター画面**が映り込んでいる（検出への実害なし）
