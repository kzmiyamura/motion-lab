# 正解表（eval_ground_truth.py が読む）

1 動画 = 1 ファイル（`<名前>.json`）。このディレクトリに置けば `python analysis/eval_ground_truth.py` が全部拾う。

## 書き方

時刻はすべて動画の秒（小数1桁でよい。照合は ±1.0 秒）。分からない項目は `null`。
自信がない出来事には `"optional": true` を付ける（当たっても外れても数えない）。

| キー | 中身 |
|---|---|
| `video` | 何の動画か（人が読むメモ） |
| `job` | 解析ジョブ ID（`storage/analysis-jobs/<job>/out/measurements.tracks.json` を読む） |
| `outDir` | ジョブを経ずに解析した動画だけ。`storage` からの相対パス（例 `gt-sheets/8c312c6d/out`）。`job` より優先 |
| `holdout` | `true` = 検出器のチューニングに使っていない検証用（メモ。採点は同じ）。この動画を見ながら閾値を合わせない。`outDir` がローカルの storage に無ければ採点は飛ばされる。開発に使ったら `false` にして `role` に何に使ったかを書く（cap1790: `"dev (used to build the waist-up fallback, 2026-10-05)"`） |
| `leaderAtStart` | 冒頭で男性が画面の `"left"` / `"right"` どちらか（メモ。採点はしない — 入場直後や冒頭の CBL で「冒頭」が定まらないため。人物の取り違えは各 CBL の `from` で測る） |
| `evalRange` | 採点する範囲 `[開始秒, 終了秒]`。録画停止時の画面・リールのループなどを外す。範囲外の検出は無視する（省略時は全編） |
| `turnTime` | ターンの `t` を回転のどこに付けたか。`"mid"` = 回転の真ん中（memo の範囲の真ん中）、`"start"` = 回り始め。採点はこれに合わせて検出の `tMid`（回転の範囲の真ん中）か `t`（回り始め）と照合する（`eval_ground_truth.py --turn-match`、README 28）。省略時は `"start"` 扱い。新しく書くときは `"mid"` で、memo に回転の範囲（`0:07.8〜0:09.4`）を書く |
| `turnsComplete` | `false` = ターンを全部は拾えていない（速くて 0.5 秒刻みで読めない等）。ターンの誤検出を数えない（省略時 true） |
| `cbl[]` | 男女の左右の入れ替わり。`kind`: `"cbl"`（クロスボディリード）/ `"swap"`（その他の入れ替わり）。`from`: 入れ替わる前に女性がいた側 `"left"`/`"right"`。`depth`: 女性が男性の手前を通ったら `"near"`、奥なら `"far"`。`leaderHandRaised`: 男性が手を頭上に上げたか（true/false） |
| `turns[]` | ターン。`by`: `"follower"`/`"leader"`。`runs`: 回った向きと回数の並び（`dir` は本人から見て `"left"`=反時計回り / `"right"`=時計回り。途中で逆回りに変わったら run を分ける） |
| `holds[]` | その時刻に手をつないでいる手。`leader` / `follower` は `"L"` / `"R"` / `"both"` / `null`（離している） |

画面上の「左右」は撮影者から見た左右。回転の向きだけは本人から見た向き。

**回転数の決まり**: CBL の通過に続けて回るもの（CBL＋インサイド/アウトサイド）は、通過の½回転も回転数に含める
（CBL＋インサイド = 1½、ダブルは 2½。`docs/salsa-knowledge/on2-timing-and-terms.md` §5・§8-4 と同じ）。
2026-10-04 に全ファイルをこの決まりに揃えた（img1884・screenrec は「ターンだけで 1」と書いていたので 1½ に直し、`note` に残した）。

## 例（1 件ずつ）

```json
{
  "video": "2fda2815（ScreenRecording 03-19 17-30、約31秒）",
  "job": "87003970-09bc-4030-8a6e-156f140d296a",
  "leaderAtStart": "right",
  "notes": ["振り返るだけの動きはターンに入れない"],
  "cbl": [
    {"t": 3.5, "kind": "cbl", "from": "left", "depth": "near", "leaderHandRaised": false, "memo": "0:03 CBL"}
  ],
  "turns": [
    {"t": 5.2, "by": "follower", "runs": [{"dir": "right", "turns": 1}], "memo": "0:05 アウトサイドターン"},
    {"t": 9.0, "by": "follower", "runs": [{"dir": null, "turns": null}], "optional": true, "memo": "回ったか読めない"}
  ],
  "holds": [
    {"t": 7.1, "leader": "L", "follower": "R"}
  ]
}
```

（上の時刻は書式の例で、実際の正解ではない）

## 目視用のコマ一覧

`storage/gt-sheets/<動画ID先頭8桁>/sheet_NN.jpg` — 0.5 秒刻み、5 列 × 8 行（1 枚 = 20 秒）、各コマ左上に秒数。
