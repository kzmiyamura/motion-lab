# サルサ・パートナーワークを映像から認識・計測・記述するための手がかり

対象: motion-lab の解析パイプライン（YOLO/MediaPipe のキーポイント → Claude によるキーフレーム判定）。ユーザーは **On2（NY スタイル）** で踊る。
既存の `docs/salsa-partnerwork-reference.md`（技の辞書・回転方向の表）と `docs/salsa-move-grammar.md`（部品と状態の文法）を前提にし、**重複は避けて、研究・音楽・採点・技術の観点を補う**。
本文はすべて筆者の要約。引用は 15 語未満に限った。出典どうしで食い違う点には ⚠ を付けた。
調査日: 2026-10-03。出典は 67 件（同一論文の別ページを 1 件と数えると 65 件。末尾に一覧）。

---

## 1. 研究の現状 — 何が既にあり、何が無いか

### 1.1 サルサ専用のデータセット

| 名前 | 中身 | 本アプリへの意味 | 出典 |
|---|---|---|---|
| **CoMPAS3D**（Burkanova ほか, 2025） | 18 人・約 3 時間の**即興ペアサルサ**のモーションキャプチャ。初級・中級・プロの 3 段階。約 2,800 区間に技名・組み合わせ・実行エラー・スタイリングを注釈。SMPL-X フィットと音声付き | 現存する唯一の「サルサのペア × 技ラベル × 熟練度」データ。技の分類体系と**エラー分類**をそのまま借りられる | https://arxiv.org/abs/2507.19684v1 , https://huggingface.co/datasets/Rosie-Lab/compas3d |
| CoMPAS3D の技辞書 | 30 クラス（CBL / basic / copa / enchufla / 左右ターン / dile que no など）。**クラーベに合わせて 8 拍単位で区切る** | 本アプリの `routine` の 1×8 単位と一致する | https://arxiv.org/html/2507.19684v1 |
| CoMPAS3D のエラー分類 | `off beat`（音から外れる）/ `misinterpreted signal`（フォロワーがリードを読み違える）/ `misstep`（足の置き間違い）/ `mixed signals`（リードの合図が矛盾）/ `no error`。**最も多いのは off beat** | 採点で最初に作るべきは「タイミング」だと示唆する | https://arxiv.org/html/2507.19684v1 |
| CoMPAS3D の熟練度差 | プロは 1 演技あたりスタイリングが約 54.5 回、中級 12.9 回、初級 5.1 回。プロほど basic の比率が下がり、技の種類が増える | 「スタイリング頻度」「basic 比率」は熟練度の安価な指標になる | https://arxiv.org/html/2507.19684v1 |
| **Salsa beat 推定データセット**（Gómez-Marín ほか, 2024, TISMIR） | 124 曲・約 9 時間 52 分・49,433 拍の専門家注釈。1950〜2000 年代の録音 | 最新の TCN 系ビートトラッカーでも F 値 0.683（Ballroom データでは 0.956）。**サルサの拍を音から取るのは今でも難しい** | https://transactions.ismir.net/articles/183 |

### 1.2 ペアダンス・デュエット全般

| 研究 | 要点 | 出典 |
|---|---|---|
| Kouba（CVUT, 2021）: ペアの映像から社交ダンスの種目を当てる | OpenPose → グラフ畳み込み（MS-G3D）。Top-1 72.2%、音声分類器と組み合わせると 83.3%。**他の人が映ると大きく落ちる** | https://dspace.cvut.cz/entities/publication/bc26c864-72df-4d39-a997-fea5b99affc6 |
| Hu & Ahuja（ICCV 2021）HDVR | 2D 姿勢 → 追跡 → 3D 姿勢 → 部位ごとの動き → ジャンル、という階層。UID データセット（9 ジャンル、1,143 クリップ、約 30 時間）。サルサは含まない | https://arxiv.org/abs/2109.09166 |
| Let's Dance（Castro ほか, Georgia Tech） | YouTube の 10 秒クリップ 1,000 本・10 カテゴリ（latin・swing・tango など）。見た目だけでは足りず、**動き（光学フロー・骨格）が必要**と結論 | https://www.cc.gatech.edu/cpl/projects/dance |
| InterDance / DD100 / Duolando | デュエットの 3D データ（InterDance 3.93 時間、DD100 約 117 分）。「リーダーの動きからフォロワーを生成する」研究 | https://arxiv.org/html/2412.16982v1 , https://arxiv.org/html/2403.18811v1 |
| Invisible Strings（2025） | コンテンポラリーのデュエット動画 → 3D 姿勢 → GNN で「どの部位とどの部位が連動しているか」の重み付きグラフを推定 | https://arxiv.org/abs/2503.04816 |
| AfroBeats（YOLO + SAM, 2025） | 歩数・リズムの一貫性・空間の使い方を計測。著者自身が**単一動画での概念実証**と明言し、遮蔽の扱いは未記述 | https://arxiv.org/abs/2512.03509 |

