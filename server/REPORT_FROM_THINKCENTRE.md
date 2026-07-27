# ThinkCentre側 作業報告（2026-07-25）

`server/CLAUDE.md` の指示に基づき作業を実施済み。以下、指示書の「完了後に報告すること」への回答。

## 実施状況

| # | タスク | 状態 |
|---|---|---|
| 1 | Node.js確認/インストール | 完了（v24.16.0） |
| 2 | `npm install` | 完了（下記の理由でbetter-sqlite3→node:sqliteに変更） |
| 3 | `.env`作成 | 完了（`.env.example`のままでOK） |
| 4 | 起動確認 | 完了（`/api/health`→`{"status":"ok"}`） |
| 5 | 実機変換テスト | 成功。テスト動画アップロード→`status:"ready"`→`playlist.m3u8`・`segment_000.ts`・サムネイルjpgの生成をファイルで確認済み |
| 6 | 常駐化 | 完了（下記の理由で指示書の推奨方法とは別の方式） |
| 7 | Cloudflare Tunnel外部公開 | 完了（下記の理由でQuick Tunnelで代用） |

## 報告事項

1. **Tunnel公開URL**: `https://tribute-commands-decide-gold.trycloudflare.com`
   Cloudflare Pagesの`VITE_HOME_SERVER_URL`に設定・再デプロイ済み、ビルド後のバンドルに反映されていることも確認済み。

2. **ステップ5（実機変換テスト）**: 成功。

3. **常駐化方式**: PM2（`motion-lab-server` / `motion-lab-tunnel`）。
   指示書は「PM2 + pm2-windows-startup」または「タスクスケジューラでログオン時実行」を推奨していたが、**このWindowsアカウントには管理者権限がなく、`schtasks`の`onlogon`トリガー作成が "アクセスが拒否されました" で失敗**（`pm2-windows-startup`も内部的にサービス登録を行うため同様に失敗する見込み）。
   代替として、管理者権限不要な **スタートアップフォルダ方式** を採用: `server/pm2-resurrect.cmd`（`pm2 resurrect`を呼ぶだけの薄いラッパー）を `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` にコピー。ログオン時に自動実行され、`pm2 save`済みのプロセス（サーバー・Tunnel）が復元される。

4. **`npm run start`実行時の警告/エラー**:
   `better-sqlite3`がこのNode(v24)/Windows環境向けのプリビルドバイナリを持たず、ソースビルドにはPython + Visual Studio Build Toolsが必要だった。Build Tools（数GB）のインストールは避け、代わりにNode.js組み込みの`node:sqlite`モジュールに置き換えて解決（`db.ts`のみ変更、他のコードはAPI互換のため無修正）。この変更は既にコミット・プッシュ済み（`fix: better-sqlite3をnode:sqliteに置き換えてThinkCentre実機でのビルドを可能に`）。

5. **ドメイン不所持のためQuick Tunnelで代用**:
   Cloudflareアカウントに登録済みドメインがなく、名前付きTunnelのPublic Hostname機能（固定URL）が使えなかった。代わりに`cloudflared tunnel --url http://localhost:4000`のQuick Tunnelモードを使用。
   **既知の制約**: Quick TunnelのURLは`cloudflared`プロセスが切断・再起動すると変わる（実際に約31時間で切断・再接続失敗が発生し、URLが変わった）。その都度、新URLの確認とCloudflare Pages側`VITE_HOME_SERVER_URL`の更新・再デプロイが手動で必要。恒久対策として以下のいずれかを検討中:
   - ドメインを取得して固定URLの名前付きTunnelに切り替える（最も確実）
   - 無料のCloudflare Workers（`*.workers.dev`固定URL）でTunnel URLの解決を仲介する仕組みを作り、フロントエンドがビルド時ではなく実行時にURLを取得する方式に変更する

## 触れていないもの

- Cloudflare Access設定（Phase 2、スコープ外のため未着手）
- `src/`・`wrangler.toml`（フロントエンド側、指示書通り無変更）

---

# ThinkCentre側 作業報告（2026-07-27）: 固定URL中継（tunnel-wrapper）導入

`server/CLAUDE.md` の「追加タスク（2026-07-27）」を実施。以下、指示書の「報告してほしいこと」への回答。

