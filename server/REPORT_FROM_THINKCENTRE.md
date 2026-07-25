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