**まとめ**: 「2D 単眼映像から、サルサのペアの技名と回転方向を 8 拍単位で起こす」研究は見つからなかった。近いのは CoMPAS3D（モーキャプ）と種目分類（Kouba、HDVR）まで。本アプリの狙いは研究の空白にあたる。

### 1.3 音なしで拍を取る（映像だけのビートトラッキング）

| 研究 | 要点 | 出典 |
|---|---|---|
| Pedersoli & Goto（ISMIR 2020） | ダンサーの骨格キーポイントだけから、各フレームが拍かどうかを TCN で分類する。周期性を利用する損失を加えると改善した。AIST データで評価 | https://program.ismir2020.net/poster_3-10.html |
| AIST++ の Beat Alignment Score | **動きの拍 = 関節速度の極小（止まる瞬間）**。音楽の拍は librosa で取り、両者の距離で評価する。動きの拍には対応する音の拍が必要だが、逆は要らない（片方向） | https://research.google/blog/music-conditioned-3d-dance-generation-with-aist/ |
| 歩行の接地検出 | 2D 姿勢から足の接地（heel strike）を検出する方法の比較。運動学的な方法（Zeni 法など）と LSTM は同程度の精度 | https://arxiv.org/html/2503.00794v1 |

### 1.4 体の向き・回転の推定（2D キーポイント）

| 研究 / 知見 | 要点 | 出典 |
|---|---|---|
| 姿勢推定の誤りの分類（Ronchi & Perona） | 誤りの型に **Inversion（同じ人の左右の取り違え）** と **Swap（別人の部位との取り違え）** がある。ペアが接近すると両方が起きる | https://arxiv.org/pdf/1707.05388 |
| 前向き / 後ろ向きの曖昧さ | 2D キーポイントだけでは**背中向きと正面向きを区別しにくく**、左右の関節が入れ替わって大きな誤差になる | https://arxiv.org/pdf/2003.00943 |
| MEBOW | 体の向き（360° の方位）を画像から直接推定するデータセット（COCO 由来の約 13 万人分）。キーポイントから計算するより頑健な代替手段 | https://arxiv.org/abs/2011.13688 |
| 鼻・目・耳からの頭部方位 | 顔の 5 点（両耳・両目・鼻）のヒートマップから頭部の yaw を回帰すると、画像から直接回帰するより汎化する | https://arxiv.org/abs/1812.00739 |
| フィギュアスケート | YOLO + MediaPipe で回転を追う実装例がある。研究としては「回転数を数える」より**要素の開始・終了フレームを系列ラベリングで出す**方向が主流 | https://arxiv.org/abs/2410.20427 , https://www.labellerr.com/blog/ai-skating-sports-analytics/ |

### 1.5 動きの採点（参照動画との比較）

| 研究 | 要点 | 出典 |
|---|---|---|
| BlazePose + FastDTW による基本動作の採点 | 関節角 13 種を特徴量にし、音声の相互相関で時刻を合わせ、FastDTW で比較する。**動きの正しさ 50% + タイミング 50%** で採点し、自然文のフィードバックを付ける | https://dspace-repository.sgu.ac.id/handle/123456789/645 |
| 回転の質の計測（ダンス医科学） | 観察者の評価は**回転軸の傾き**（頭・胴・軸足を通る直線が鉛直からどれだけずれるか）と最もよく対応した。スポッティングは頭部の固定と素早い追い越しとして定義される | https://www.iadms.org/resources/blog/posts/2019/february/measuring-a-pirouette-tackling-the-challenge-of-quantifying-dance/ （検索抜粋のみ参照）, https://boris.unibe.ch/106233 （同） |

---

## 2. 音楽 — 「1」と「2」の見つけ方

### 2.1 楽器ごとの拍の位置（8 カウント表記）

| 楽器 | 鳴る位置 | 出典 |
|---|---|---|
| クラーベ 3-2（son） | 1, 2&, 4 ｜ 6, 7 | https://www.salsavida.com/salsa-dance-terms/clave/ , http://danceintime.com/info/clave-and-percussion-in-salsa-music |
| クラーベ 2-3（son） | 2, 3 ｜ 5, 6&, 8 | 同上 |
| **コンガのトゥンバオ** | **スラップ（パッ）= 2 と 6**。オープントーン（ドンドン）= 4・4& と 8・8& | https://www.salsavida.com/de/salsa-dance-terms/tumbao/ , https://scphillips.com/dance/salsarhythm.html |
| カウベル（ボンゴベル / カンパナ） | 基本形は 1・3・5・7 を打つ。モントゥーノ（コーラスと即興の部分）で鳴る | https://scphillips.com/dance/salsarhythm.html , https://salsablanca.com/instrument/la-campana-cowbell/ |
| ギロ | 1・3・5・7 に長い音、その間に短い音 2 つ | https://scphillips.com/dance/salsarhythm.html |
| ベースのトゥンバオ | トレシージョ由来。**最初の 1 回以外は 1 拍目を弾かない**（アンティシペイト）。最後の音（ポンチェ）が小節線をまたぐ | https://tucsonsalsa.com/node/360 , https://en.wikipedia.org/wiki/Salsa_(musical_structure) |
| ピアノのモントゥーノ | クラーベの向きが最もはっきり出る。2 側は表拍、3 側は裏拍を強調する | https://tucsonsalsa.com/node/360 |

