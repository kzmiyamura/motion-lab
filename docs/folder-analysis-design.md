# 設計書：フォルダ別MD解析指示書パイプライン

作成: 2026-07-29
状態: 設計確定（実装前）

---

## 1. 目的

HOMEタブ（ThinkCentre 動画ライブラリ）の**フォルダごとに「解析指示書（Markdownファイル）」を持たせ、動画が入ると指示書どおりの解析が自動で走る**仕組みを作る。

- 指示書は motion-lab の画面から編集できる
- 動画がフォルダに入ると、通常の加工処理（HLS変換）完了後に解析ジョブが積まれる
- 指示書を変更すると**それ以降に生成されるジョブから**有効になる
- LLM は **Claude Code ヘッドレス（`claude -p`）を Max サブスク契約アカウント**で ThinkCentre 上で動かす。API 従量課金は使わない

### 1.1 責務分担の大原則

> **JS/CV＝フレーム数に比例する「計測」。Claude＝1動画1回だけの「意味づけ・裁定」。**

- トークン消費が動画のフレーム数に比例する設計は**禁止**。全フレーム処理は MediaPipe / OpenCV（Python, ローカル, 無料）が担う
- Claude が見るのは「集計JSON＋見どころキーフレーム十数枚」のみ。1動画あたりの Claude 消費は動画の長さに依存せず一定
- 理由はコスト（Max の使用枠）だけでなく**精度**。タイムスタンプ・速度・角度など精密な数値は計算でしか出ない。LLM の目測はブレる。逆に「重なった2人のどちらが手前の男性か」「この動きは何の技か」という曖昧判断は LLM が得意

### 1.2 Max サブスクの制約と運用

- 制約はドルではなく**使用枠（5時間ローリング＋週次上限）と速度**
- 解析ジョブは**直列キュー**（同時に Claude を叩かない）
- 枠超過で `claude -p` が失敗したらジョブを `queued` に戻し、**指数バックオフで自動リトライ**（30分→1h→2h）。失敗させず待たせる。夜間に自然と消化される
- runner-prompt の固定部分はジョブ間で同一にし、**プロンプトキャッシュ**を効かせる
- 注意点（認識済み）: サブスクの自動ヘッドレス連続実行はレート制限に当たりやすく、ToS 上グレー。頻度を抑える設計（直列・呼び出し最小化）で運用する

---

## 2. 現状の土台（2026-07-29 時点）

| 資産 | 場所 | 使い方 |
|---|---|---|
| 動画パイプライン | `server/src/routes/videos.ts` | upload → ffmpeg変換 → `ready`（202即返し・バックグラウンド変換） |
| Python解析の前例 | `server/src/analysisJob.ts` + `server/analysis/analyze_rotation.py` | spawn → JSON → DB 保存・`running`フラグで直列化。**この型を汎用化する** |
| フォルダ | `folders` テーブル + `videos.folder_id`（1階層） | `server/src/routes/folders.ts` |
| MediaPipe Heavy モデル | `server/models/pose_landmarker_heavy.task` | CPU・低速でOK（リアルタイム不要）方針 |
| ブラウザ側の判定ロジック | `src/hooks/usePoseEstimation.ts` | SHR(3D肩腰比)・オクルージョン・zOrder — **Python に移植する元ネタ** |

**重要な現実**: 動画はアップロード時フォルダ無所属で、あとから PATCH で移動する。→ エンキューのトリガーは「ready 到達」と「フォルダ移動」の2ヶ所必要（§3.3）。

---

## 3. サーバー側設計（ThinkCentre / `server/`）

### 3.1 MD指示書の置き場所

```
server/storage/specs/<folderId>/analysis.md   ← フォルダの指示書（正本）
```

DB でなくファイル。Claude Code が Read で自然に読める形を正とする。

**新API**

| メソッド | パス | 役割 |
|---|---|---|
| `GET` | `/api/folders/:id/spec` | 指示書取得（無ければ 404） |
| `PUT` | `/api/folders/:id/spec` | 指示書保存（motion-lab UI のエディタから。body: `{ markdown }`） |