## 実施内容

1. 既存の `motion-lab-tunnel`（`cloudflared` を直接起動していたPM2プロセス）を `pm2 delete` し、代わりに `server/tunnel-wrapper.mjs` を起動する構成へ変更。
2. PM2起動時に環境変数を設定（`RELAY_REPORT_URL` / `RELAY_SECRET` / `HOME_SERVER_PORT=4000` / `CLOUDFLARED_PATH`）。
3. `pm2 save` で dump 更新（スタートアップフォルダ方式の `pm2 resurrect` で復元される）。

## ⚠️ tunnel-wrapper.mjs を1点修正（Mac側で確認をお願いします）

**症状**: ラッパーをそのまま起動すると `Error: spawn cloudflared ENOENT` で即クラッシュ→PM2が無限再起動。
**原因**: 実機の `cloudflared` は `C:\Program Files (x86)\cloudflared\cloudflared.exe` にフルパス設置されており、**PATHに通っていない**。ラッパーは `spawn('cloudflared', ...)` とハードコードしていたため見つけられなかった（既存の直接起動PM2プロセスはフルパス指定だったので動いていた）。
**修正**: `CLOUDFLARED_PATH` 環境変数でバイナリのパスを指定可能にした（未指定時は従来通り `'cloudflared'`）。差分は以下2箇所のみ、挙動はデフォルトで後方互換:
```js
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_PATH ?? 'cloudflared';
...
const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${PORT}`], { ... });
```
→ この変更はコミット・プッシュ済み。Mac側で問題なければそのまま残してください。

## 報告事項

1. **動作確認（指示書ステップ4）**: すべて成功。
   - `pm2 logs` に `[tunnel-wrapper] reported new URL: https://...trycloudflare.com` が出力される。
   - `GET https://motion-lab-apa.pages.dev/relay/report` → `{"target":"https://receiving-trend-slight-oct.trycloudflare.com","updatedAt":"2026-07-27T13:43:44Z"}` と反映を確認。
   - `GET https://motion-lab-apa.pages.dev/relay/api/health` → `{"status":"ok"}`。**固定URL経由でThinkCentreに到達できることを確認済み**。

2. **再起動時の自動報告（指示書ステップ5）**: 成功。`pm2 restart motion-lab-tunnel` で意図的に落としたところ、cloudflaredが新URLを発行し、ラッパーが自動的に `/relay/report` へ再報告、relay側の `target` も新URLへ更新された（`sudden-improving-sen-armed` → `receiving-trend-slight-oct`）。

3. **cloudflaredのURL出力先と正規表現**: URLは **stderr** ではなく **stdout** に `INF` ログとして出力されていた（`INF | Your quick Tunnel has been created! ...` 付近）。ラッパーは stdout/stderr 両方を監視しており、正規表現 `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/` で問題なく1発で拾えている。調整不要。

4. **常駐化・再起動後の維持**: `pm2 save` 済みのため、スタートアップフォルダ方式の `pm2 resurrect` で `tunnel-wrapper.mjs` ごと復元される見込み。環境変数（`CLOUDFLARED_PATH` 含む）もPM2 dumpに保存済み。次回PCログオン後に実際の復元も確認予定。

## 触れていないもの

- `functions/`・`wrangler.toml`（Cloudflare Pages側、指示書通り無変更）
- `RELAY_SECRET` の値は変更していない（Mac側と同一値のまま）

---

# ThinkCentre側 作業報告（2026-07-28）: Tunnel沈黙（毎日周期）の原因特定と恒久対策

`server/CLAUDE.md`「追加タスク（2026-07-28）」を実施。復旧＋根本原因特定＋再発防止まで対応した。

## 1〜4. 状態確認・復旧結果

- **`pm2 list`**: `motion-lab-tunnel` は **`online` のまま**（`stopped`/`errored` ではなかった）。ここが今回の核心。
- **実際の到達性**: 固定URL経由 `GET /relay/api/health` は **Cloudflare Error 1016（Origin DNS error）** を返し、relay の `target`（`receiving-trend-slight-oct...`）は**死んでいた**。ローカル `http://localhost:4000/api/health` は `{"status":"ok"}` で正常 → **サーバーは無実、トンネルだけが死亡**。
- **復旧**: `pm2 restart motion-lab-tunnel` で新URL発行・報告を確認。`updatedAt` も最新化。
  - 復旧後: `GET /relay/report` → 新URL、`GET /relay/api/health` → `{"status":"ok"}`。