⚠ **カウベルとクラーベの関係**: tucsonsalsa はカウベル（とギロ）が**クラーベの向きに関係なく同じ**だとする。danceintime と Wikipedia（musical structure）は、ベルのパターンも **3-2 / 2-3 に合わせて変わる**とする。基本の 1・3・5・7 の打点は共通で、装飾音の位置が違う、と解釈するのが穏当。

⚠ **コンガで聞くべき音**: salsavida・scphillips はスラップ（2・6）を主に挙げる。danceintime の簡略表記は**オープントーンの 4 と 8** を強調する。sonycasino はスラップ = 2、オープントーン = 4（& を書かない）とする。どれも同じパターンの別の切り取り方で、矛盾ではない。ただし実装で「どの音を検出するか」を決めるときは注意する。

### 2.2 「2」の見つけ方（On2 ダンサー向け）

1. **コンガのスラップを探す**。On2 のブレイク（2 と 6）と一致する。初心者はまずスラップより「ドンドン」（4・4&）を聞き、その 2 拍後に来るスラップを予測するとよい。 — https://www.salsavida.com/de/salsa-dance-terms/tumbao/
2. コンガのスラップは「2 を見つける最も簡単な方法」だが、**コンガ奏者が即興すると聞こえなくなる**ことがある。 — https://tucsonsalsa.com/node/360
3. On2 に合う楽器はベース・コンガ・クラーベ。On1 に合うのはカウベル・ギロ・メロディーのフレーズ。 — https://thedancedojo.com/salsa-timing-on1-on2-on3/ , https://thedancedojo.com/blog/salsa-timing-the-difference-between-salsa-on1-and-on2/
4. NY スタイルの On2 は**トゥンバオのリズムを基に**体系化された（Eddie Torres）。 — https://en.wikipedia.org/wiki/Salsa_(dance)
5. 現代キューバ音楽の多くはクラーベを**実際には鳴らさない**。拍を保つにはコンガの方が実用的、という主張がある。 — https://sonycasino.com/2015/06/20/against-clave-why-this-instrument-may-not-be-the-best-one-in-helping-you-keep-a-beat/

⚠ **クラーベは役に立つか**: salsavida は「クラーベの向きが分かれば数えやすくなる」とする。sonycasino は「鳴っていない楽器を教えても役に立たない」とする。**解析ではクラーベを直接検出しようとせず、コンガのスラップとベルの 1-3-5-7 を使う**のが現実的。

### 2.3 「1」の見つけ方

- 曲の**フレーズの頭**（歌詞の文の切れ目、伴奏の切り替わり）を 1 とする。歌い手はどの拍からでも入るので、歌の入りだけを当てにしない。 — https://tucsonsalsa.com/node/360
- カウベル / ギロの 1・3・5・7 が強拍。モントゥーノではカウベルが鳴るので強拍が取りやすい。 — https://scphillips.com/dance/salsarhythm.html , https://thedancedojo.com/blog/salsa-musicality-shines-4-rhythms/
- 「1」は初心者が最も苦労する点で、練習の順序は「サルサ以外の曲を数える → 動く → サルサを数える → 動く」。 — https://thedancedojo.com/blog/how-to-find-the-beat-in-salsa-music/

### 2.4 クラーベの向き（2-3 / 3-2）の聞き分け

- 名前は 2 小節のうち**どちらの小節が先に来るか**。 — https://www.salsavida.com/salsa-dance-terms/clave/
- 2 側では楽器が**表拍**を、3 側では**裏拍（&）**を強調する。両方のパターンで手を叩いてみて、合わない方を捨てる。 — https://tucsonsalsa.com/node/360 , https://sonycasino.com/2015/02/11/clave-3-2-or-2-3-understanding-the-difference/
- 自動解析では、クラーベの回転を考慮したテンプレート照合と動的計画法で 2 小節の位相を追う方法がある（Wright, Schloss, Tzanetakis, ISMIR 2008）。 — https://ir.webis.de/anthology/2008.ismir_conference-2008.103
- クラーベ系のリズムは幾何学・組合せ論で比較・認識できる（Toussaint）。 — https://archive.bridgesmathart.org/2002/bridges2002-157.html

### 2.5 曲の構成

