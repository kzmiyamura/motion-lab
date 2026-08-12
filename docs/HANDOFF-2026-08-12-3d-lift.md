# 引継ぎメモ 2026-08-12 — 2D→3D復元パイプラインと3Dタブ

> **2026-08-12 3セッション目の追記（最新状態はこちら）**
>
> - **relay 配信化 完了**: クリップを `public/motion/` から撤去し、`server/storage/lift3d/`
>   （gitignore 済み）から `GET /api/motion`（一覧）/ `GET /api/motion/:id`（本体）で配信する
>   （`server/src/routes/motion.ts`）。フロントは `VITE_HOME_SERVER_URL` 経由で取得
>   （本番は relay 固定URL、Pages の環境変数は設定済み）。relay 経由の疎通確認済み
> - **クリップ切替UI 完了**: 3Dタブに 🎞 セレクタ（クリップが2本以上あるとき表示）。
>   3本（2fda2815 / 8c312c6d / bb0efcb9）を切替可能。表示名は
>   `server/storage/lift3d/manifest.json`（手書き・任意）で付与
> - **履歴スクラブ 完了**: リポジトリは **PUBLIC** のため、ファイル削除だけでは未push履歴の
>   blob が push で公開されてしまう。`git filter-branch` で未push全コミットから
>   `public/motion/2fda2815.json` を除去した（**コミットIDが全て変わった**。本メモ内の
>   旧ハッシュは書き換え前のもの。旧履歴はローカルの `backup-pre-scrub` ブランチに保全 —
>   **このブランチは絶対に push しないこと**。push 後に不要なら削除してよい）
> - **push は技術的に安全になった**。実行するかは引き続きユーザー判断待ち。
>   push すると Cloudflare Pages が自動ビルドし、3Dタブは relay 経由でクリップを読むようになる

> **2026-08-12 2セッション目の追記**
>
> 下記「次の一手」4項目は消化済み。新セッションはこの追記と
> docs/lift3d-shooting-conditions.md を先に読むこと。
>
> - **① 3Dホールド追加検出 完了**（`e06487d`）: prototype_pairfix.py に
>   「両手首が実観測かつ3D距離<35cm持続」の区間検出を追加（--hold3d-* で調整可）。
>   2fda2815 で拘束カバレッジ **6% → 47%**（区間2本→14本）。プレビュー目視で破綻なし
> - **② ハイブリッドモード 完了**（`a937ada`）: src/components/HybridFigure.tsx 新規。
>   動線・胴体ヨー（unwrap+平滑化）・拍・技イベントは実データ、手足はB方式の手続きアニメ。
>   ヨー符号は「鼻は肩中点より前方」検証で確認済み（81%/71%整合）。
>   beatGrid は prototype_export_clip.py の `--measurements` でクリップに同梱。
>   3Dタブ「🧬 動線×アニメ（ハイブリッド）」ボタンで実機ブラウザ動作確認済み
> - **③ ビート同期ステップ**: ハイブリッドの脚が拍同期ステップ（歩幅=実速度連動）に
>   なったので製品面では実質カバー。mocap 直再生側の脚欠落埋めは未実装のまま
> - **④ 条件出し 完了**（`8274008`）: 3本の実測比較は docs/lift3d-shooting-conditions.md。
>   腕観測率は3本とも46〜53%で頭打ち（相互オクルージョン起因を実証）。
>   推奨撮影条件は距離4m前後・横画面。8c312c6d / bb0efcb9 の2D原盤とクリップは
>   server/storage/lift3d/ に退避済み（gitignore対象。scratchpad は消える）
>
> **未決はひとつ: push するか**（ローカル9コミット先行）。public/motion/2fda2815.json が
> 個人の練習動画由来のため保留中。公開回避なら relay 配信化（クリップ3本になったので
> サイズ的にもその方が筋）。ユーザーの指示があるまで push しないこと。
>
> 次の候補: relay 配信化 / 3Dタブのクリップ切替UI（3本対応）/ mocap側の脚欠落埋め（③の残り）

## この一連の作業で何ができたか

「3Dタブの骨格人形を動画の実モーションで踊らせる」を実現した。
2D原盤（tracks.json）→ 3D復元 → Web再生までのパイプライン一式。

- 本番3Dタブ（`SalsaStage3D.tsx`）に「🎥 動画のモーションで踊る」ボタン追加済み
- 自由視点カメラ（ドラッグ横=回り込み/縦=見下ろし、ホイール=ズーム、プリセット5種）
- クリップは `public/motion/2fda2815.json`（559KB, 30fps, 892フレーム）
- 検証用2画面動画: https://motion-lab-apa.pages.dev/relay/analysis-output/87003970-09bc-4030-8a6e-156f140d296a/out/lift3d_preview.mp4

## コミット状態

ローカル4コミット（`d005b6c` `a202719` `db81d06` + pairfix）が **push 保留中**。
理由: `public/motion/2fda2815.json` は個人の練習動画由来のモーションデータで、
push すると本番URLで公開される。骨格座標のみとはいえ判断はユーザーに委ねた。
公開したくない場合は public/ をやめて relay 配信に変える（559KBなのでサイズ的にもその方が筋）。

## パイプライン（server/analysis/）

一括実行: `python server/analysis/run_lift3d_pipeline.py <tracks.json> <video> <model.task> <out.json> [--preview out.mp4]`