フォルダ削除時（`DELETE /api/folders/:id`）は spec ディレクトリも削除する。

### 3.2 ジョブキュー（新テーブル `analysis_jobs`）

```sql
CREATE TABLE analysis_jobs (
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL,
  folder_id     TEXT NOT NULL,
  spec_snapshot TEXT NOT NULL,  -- ★ジョブ生成時のMD全文コピー（「変更は以降から有効」の実装そのもの）
  status        TEXT NOT NULL,  -- 'queued' | 'running' | 'done' | 'error'
  retry_count   INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,           -- レート制限バックオフ用
  result_json   TEXT,
  report_md     TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);
```

- `spec_snapshot` により、過去レポートが「当時の指示書」を根拠として残る
- 同一 video に対する再実行は新しいジョブ行として積む（履歴が残る）

### 3.3 エンキューのトリガー（2ヶ所）

1. **`markVideoReady` 直後**（`videos.ts` の変換完了コールバック）
   — 動画にフォルダがあり、そのフォルダに spec があれば積む。アップロード API に `folderId` フィールドを追加（フロントも対応）
2. **`PATCH /api/videos/:id` で `folderId` が変わった時**
   — 移動先フォルダに spec があり `status === 'ready'` なら積む。**現運用ではこちらが主経路**

### 3.4 ワーカー（`analysisJob.ts` を汎用化）

- Node 内の**直列ループ**（既存の `running` フラグ方式を踏襲、同時実行1。解析中はアップロード 409 ブロックの流儀も踏襲）
- 1ジョブの実行手順:

```
storage/analysis-jobs/<jobId>/
  spec.md               ← spec_snapshot を書き出したもの
  video -> (originals/<videoId>.mp4 へのパス参照)
  tools/                ← Claude が追加実行してよい補助スクリプト
  out/
    measurements.json   ← CVパスの出力
    keyframes/*.jpg     ← 拮抗・見どころ区間の静止画
    report.md           ← Claude の出力（人間向け）
    result.json         ← Claude の出力（機械可読）
```

1. 作業ディレクトリを作成、`spec.md` を配置
2. **CVパス（Python）を先に全部実行** → `out/measurements.json` + `out/keyframes/`
3. **Claude Code をヘッドレス起動**（§4）→ `out/report.md` + `out/result.json`
4. DB へ保存 → `status = 'done'`。作業ディレクトリの一時物を掃除

> **設計判断**: 「Claude が対話的に CV を何度も指揮する」形にはしない。CV を先に済ませてから Claude を1回呼ぶ。Max 枠の消費とジョブ時間を予測可能にするため。ただし `tools/` 経由の追加計測は許可するので柔軟性は残る。

---

## 4. Claude Code 実行設計（Max サブスク）

### 4.1 起動

```
claude -p "$(cat runner-prompt.md)" \
  --allowedTools "Bash(python*) Read Write" \
  --max-turns 30
```

- **前提**: ThinkCentre に claude CLI をインストールし、**Max 契約アカウントでログイン**しておく（初回のみ人間が対話ログイン）。API キーは置かない
- カレントディレクトリはジョブの作業ディレクトリ

### 4.2 runner-prompt（固定部＋spec.md）

固定部の骨子:

> `spec.md` がこのフォルダの解析指示書である。`out/measurements.json` の計測値と `out/keyframes/` の画像**のみ**を根拠に判断し、`out/report.md`（人間向け・指示書のレポート形式に従う）と `out/result.json`（機械可読）を書け。追加計測が必要なら `tools/` のスクリプトを Bash で実行してよい。**動画のフレームを直接すべて見ることは禁止。**

- 固定部はジョブ間で完全に同一にする（プロンプトキャッシュのため）
- `contested`（拮抗区間）が空の場合、Claude は要約レポート生成のみ（画像すら見ない）＝最小消費

### 4.3 レート制限・失敗時