- サルサの多くは son montuno の形で、**歌のパート → モントゥーノ（コール＆レスポンス）**へ進む。モントゥーノは曲の最後まで続き、**テンポが少しずつ上がる**ことがある。間に器楽の「マンボ」が入る。 — https://en.wikipedia.org/wiki/Salsa_(musical_structure)
- 解析への影響: テンポは**曲の中で一定とは限らない**。拍のグリッドは区間ごとに引き直す。

### 2.6 BPM（テンポ）

| 区分 | BPM | 出典 |
|---|---|---|
| サルサ全体 | 約 150〜250。**踊られるのは大半が 160〜220** | https://en.wikipedia.org/wiki/Salsa_(dance) |
| 遅い / 中 / 速い | 150〜180 / 180〜200 / 200〜220 | https://www.wimbledonsound.com/?p=2521 |
| サブジャンル別 | ロマンティカ 160〜190、ドゥラ 170〜220、ティンバ 180〜220 | https://tunee.ai/music-generator/salsa （音楽生成サイトで信頼度は低い） |
| マンボ（米国 DanceSport 規定） | 47〜51 小節/分 = **188〜204 BPM** | https://en.wikipedia.org/wiki/List_of_DanceSport_dances |
| サルサの拍の安定性 | 124 曲すべてで拍間隔は単峰。**倍・半分のテンポに近い変化は無い** | https://transactions.ismir.net/articles/183 |

⚠ **半分のテンポ問題**: 同じ tunee のページは「サルサは 93〜100 BPM」とも書く。これは 2 拍を 1 拍と数えた値（2 分音符の拍）で、ダンサーの数え方（1 拍 = 4 分音符）の**ちょうど半分**。汎用のビートトラッカーも同じ間違いをしやすい。**推定値が 75〜125 なら 2 倍する**のが安全。

⚠ On2 の曲は遅いという通説を裏付ける数値は見つからなかった。On2 が「ゆったり見える」のは、ブレイクの直後に slow が来て回転に使える時間が長いからと説明される（テンポの差ではない）。 — https://thedancedojo.com/blog/salsa-timing-the-difference-between-salsa-on1-and-on2/

---

## 3. 映像から On2 を確かめる

- On2 のブレイクは 2 と 6。**2 でフォロワーが前へ、リーダーが後ろへ**踏む。On1 は 1 でリーダーが前、フォロワーが後ろ。 — https://www.salsavida.com/?p=405 , https://www.salsavida.com/de/salsa-dance-terms/basic-step/
- ET2（Eddie Torres On2）は 1-2-3 / 5-6-7 で踏み、2・6 で向きを変える。**Power 2**（Razz M'Tazz 系、Palladium 期のマンボ由来）は 2-3-4 / 6-7-8 で踏み、1・5 を空ける。どちらもブレイクは 2・6。 — https://www.salsavida.com/sf/on-2-new-york-style-salsa
- On3（3・7 でブレイク）という流儀もある。 — https://thedancedojo.com/salsa-timing-on1-on2-on3/

⚠ **On2 の基本ステップの足**: salsavida の basic step の項は「1 で右足を前、2 で左足を後ろへブレイク（シャインでは男女共通、組むとリーダーは逆）」と書く。既存の `salsa-partnerwork-reference.md` 1.3 節はフォロワーが **2 で左足を前**へブレイクするとしている。シャインの足（リーダーの足で踊る人が多い）と組んだときの足が混ざっている可能性が高い。**足の左右よりも「2 で前後どちらへ大きく踏み出したか」を観測値にする**。

⚠ **「On2 contratiempo」の呼び方**: Dance Dojo は Power 2（2-3-4）を「contratiempo」「son timing」と呼ぶ。キューバンの文脈で contratiempo は「2 で踏む」全般を指す（`salsa-partnerwork-reference.md` 1.4）。呼称で判定しない。

---

## 4. 採点・審査の基準

### 4.1 サルサ大会の採点表

| 大会 / 団体 | 基準と配点 | 出典 |
|---|---|---|
| New York International Salsa Congress（ショーケース） | **Timing 20%**（1-2-3, 5-6-7。On1 / On2 は選べるが**一貫させる**。前後どちらのブレイクから入るかも一貫）/ Musicality 15% / Technique 15%（バランス・軸・ライン・体重移動、「楽に見える」こと）/ Difficulty 15%（ターン・シャイン・トリック）/ **Partnering/Connection 15%**（リード・フォロー、並んだときの同調）/ Choreography 10% / Presentation 10% | https://www.newyorksalsacongress.com/competition-rules |
| 同上「Just Dance」部門 | リフト・トリック・ドロップ禁止。リード・フォローの即興で、タイミング・音楽性・創造性を見る | https://www.newyorksalsacongress.com/competition-rules |
| World Salsa Summit（カップルバトル, 2019） | **musicality, timing, technique, x-factor** の 4 点。点数ではなく対戦の勝ち抜き。1 回 20〜30 秒 × 2 ローテーション | https://fs22.formsite.com/salsasoloforms/form33/index.html |
| WDSF（DanceSport 全般、サルサも管轄） | 4 つの構成要素（技術・音楽への動き・パートナリング・振付と表現）を 1〜10 点（0.5 刻み）で絶対評価。技術の中に**スピンとターン**、姿勢、ホールド、バランス、準備-実行-回復などが並ぶ | https://worlddancesport.org/About/Competition/Evaluating-The-Performance , https://www.worlddancesport.org/News/NJS-Components-1607 |
| 参考: Brazilian Zouk Council（Jack & Jill） | Timing 20% / **Technique 40%** / Teamwork 20% / Presentation 10% / Difficulty 10% | https://www.brazilianzoukcouncil.com/rules/judge-criteria |