| 段 | スクリプト | 役割 |
|---|---|---|
| 1 | prototype_lift3d.py | YOLOのbboxで1人ずつ切り出し→MediaPipe単人検出→座標変換→弱透視配置。`--fps 30`で密に取り直す（bboxは補間・姿勢は再推論）。唯一重い段（CPU約5分） |
| 2 | prototype_refocus.py | 焦点距離の差し替え（幾何のみ再計算） |
| 3 | prototype_smooth3d.py | 欠落の時間補間+平滑化 |
| 4 | prototype_groundplane.py | 床拘束で人物ごとの体格バイアス補正（倍率は定数） |
| 5 | prototype_bonelength.py | 剛体拘束: 胴体4点をKabschで板として当てはめ+骨長固定（zだけ動かす）+胴体回転の頭打ち30度/フレーム |
| 6 | prototype_armfix.py | 腕の外れ値除去（胴体基準の局所座標で判定・全フレーム同一経路で決定） |
| 7 | prototype_pairfix.py | ホールド拘束（手首観測の転写+2ボーンIK）+接地ロック（footskate除去） |
| 8 | prototype_export_clip.py | Web用13関節クリップ書き出し（床y=0正規化・--target-height 1.70） |
| 検証 | prototype_render3d.py | 2画面（正面+軌道カメラ）mp4 |
| 検証 | prototype_calib_f.py | 焦点距離のPnPスイープ推定 |

## 技術上の重要な知見（再発見に時間がかかるもの）

1. **MediaPipeは切り出せばペアでも使える**: 全画面2人同時検出4%が移行理由だったが、
   YOLOのbboxで1人ずつ切り出せば99.5%。単人精度の問題ではなかった
2. **座標変換**: MediaPipe world→three.js は (x,y,z)→(x,-y,-z)（X軸180度回転、行列式+1）。
   1軸だけ反転すると鏡像の踊りになる
3. **弱透視の位置復元**: px_per_m は12本のボーン投影比の中央値（肩幅1本だと横向きで暴れる）。
   f は横位置・高さに効かず奥行きスケールのみ（式で約分）
4. **焦点距離**: この動画では f>=1750 までしか絞れない（望遠側の谷が平坦）。f=2524採用
5. **骨長は2D投影長の高パーセンタイルで決める**: 垂直になった瞬間に投影長=真値、
   それ以外は必ず短い→上側が真値に漸近。zを使わない
6. **zの符号は当てにならない**: 全ボーンの38%が時間連続性で符号を選び直された。
   dz≈0付近の符号ノイズ反転は子関節を2×dz瞬間移動させる
7. **胴体ヨーの暴れは前後反転ではない**: 2択（180度反転）は一度も発動しなかった。
   真横を向いた瞬間に肩が線に潰れzノイズがヨーを支配する連続的な暴れ→回転量の頭打ち(30度/f)で解決
8. **メタデータより観測**: sampledFps は上流で取り直すと古い値が残る。後段は全部
   タイムスタンプ実間隔からfpsを出す
9. **部分補間は境目で新しい飛びを作る**: 短い欠落だけ補間して長い欠落を残すと悪化する
   （実測46cm→92cm）。同じ関節は全フレーム同一経路で決める
10. **ホールド拘束の診断値**: つないでいるはずの手首間距離 median 26.5cm / p95 65cm
    = 腕推定誤差の実測値

## 現状の限界（正直な評価）

- 腕の実観測率 35〜54%、脚もかなり補間（薄い線で描画される）。単眼ペアの相互オクルージョンが
  原因なので後処理では増えない
- ホールド拘束のカバレッジ6%（この動画はターン主体でholdTimelineが2区間しかない）
- 手首の1フレーム移動 max 50〜70cm 残存。骨長CVは全ボーン0.0%、胴体急変ゼロ
- MediaPipeの身長推定は過小（1.43m）→ export時に一様スケールで1.70mに合わせている

## 次の一手（推奨順・ユーザー合意済みの方向）

1. **3Dホールド追加検出**（安い）: 両手首が実観測かつ3D距離<35cm持続の区間を
   holdTimelineに追加し、拘束カバレッジを6%から引き上げる
2. **ハイブリッドモード**（製品価値最大）: 信頼できる量（root軌跡・胴体向き・技イベント・拍）
   だけ抽出し、手足はB方式のクリーンなアニメで描く「実データの動線×テンプレの手足」。
   ロードマップ「ジェネレーターで動画ルーティン再現」への本命
3. **ビート同期ステップ合成**: 脚の欠落をベーシックステップのテンプレを beatGrid 位相に
   固定して埋める（BPM・On1/On2解析済み）
4. **動画の条件出し**: 残り2本（8c312c6d / bb0efcb9）で観測率を測り撮影ガイドに落とす

## 環境メモ

- この作業マシンは ThinkCentre 本体（server/ が動いている実機）。PYTHON_BIN =
  `C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe`
- mediapipe は今回 pip install した（requirements.txt にあったが未インストールだった。
  = analyze_rotation.py はこれまで ImportError で動かなかったはず）
- `three` / `@react-three/fiber` も今回 npm install した
- 中間ファイル: scratchpad の `l30_*.json` 系（セッション終了で消える。再現は
  run_lift3d_pipeline.py で数分）