- `claude -p` が枠超過・一時エラーで失敗 → ジョブを `queued` に戻し `retry_count++`、`next_retry_at` を指数バックオフで設定（30分→1h→2h、上限例: 5回）
- 恒久エラー（spec 不正など）→ `status = 'error'` + `error_message`

---

## 5. MD指示書スキーマ

```markdown
---
preset: salsa-pair        # ワーカーがどのCVスクリプト群を走らせるかの決定キー
version: 1
---

# このフォルダの解析

## やること
- 各フレームの男女（Leader/Follower）判定
- 重なっている区間も手前/奥を判別
- ペア技が起きた時刻の一覧（技名つき）

## 判断のヒント（自由記述 — Claudeが読む）
- この教室の動画は基本、画面左からスタートするのが男性
- 体格差が小さいペアが多いので、迷ったら顔判定を優先して

## レポート形式
- 冒頭にサマリ（誰がリーダーか・自信度）
- 技のタイムラインを表で（mm:ss / 技名 / 自信度）
```

- **frontmatter の `preset` だけが機械処理対象**（ワーカーがどの Python を走らせるかを決める）。本文はすべて **Claude への自然言語指示**
- MD を「設定ファイル」ではなく「指示書」にするのがこの設計の核。ユーザーは自由文で書き足せて、次のジョブから効く
- preset は `salsa-pair` から開始。将来 `softball-pitching` 等を追加する拡張点（§8）

---

## 6. CVスクリプト設計（preset: salsa-pair の第1弾 `analyze_pair.py`）

`analyze_rotation.py` と同じ流儀（Heavy モデル・CPU・低速OK・JSON出力）。

**入力**: 動画パス / **出力**: `measurements.json` + キーフレームJPEG

```jsonc
{
  "fps": 30, "totalFrames": 5400,
  "persons": [
    // フレーム毎: slot0/1 の { t, hipX, hipY, shr3d, faceGender?, faceConf?, occluded, zFront }
  ],
  "summary": {
    "slot0": { "shrMean": 1.14, "shrStd": 0.03, "faceMaleRatio": 0.92 },
    "slot1": { "shrMean": 1.02, "shrStd": 0.04, "faceMaleRatio": 0.08 },
    "verdictByRule": { "leader": 0, "confidence": 0.88 },     // CVの一次判定
    "contested": [                                             // ★拮抗区間（Claudeが見る対象）
      { "from": 34.2, "to": 41.0, "reason": "shr_diff<0.05" }
    ]
  }
}
```

- SHR（3D肩腰比）・オクルージョン検出・zOrder 推定のロジックは `usePoseEstimation.ts` の実装を **Python に移植**（Pose Landmarker `numPoses=2`）
- **contested 区間のみ** ffmpeg で前後キーフレームを 3〜5 枚ずつ書き出す → Claude が見るのはこれだけ
- 顔性別は第1弾ではオプション（Python 側の顔モデル選定は実装時に判断。無くても SHR で一次判定は出る）

---

## 7. フロントエンド設計（motion-lab / `src/`)

1. **MDエディタ**: `HomeServerLibrary.tsx` のフォルダ選択中に「📝 解析設定」ボタン → モーダルで textarea 編集 + 保存（`PUT /api/folders/:id/spec`）。preset はセレクトで選び frontmatter を自動生成
2. **ジョブ状態バッジ**: 動画カードに ⏳queued / 🔬running / ✅done / ⚠error を表示。既存の `status` ポーリングと同じ流儀
3. **レポート表示**: ✅タップで `report.md` をモーダル表示（Markdown レンダリング）
4. （第2段）レポート内の `mm:ss` タップで FilePlayer にシーク

新API（フロント用に `engine/homeServer.ts` へ追加）:

| 関数 | エンドポイント |
|---|---|
| `getFolderSpec` / `putFolderSpec` | `GET/PUT /api/folders/:id/spec` |
| `listAnalysisJobs(videoId)` | `GET /api/videos/:id/jobs` |
| `getAnalysisReport(jobId)` | `GET /api/jobs/:id`（report_md / result_json を返す） |