⚠ **WSF の採点表は一次資料を確認できなかった**。World Salsa Federation（2001 年設立）は WDSF とは別の団体だが、現在の国際大会の多くは WDSF 規則で運営されている。World Salsa Championships の部門は On1 / On2 / Cabaret / Groups。 — https://en.wikipedia.org/wiki/World_Salsa_Championships

⚠ 配点は大会ごとに違う（タイミング 20% は NYSC と BZC で共通だが、技術は 15%〜40%）。**アプリの総合点は配点を設定で変えられるようにする**。

### 4.2 共通して見られている観点（映像で測れる形に直す）

| 審査の観点 | 映像で測れるもの |
|---|---|
| Timing | ブレイク（最大の前後移動）が 2・6 に来るか。ずれの大きさとばらつき |
| Technique | 回転軸の鉛直性、足が体の真下にあるか、回転中に軸足が流れないか |
| Partnering | 2 人の距離の伸び縮みが拍に合うか、リーダーの準備（3 のプレップ）とフォロワーの開始の時間差、肘と腰の位置関係 |
| Difficulty | 回転数、技の種類数、basic の比率 |
| Presentation / Styling | スタイリング（腕・肩・腰の装飾）の回数 |

---

## 5. 技術の質を示す手がかり（スキル採点用）

### 5.1 フレームとコネクション

- **肘は常に腰より前、かつ腰より外**。肘が腰より後ろに下がるとフレームが崩れ、合図が伝わらない。「もっと強くリードして」の原因は多くの場合ここ。 — https://thedancedojo.com/blog/improving-your-frame-connection-for-salsa-dancing-the-elbow-hip-relationship/
- 肩は後ろ・下へ。背の高いリーダーに合わせて**肩が上がるのは悪い例**。 — https://thedancedojo.com/blog/the-benefits-of-good-salsa-posture/
- 手は「腕の重さ」ではなく「手の重さ」だけを預ける。リーダーの手が下、フォロワーの手が上。 — https://thedancedojo.com/blog/arm-connection-salsa-bachata/
- コネクションは**テンション（引き合う）・コンプレッション（押し合う）・ニュートラル**の 3 状態。フレームは腕で保つ 2 人の安定した構造。 — https://en.wikipedia.org/wiki/Connection_(dance)
- リードの合図は 6 種類: 体重移動、胴の角度（肩のラインが行き先を示す）、手のターゲット、ターン、トス、ループ / ロック。 — https://thedancedojo.com/blog/how-to-lead-and-follow-salsa-6-signals-to-master/

### 5.2 回転（ターン / スピン）

- **軸**: 頭と背骨が軸足の真上で一直線。母指球に体重。回転中に**片足からもう片足へ移ろうとする**のが失敗の最大の原因。回転は肩ではなく胴（へそ）から始める。 — https://delta.dance/2023/03/creating-easy-and-efficient-turns-in-latin/
- **スポッティング**: 頭は最後に回り始め、最初に正面へ戻る。 — https://delta.dance/2023/03/creating-easy-and-efficient-turns-in-latin/ , https://www.performingdancearts.ca/spotting-dance-technique-and-tips/
- ペアダンスでは**相手の顔をスポットにしてよい**。サルサではスポットを目の高さに置く。 — https://www.bellaballroom.com/turning-tricks-and-tips/
- 手をつないだまま回るのが**ターン**、手を離して回るのが**スピン**。1 回転はふつう 2 拍。リーダーの手はフォロワーの頭上で指を下に向ける。 — https://lurklurk.org/lindyhop/m_spins_and_turns.html
- 回転の質は**軸の傾き**で最もよく説明できる（前掲 IADMS）。

⚠ lurklurk（リンディホップ）は「時計回りは手を押し出して、反時計回りは手を持ち上げて合図する」と書く。サルサの主流は「内側（2 人の間）へ動けば左回転、外側へ振り出せば右回転」（`salsa-move-grammar.md` 4.3）。ダンスの種類で合図の作法が違うので、**サルサの解析にはサルサの規則を使う**。

---

## 6. 講師はどう書き残すか（再現できるパターンシート）