## 5. 落ちた原因（ログから特定）

`pm2 logs motion-lab-tunnel` の out.log に、以下が**数秒間隔で延々**記録されていた:

```
ERR failed to serve tunnel connection error="control stream encountered a failure while serving"
ERR Serve tunnel error error="control stream encountered a failure while serving"
INF Retrying connection in up to 1m4s
```

**結論**: Quick Tunnel が Cloudflare エッジ側で失効した後、`cloudflared` は **プロセスとしては生き続けたまま、死んだトンネルへの再接続を無限リトライ**していた。

→ 指示書が懸念していた通り、**`tunnel-wrapper.mjs` の自動復旧ロジック（`proc.on('exit')` での再spawn）が効いていなかった**。原因は明確で、旧ラッパーは「cloudflared プロセスが**終了**したとき」しか再spawnしない設計だったため、「プロセスは生きているがトンネルは死んでいる」今回のケースを検知できなかった。これが「PM2上は online なのに約1日周期で沈黙する」正体。

## 再発防止（恒久対策）— ラッパーに能動ヘルスチェックを実装（コミット済み）

`tunnel-wrapper.mjs` に **能動ヘルスチェック watchdog** を追加した:

- 30秒ごと（`HEALTH_PROBE_MS`）に、報告済みURL経由で `GET <currentUrl>/api/health` を実際に叩く
- **3回連続失敗（≈90秒, `HEALTH_FAIL_MAX`）** で「トンネル死亡」と判定し、`cloudflared` を `kill()` → 既存の再spawnロジック経由で新トンネルを起動 → 新URLを自動報告
- 正常時は無音（誤発火なし）。検知時間を **「約1日」→「約90秒」** に短縮

### 実地テスト結果（すべて成功）

- **正常時**: 1サイクル（35秒）待機して `health probe failed` ログが出ないことを確認（誤発火なし）
- **異常時（再spawn＆再報告チェーン）**: `cloudflared` 子プロセスを外部から強制終了 → ラッパーが自動再spawn → 新URL（`translate-...` → `plasma-...`）が relay に反映されることを確認
- 現在 `online`・health `{"status":"ok"}`・`pm2 save` 済み

→ Mac側が提案していた「別途cronでヘルスチェック」は、この**ラッパー内蔵watchdogで役割を包含**しているため不要（外部依存もなく検知も速い）。もし二重の保険が欲しければ別途cron追加も可。

## 所感・要確認事項

- **原因はネットワーク断ではなく Quick Tunnel の仕様上の失効**。Quick Tunnel は無料ベストエフォートで、Cloudflare も本番非推奨。今回のwatchdogで「落ちても90秒で自動復旧」にはなるが、**復旧のたびにURLが変わる**点は変わらない（固定URL中継のおかげでフロント側の手動更新は不要なまま）。恒久的に安定させたいなら、やはり**独自ドメイン取得 → 名前付きTunnel（URL不変・失効なし）**が本筋。判断はMac側にお任せ。
- **⚠ 掃除できなかったオーファン1件**: `cloudflared` PID 12580 が**管理者権限で起動された別系統**として残存しており、死んだトンネルにリトライし続けている（`taskkill /F` も「アクセス拒否」。当アカウントは非管理者のため kill 不可）。現行の正常トンネルとは無関係で運用影響なし。次回PC再起動で消える見込み。手動で消すなら**管理者権限のターミナルから** `taskkill /F /PID <pid>`（PCの持ち主に依頼）。
- なお `pm2 restart` 自体はプロセスツリーを正しく片付けており（ラッパー由来のcloudflaredは現行1つのみ残る）、上記オーファンはラッパー/pm2起因ではなく過去の手動起動の残骸と判断。

## 触れていないもの

- `functions/`・`wrangler.toml`（Cloudflare Pages側、無変更）
- `RELAY_SECRET` の値（無変更）