---

## 8. サルサ解析の全体ロードマップ（責務分担つき）

「簡単×品質」の良い順。①でパイプラインの骨組みを通すことを最優先とする。

| 順 | 項目 | JS/CV（計測・毎フレーム） | Claude（判断・1動画1回） | 土台 |
|---|---|---|---|---|
| ① | 男女判定 | SHR・face性別・トラッキング | 拮抗区間(shr差<0.05)のみキーフレームで裁定 | 8割済（ブラウザ実装を移植） |
| ② | ペア技タイムスタンプ（候補） | 運動学特徴で候補イベント+時刻（Turn/CBL/Dip等、cooldown付き） | — （まず候補だけ出す） | 候補検出は済 |
| ③ | ビート格子 | 音声オンセット→BPM格子・足接地（足首Y極小）時刻列 | なし（純数値） | BPM検出は既存 |
| ④ | 重なり判別の底上げ | zOrder・2パスマスク・ファントム外挿 | 分離失敗の難フレームのみ裁定 | 実装済/不完全 |
| ⑤ | 技名ラベリング | （②の候補を流用） | 候補周辺キーフレーム+特徴量で技名確定・誤検出棄却・コンボ命名 | 未（品質要検証） |
| ⑥ | on1/on2 判定 | ブレイク（腰X速度ゼロ交差）時刻→拍ヒストグラム | ヒストグラム+数フレームで最終判断+自信度 | 弱い（最難） |
| ⑦ | 動体検知用データ収集 | ROI切出し・前フレーム位置ヒント・安定化・コントラスト補正 | なし | ①〜⑥の精度が頭打ちの箇所にのみ投入 |

### 将来: softball-pitching preset（参考・第2フェーズ以降）

- ボール/ベース/投手捕手の判別: 汎用物体検出（YOLO等）を server 側に追加
- ボール速度(km/h): **既知距離のキャリブレーション必須**（ベース間距離等を MD 指示書に書く）
- 回転方向: 縫い目トラッキングが必要で難しい
- 回転数(RPM): **通常のスマホ動画では不可**（240fps+ の高速度撮影が必要）。機材の壁でありコードでは越えられない

---

## 9. 実装フェーズ

| Phase | 内容 | Claude関与 | 完了条件（検証方法） |
|---|---|---|---|
| **P0 配管** | spec API・MDエディタUI・`analysis_jobs`・エンキュー2トリガー・直列ワーカー | なし（ダミージョブ） | フォルダ移動→ジョブが queued→done になる |
| **P1 CV計測** | `analyze_pair.py`（SHR・オクルージョン・contested・キーフレーム抽出） | なし | measurements.json を実動画で目視検証 |
| **P2 LLM判断** | claude ランナー＋runner-prompt＋report.md 生成＋UI表示 | あり | 実動画で男女判定レポートが出る |
| P3〜 | ②③④⑤⑥⑦ を順に preset に追記 | 項目による | 各項目ごと |

P0→P1→P2 の各段が**単独で動作確認できる**ことを重視する。

---

## 10. 主要な設計判断まとめ

| 判断 | 理由 |
|---|---|
| 全フレーム処理は CV、Claude は集計+キーフレームのみ | Max 枠がフレーム数に比例して枯渇するのを防ぐ。数値精度も計算の方が高い |
| CV を先に全部走らせてから Claude を1回呼ぶ | 消費とジョブ時間を予測可能に。対話的往復をなくす |
| spec_snapshot をジョブ行に保存 | 「MD変更は以降から有効」を仕組みで保証。過去レポートの根拠も残る |
| MD 本文は自然言語の指示書、機械処理は frontmatter の preset のみ | ユーザーが自由文で足せる柔軟性と、ワーカーの決定性を両立 |
| 直列キュー+バックオフリトライ | ThinkCentre は CPU のみ。Max のレート制限にも自然に適応 |
| 指示書はファイル（storage/specs/） | Claude Code が Read で読む形が正 |