- **ラインダンスのステップシート**は、カウント範囲（1-2, 3-4, 5-8 …）ごとに 1 行、足の動き、方向、**時計の文字盤で表した向き（12:00、6:00）**、& で 8 分音符を書く。 — https://www.copperknob.co.uk/stepsheets/188090/good-time-salsa , https://www.linedance.com/dance/111729/dame-salsa-give-me-salsa
- 講師は長い組み合わせを**3〜4 個の名前付きの塊（チャンク）**に分けて覚えさせる。「ここへ行って、ここへ行って」ではなく「CBL インサイドターン」「ハンマーロック」のように既知の名前に結び付ける。 — https://www.moversandshakersdance.com/local-dance-class-learning-accelerator-lesson-2-names-and-chunks
- 汎用の舞踊譜（ラバノーテーション、1928 年〜）は記号が形・高さ・時間・部位の 4 要素を持つ。ペアダンス向けには、リードとフォローを簡潔に書ける専用の記法も提案されている（タンゴ記法）。ただしサルサの現場では使われていない。 — https://www.kuow.org/stories/how-do-you-write-down-a-dance , https://wwwpub.zih.tu-dresden.de/~bodirsky/Tango-Notation.pdf
- 大学のサルサ科目のシラバスは、ベーシック（前後・横・バック）→ 右ターン → CBL → オープンブレイクターン、の順に並べる。 — https://symbiosiscollege.edu.in/assets/pdf/Syllabus/1.%20Dance%20(Salsa)-Syllabus.pdf
- 既存文書の 4.4 節テンプレート（開始状態・1-2-3・5-6-7・終了状態・確信度）は、上の講師の書き方と整合している。

---

## 7. 解析への示唆（優先度順）

確信度: 高 = 複数の出典と既存実装の知見が一致 / 中 = 出典はあるが本アプリの映像で未検証 / 低 = 仮説。
工数: S = 1 日以内 / M = 数日 / L = 1〜2 週間以上。

### P1. 音なしでカウントを固定する（ブレイク検出 + 周期の当てはめ）【確信度: 中〜高 / 工数: M】

1. 両者の足首キーポイントを腰の中点に対する相対座標にし、**前後（スロット方向）の変位**を取る。ブレイクは「最も大きく踏み出し、次の拍で戻る」1 歩なので、変位の極値として出る（§3、`salsa-partnerwork-reference.md` 1.3）。
2. 関節速度の極小（AIST++ の「動きの拍」）から拍の候補を取り、自己相関でテンポを推定する。探索範囲は **150〜250 BPM** に絞り、75〜125 が出たら 2 倍する（§2.6 ⚠）。
3. 8 拍の位相を決める。On2 の仮説では、**フォロワーの前ブレイク = 2 と 6**、リーダーの後ろブレイク = 2。さらに**フォロワーの回転・横断が 1-2-3 側（ピボットは 2〜3）**に来る。この 2 つの手がかりを同時に満たす位相を選ぶ。
4. 位相の確信度を出す。足が隠れた区間では「回転の開始拍」だけで補う。
- 根拠: Pedersoli & Goto（映像だけの拍推定）、AIST++、CoMPAS3D（off beat が最多のエラー＝タイミングが最重要）。

### P2. 回転方向を頑健に取る（向きの角度を連続で追う）【確信度: 中 / 工数: M】

1. 毎フレーム、**体の向きの角度 θ**（真上から見た方位）を推定する。
   - 肩ベクトルの見かけの幅 `|R肩−L肩|`（横向きで 0 に近づく）と符号から、θ の候補を 2 つ出す。
   - 前か後ろかは**顔の点（鼻・両目）の信頼度**と、耳が片方だけ見えるかで決める（鼻・目・耳の研究 §1.4）。
   - 姿勢推定器の**左右取り違え（Inversion）**を疑う。顔が見えないのに「左肩が画面左」なら、後ろ向きで左右が入れ替わった可能性が高い。
2. θ を**展開（unwrap）して累積回転量**を出す。符号が回転方向、360° で割った値が回転数。
3. 1 フレームで 90° 以上動いたら**エイリアシング**の疑いとして、方向を「不明」にする。0.1 秒刻みでは 1 回転 2 拍で 1 コマ 50〜60° 進むので、**回転区間だけ 20〜30 fps で取り直す**のが最も効く。
4. 補助の手がかり: リーダーの手が頭上に上がるか、上がった手が最初に内側 / 外側どちらへ動くか（`salsa-move-grammar.md` 4.3）。
5. 学習済みの向き推定（MEBOW 系）を使えるなら、キーポイントからの計算の代わりにする。
- 根拠: Ronchi & Perona（左右反転誤り）、サッカー選手の向き推定（前後の曖昧さ）、MEBOW、既存の 0.1 節の表。

### P3. ペアの ID を取り違えない【確信度: 高 / 工数: M】

- CBL・ラップ・シャドウでは 2 人が重なるので、**Swap 誤り（別人の部位を取る）**と ID の入れ替わりが必ず起きる（§1.4、Kouba は他人が映ると精度が落ちると報告）。
- 服の色ヒストグラムなどの見た目特徴と、位置の予測（Kalman 等）を組み合わせて ID を保つ。重なりの前後で「どちらが手前か」を記録し、出てきた後に照合する。
- ID が入れ替わると P1・P2 がすべて狂うので、**P1・P2 より先に検証する**。

### P4. 再現できるパターンシートの書式を固定する【確信度: 高 / 工数: S】

1×8 ごとに次を必ず埋める（講師の書き方 §6 + 既存テンプレート + ステップシート）:

| 欄 | 中身 |
|---|---|
| 時刻 | 動画の mm:ss.s〜mm:ss.s |
| カウント | 1×8 の番号、タイミング（On2 / On1 / 不明）、位相の確信度、推定 BPM |
| 開始状態 | 持ち手（男性◯手×女性◯手）、女性の位置（正面 / 右 / 左 / 後ろ）、向きの関係、スロットの端 |
| **向き（時計表記）** | リーダーの向きを「12:00 = 開始時のカメラ反対側」などの文字盤で書く。画面の左右に依存しない |
| 1-2-3 / 5-6-7 | 半小節ごとに 誰が・何を・どちらへ・何回転・手の高さ |
| 終了状態 | 開始状態と同じ欄 |
| 技名候補 | 名前 + 確信度 + 根拠。チャンク名（既知の技名）で書けるならそれを使う |
| 観測の区別 | 各値に seen / inferred |

### P5. スキル採点は審査の配点に合わせた 5 軸で、測れるものから【確信度: 低〜中 / 工数: L】

| 軸（NYSC の配点を初期値に） | 最初に作る指標 |
|---|---|
| Timing 20% | ブレイクと拍グリッドのずれの平均とばらつき。2 人の同期 |
| Technique 15% | 回転中の軸の傾き（鼻・腰中点・軸足首を結ぶ線の鉛直からのずれ）、回転中に軸足が流れた距離 |
| Partnering 15% | 肘が腰より前かつ外にある割合、リーダーのプレップ（3）からフォロワーの開始までの時間差、2 人の距離の伸び縮み |
| Difficulty 15% | 回転数の合計、技の種類数、basic の比率（CoMPAS3D: プロほど低い） |
| Presentation 10% | スタイリングの回数（CoMPAS3D: プロ 54.5 / 中級 12.9 / 初級 5.1） |

- 配点は設定で変えられるようにする（§4.1 ⚠）。
- スポッティング（頭が胴より遅れて回り始め、先に正面へ戻る）は、P2 の頭部方位と胴の方位の差として出せる。ただし 10 fps では測れないので、**高フレームレートで取り直したときだけ**採点する。

### P6. 音声があるときは補助に使う（主役にしない）【確信度: 中 / 工数: M〜L】

- 汎用のビートトラッカーはサルサで F 値 0.68 程度（§1.1）。そのまま信じず、P1 の映像の拍と照合する。
- **コンガのスラップ**（高域の鋭い打撃）を 2・6 の候補に、**カウベル**（1・3・5・7）を 1 の候補に使う。クラーベは鳴っていないことが多いので直接は探さない（§2.2 ⚠）。
- モントゥーノでテンポが上がるので、テンポは区間ごとに推定する（§2.5）。

### P7. CoMPAS3D を分類体系と検証データとして使う【確信度: 中 / 工数: S〜M】

- 30 クラスの技辞書と 5 つのエラー分類を、`routine` の語彙と対応付ける。特に `off beat` / `misstep` / `misinterpreted signal` は、本アプリのフィードバック文の分類として使える。
- 3D データを 2D に投影すれば、P2 の回転方向推定の評価に使える可能性がある（ライセンスは要確認）。

---

## 出典一覧（67 件）

研究・技術
1. https://arxiv.org/abs/2507.19684v1 （CoMPAS3D）
2. https://arxiv.org/html/2507.19684v1
3. https://huggingface.co/datasets/Rosie-Lab/compas3d
4. https://transactions.ismir.net/articles/183 （Salsa beat dataset）
5. https://researchwith.stevens.edu/en/publications/salsaasst-beat-counting-system-empowered-by-mobile-devices-to-ass/ （SalsaAsst: 40 曲で既存手法より良いと報告。詳細は未読）
6. https://ir.webis.de/anthology/2008.ismir_conference-2008.103 （Wright ほか、クラーベのテンプレート照合）
7. https://archive.bridgesmathart.org/2002/bridges2002-157.html （Toussaint）
8. https://dspace.cvut.cz/entities/publication/bc26c864-72df-4d39-a997-fea5b99affc6 （Kouba）
9. https://arxiv.org/abs/2109.09166 （HDVR）
10. https://www.cc.gatech.edu/cpl/projects/dance （Let's Dance）
11. https://arxiv.org/html/2412.16982v1 （InterDance）
12. https://arxiv.org/html/2403.18811v1 （Duolando / DD100）
13. https://arxiv.org/abs/2503.04816 （Invisible Strings）
14. https://arxiv.org/abs/2512.03509 （AfroBeats）
15. https://program.ismir2020.net/poster_3-10.html （映像だけの拍推定）
16. https://research.google/blog/music-conditioned-3d-dance-generation-with-aist/ （AIST++）
17. https://arxiv.org/html/2503.00794v1 （接地検出）
18. https://arxiv.org/pdf/1707.05388 （姿勢推定の誤り分類）
19. https://arxiv.org/pdf/2003.00943 （向き推定・前後の曖昧さ）
20. https://arxiv.org/abs/2011.13688 （MEBOW）
21. https://arxiv.org/abs/1812.00739 （鼻・目・耳）
22. https://arxiv.org/abs/2410.20427 （YourSkatingCoach）
23. https://www.labellerr.com/blog/ai-skating-sports-analytics/
24. https://dspace-repository.sgu.ac.id/handle/123456789/645 （BlazePose + FastDTW 採点）
25. https://www.iadms.org/resources/blog/posts/2019/february/measuring-a-pirouette-tackling-the-challenge-of-quantifying-dance/ （検索抜粋のみ）
26. https://boris.unibe.ch/106233 （検索抜粋のみ）

音楽
27. https://www.salsavida.com/de/salsa-dance-terms/tumbao/
28. https://www.salsavida.com/salsa-dance-terms/clave/
29. https://tucsonsalsa.com/node/360
30. http://danceintime.com/info/clave-and-percussion-in-salsa-music
31. https://scphillips.com/dance/salsarhythm.html
32. https://salsablanca.com/instrument/la-campana-cowbell/
33. https://en.wikipedia.org/wiki/Salsa_(musical_structure)
34. https://en.wikipedia.org/wiki/Salsa_(dance)
35. https://sonycasino.com/2015/06/20/against-clave-why-this-instrument-may-not-be-the-best-one-in-helping-you-keep-a-beat/
36. https://sonycasino.com/2015/02/11/clave-3-2-or-2-3-understanding-the-difference/
37. https://thedancedojo.com/blog/how-to-find-the-beat-in-salsa-music/
38. https://thedancedojo.com/blog/salsa-musicality-shines-4-rhythms/
39. https://www.wimbledonsound.com/?p=2521
40. https://tunee.ai/music-generator/salsa （信頼度低）
41. https://en.wikipedia.org/wiki/List_of_DanceSport_dances

タイミング・スタイル
42. https://thedancedojo.com/blog/salsa-timing-the-difference-between-salsa-on1-and-on2/
43. https://thedancedojo.com/salsa-timing-on1-on2-on3/
44. https://www.salsavida.com/sf/on-2-new-york-style-salsa
45. https://www.salsavida.com/?p=405 （Break step）
46. https://www.salsavida.com/de/salsa-dance-terms/basic-step/

審査
47. https://www.newyorksalsacongress.com/competition-rules
48. https://fs22.formsite.com/salsasoloforms/form33/index.html （WSS 2019 カップルバトル）
49. https://worlddancesport.org/About/Competition/Evaluating-The-Performance
50. https://www.worlddancesport.org/News/NJS-Components-1607
51. https://www.brazilianzoukcouncil.com/rules/judge-criteria
52. https://en.wikipedia.org/wiki/World_Salsa_Championships

技術の質・記法
53. https://thedancedojo.com/blog/improving-your-frame-connection-for-salsa-dancing-the-elbow-hip-relationship/
54. https://thedancedojo.com/blog/the-benefits-of-good-salsa-posture/
55. https://thedancedojo.com/blog/arm-connection-salsa-bachata/
56. https://thedancedojo.com/blog/how-to-lead-and-follow-salsa-6-signals-to-master/
57. https://en.wikipedia.org/wiki/Connection_(dance)
58. https://delta.dance/2023/03/creating-easy-and-efficient-turns-in-latin/
59. https://www.performingdancearts.ca/spotting-dance-technique-and-tips/
60. https://www.bellaballroom.com/turning-tricks-and-tips/
61. https://lurklurk.org/lindyhop/m_spins_and_turns.html
62. https://www.copperknob.co.uk/stepsheets/188090/good-time-salsa
63. https://www.linedance.com/dance/111729/dame-salsa-give-me-salsa
64. https://www.moversandshakersdance.com/local-dance-class-learning-accelerator-lesson-2-names-and-chunks
65. https://www.kuow.org/stories/how-do-you-write-down-a-dance
66. https://wwwpub.zih.tu-dresden.de/~bodirsky/Tango-Notation.pdf
67. https://symbiosiscollege.edu.in/assets/pdf/Syllabus/1.%20Dance%20(Salsa)-Syllabus.pdf

注: 「（検索抜粋のみ）」と書いた出典は本文を取得できなかったもので、検索結果の要約だけを根拠にしている。
