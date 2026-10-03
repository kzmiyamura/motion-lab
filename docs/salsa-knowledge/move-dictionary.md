# サルサ On2 パートナーワーク技辞典（映像解析用）

対象: NY スタイル（マンボ / Eddie Torres 系）On2 と、同じスロットで踊る LA On1 のパートナーワーク。
キューバン（カジノ）の技名は**比較用**として最後の L 群にまとめた。
既存の `docs/salsa-partnerwork-reference.md`（約 60 技）と `docs/salsa-move-grammar.md`（部品と文法）を土台にしている。
本書では約 60 ページ・30 以上のドメインの記述を突き合わせ、**171 技**に広げた。

> 技名は流派・教室・国によって大きく揺れる。UW の Salsa II 基準も「技名は標準化されていない」と明記している。
> 映像から書くときは、技名より**部品**（ホールド・回転の向きと数・通る側・どちらの端で終わるか・カウント）を優先する。
> 出典どうしで食い違う箇所には ⚠ を付けた。

---

## 0. 記法

| 記号 | 意味 |
|---|---|
| L / F | リーダー（男性）/ フォロワー（女性） |
| 右回転 / CW | 真上から見て時計回り。本人の右肩が後ろへ引ける回転 |
| 左回転 / CCW | 真上から見て反時計回り。インサイド = F の左回転、アウトサイド = F の右回転（⚠ 流派差あり。§3 参照） |
| `F左1½` | F が左回転を 1½ 回（540°）。`½` = 180° |
| L の左側 / 右側 | **L の元の正面向き**を基準にした左右。画面の左右ではない |
| 反対端 / 同端 | 技の終わりに F がスロットの反対の端にいる / 元の端に戻る（または動かない） |
| `LR` | L 左手 × F 右手（標準の片手） |
| `RR` | 握手（右同士）。`LL` は左同士、`RL` は L 右手 × F 左手 |
| `両手` | 平行の両手（LR + RL）。腕は交差しない |
| `X右上` / `X左上` | 交差した両手（RR + LL）。右手側が上 / 左手側が上 |
| `CL` | クローズド（L の右手が F の肩甲骨） |
| `HL` | ハンマーロック（片腕が自分の背中に折れた状態） |

**カウント欄の書き方**（On2 = Eddie Torres 式。踏むのは 1-2-3 / 5-6-7。L は 2 で右足を後ろ、6 で左足を前にブレイクする）

- **出**: 出典に On2 のカウントが書いてある。主に The Mambo Guild。
- **換**: 出典は On1 だったので、半小節ずらして換算した。
  原則は「F の横断・回転 = 1-2-3 側（ピボットは 2〜3）」「L 自身の回転 = 5-6-7 側」「プレップ = 直前の半小節」。
  **換算値は観測で必ず確かめること。**
- **—**: カウントの記載がない。

回転数の目安: 1 回転 ≈ 2 拍 ≈ 0.6〜0.75 秒。0.1 秒刻みなら 6〜7 フレームになる。顔の向きの順序を 3 フレーム以上続けて見て、回転方向を判定する（`salsa-partnerwork-reference.md` §0.1）。

---

## 1. 技の辞書（ファミリー別）

### A. 基本・接続（7）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| A01 | Mambo basic（ベーシック / フォワード・バック・ベーシック） | CL / 両手 / LR | 出: L は 2 で右足後ろ・6 で左足前。F は 2 で左足前・6 で右足後ろ。4・8 は止まる | 動かない・同端 | なし | 同じ | 2 と 6 で 2 人の距離が伸び縮みする。On2 では両足が揃う瞬間がない | MG-gl, SV3, REF |
| A02 | Breakback / Open break（ブレイクバック / オープンブレイク） | LR / 両手 | 出: 5 で前に出るはずの所を後ろへ下がり、腕を張る | 同端 | なし | 開いた LR | 2 人が同時に離れ、腕が一直線に張る。CBL・Enchufa・ターン系の入口 | MG-breakback, DC, UW |
| A03 | Side basic / Cumbia basic（サイド / クンビア・ベーシック） | CL / LR | 換 | 同端 | なし | 同じ | 頭が左右に揺れ、2 人の距離はほぼ一定 | DD1, LF, REF |
| A04 | Change of place（チェンジ・オブ・プレイス） | LR | — | 位置を入れ替える | F ½ | 反対端 | 7 で L がアンカーし、オープンブレイクから入る。⚠ 手順の詳細は会員限定で確認できず | DD1, DD2 |
| A05 | Shoulder catch（ショルダー・キャッチ） | L の手を F の肩に | 換: On1 では 3 で L が正対しきらず、5 で F が正対 | 途中まで入れ替わってから**来た方へ送り返される** → 同端 | L 右¼、F 180° | 向かい合う | L の手が F の肩に当たった瞬間、F の進行方向が反転する（ゴムの反動）。2 人ともクンビア・ベーシック | DD9 |
| A06 | Continuous shoulder catches（連続ショルダー・キャッチ） | 同上 | — | A05 を反復 | 同上 | 同上 | 肩で受けて反転する動きが周期的に続く | DD1 |
| A07 | Ochos（オチョス、タンゴ由来） | 片手 / 両手 | — | ほぼ同端 | F が左右に交互にピボット（1 回転未満） | 同じ | F の足が交差し、腰が 8 の字を描く。体の向きが左右に振れる | DD1, LOD |

### B. クロスボディリード（CBL）系（33）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| B01 | Cross body lead（クロスボディ・リード、左サイドパス） | CL / LR | 出: L が 5-6-7 で線から外れて左へ 90° 開く。F は 1-2 で前進横断し、3 までに線に戻る（MG の Enchufa の項）。⚠ 1×8 の数え始めは教室で違う | **L の左側**を通って反対端へ | F 左½、L 左¼+¼ | 反対端・向かい合う・LR | L の体が 90° 横を向く。手は腰〜胸の高さで頭上に上がらない。2 人の左右が入れ替わる | SG7, MG-cbl, MG-enchufa, WP1, DD1, SV1, SV2, SV3 |
| B02 | CBL with inside turn（インサイドターン） | LR（頭上へ） | 出: 1-2 でプレップ、3 で直進しながら左回転を始める、5-6 で正面が 2 回入れ替わる、7 で正対 | L の左側 → 反対端 | F 左1½ | 反対端 | 横断中に L の左手が F の頭上へ上がり、反時計回りの輪を描く。F は L の方へ回り込む | MG-in, DD3, DD8, SG7, DC, UW |
| B03 | CBL with outside turn（アウトサイドターン、トラベリング・ライトターン） | LR（中指で小さくフック） | 出: 7 で手を求め、1 で軽く誘い、2 で右回転を始める、3 で移動、5 で回り終わり、6 で下がり、7 で前 | L の左側 → 反対端 | F 右1½ | 反対端 | 回り始めに手が外側へ振り出され、頭上で時計回りの輪を描く。**inside より 1 拍早い 2 で回り始める** | MG-out, DD3, SG7, YT |
| B04 | Double inside turn / Inside 2½（ダブル・インサイド） | LR | 換: B02 に 1 回転を足す | L の左側 → 反対端 | F 左2½ | 反対端 | 頭上の輪が 2 周以上 | DD1, UW, LOD |
| B05 | Outside 2½ / Double traveling turn（ダブル・トラベリングターン） | LR | 出（MG の定義は「2½ 回転」のみ） | L の左側 → 反対端 | F 右2½ | 反対端 | 外へ振り出した手が 2 周以上回る | MG-gl, DD1 |
| B06 | Late inside turn（レイト・インサイド） | LR | 換: 横断の後半で回る | 反対端 | F 左 | 反対端 | 横断の前半は回らず、端に着く直前に回り始める。⚠ 詳細の記載なし | DD1 |
| B07 | Late outside turn（レイト・アウトサイド） | LR | 換 | 反対端 | F 右 | 反対端 | B06 の右回り版 | DD1 |
| B08 | Overturn（オーバーターン） | LR | — | 反対端 | 予定より多い回転 | 反対端 | 通常より ½〜1 回転余分に回ってから止まる | DD1 |
| B09 | Reverse CBL / Right side pass（リバース・クロスボディ、ライトサイドパス） | LR / CL | 換: On1 では 3 で L が左レールへ出て、5 で右足を後ろへフック、F は 5-6 で前進し 7 で右½。On2 では F の前進が 1-2、½ が 3 になる | **L の右側** → 反対端 | F 右½ | 反対端 | L が通常と逆に右へ開く。6 で F の右足が左足の前で交差する | DD7, DD2, DF, LF |
| B10 | Reverse CBL with 2-3 turns（リバースからの多回転） | LR | — | L の右側 → 反対端 | F 右2〜3 | 反対端 | 経路は B09 のまま、横断中に多回転する | DF |
| B11 | Reverse inside turn（リバース・インサイド） | LR | — | L の右側 → 反対端 | F 左 | 反対端 | L が右へ開いたまま、F が反時計回りに回る | DD1 |
| B12 | Reverse outside turn（リバース・アウトサイド） | LR | — | L の右側 → 反対端 | F 右 | 反対端 | B11 の右回り版 | DD1 |
| B13 | Reverse early inside 2.5（リバース・アーリー・インサイド 2.5） | LR | — | L の右側 | F 左2½（早めに回り始める） | 反対端 | 横断の初めから回る。⚠ 詳細の記載なし | DD1 |
| B14 | 360° CBL（フル / コンティニュアス CBL） | CL（L の手が F の背中の中央） | 出: Breakback → クローズドを求める → 1 で横切り、2 で背中側へ回り込み、3 で逆向きに開く | ⚠ MG:「3 で逆向きに開く」/ SG:「元の位置・元の向きに戻る」 | カップル全体が CCW に約 360° | ⚠ 出典で違う | 密着したまま 2 人一緒に反時計回りに回る。速いほど密着する | MG-360, SG7, DD1 |
| B15 | Suave（スアベ） | LR | 換: L の回転は 5-6-7 側 | L の左側 → 反対端 | L 左1（CBL 中）、F 左½ | 反対端 | 経路は CBL と同じ。違いは L 自身が左回転の足型で 1 回転すること | DD3, DD6, DD1 |
| B16 | Rejection（リジェクション = CBL 中の L のフックターン） | LR | 換 | 反対端 | L のフックターン | 反対端 | L の脚が後ろで交差してから回る | DD6, DD1 |
| B17 | CBL with leader's pencil turn（L のペンシルターン入り） | LR | 換 | 反対端 | L が細く速く回る | 反対端 | L の足元がほとんど動かない | DD6, DF |
| B18 | CBL with leader's half-and-half（L のハーフ・アンド・ハーフ） | LR | 換 | 反対端 | L 右ピボット → 左ピボット | 反対端 | L が右½ → 左½と往復する。右ターンの足型（左足前）で入る | DD3, DD6 |
| B19 | CBL with half spot turn, double pivot（L のハーフスポット＋ダブルピボット） | LR | — | 反対端 | L ½ + ピボット 2 回 | 反対端 | ⚠ 詳細の記載なし | DD6 |
| B20 | New York walk（ニューヨーク・ウォーク） | LR | — | L の左側 → 反対端 | **F 右½**で終わる（通常の CBL は左½） | 反対端 | 端に着いたときの F の回り方が CBL と逆 | DD1 |
| B21 | Cross body open（クロスボディ・オープン） | LR | — | CBL の途中で L が逆へ離れる | F ½ | 反対端・開いた位置 | 横断の途中で 2 人の距離が急に開く（ゴムの反動） | DD1 |
| B22 | Catwalk / Open CBL（キャットウォーク、片手 CBL） | LR のみ | 換 | L の左側 → 反対端 | 最後に F 右回転 | 反対端 | L の右手が F の背中に触れない。腕 1 本で引き込む | TDS, REF |
| B23 | Walkthrough（ウォークスルー） | LR | 出: 1 で L が左腕を上げて「橋」を作る、2-3 で F がその下を歩き抜ける、5 で腕を下げると F が回る、6-7 はベーシック | L は CBL の足型、F は Enchufa の経路 → 反対端 | F は 5 で回る | 反対端 | 1 で腕が高い橋になり、F は**回らずに**くぐる → 5 で回る | MG-walkthrough |
| B24 | Enchufa（On2 / MG の用法） | LR（張り） | 出: Breakback → 5-6、7 で L が左へ出て F が歩き抜け、3 までに線に戻る | ⚠ MG は「L の左へ、回転なし」。キューバンの Enchufla（L03）は L の**右脇**を F が CCW½ ピボットで抜ける | 回転なし（MG） | 反対端 | 腕の張りだけで F が歩き抜け、2 人の距離が近い | MG-enchufa |
| B25 | Lady's tunnel / Cross body travel turn（トンネル） | CL → LR | 換: On1 では 1-3 で L が腕のアーチを作り、5-7 で F がその下を歩く。L は 6 で左 90° | L の左側 → 反対端 | F 回転なし | 反対端・開いた位置 | F の頭のすぐ上に腕のアーチ。F はまっすぐ歩き抜ける | JA, REF |
| B26 | CBL with hand switch（持ち替え付き CBL） | CL → RR | 換 | L の左側 → 反対端 | F 左½ | 反対端・RR | 出口でつないだ腕が 2 人の間を斜めに横切る（握手）。Copa への準備 | JA, REF |
| B27 | Cross-body lead over head（左握手での頭上 CBL） | LL | 換 | 反対端 | F ½ | LL | F の手が頭上でアーチを描く | JA |
| B28 | Outside cross-body turn（手を投げて背中側で受ける） | RR | 換: On1 では 1-3 で L 字に開き、5-7 で CCW に回る | 反対端 | F CCW | 両手 → CL | F の腕が頭上へ投げ上げられ、L の背中側の手で受け止められる | JA |
| B29 | Double CBL（ダブル CBL） | CL | 換: On1 では 1-3 で上体ごと 180° CCW、5-7 で CBL | カップルが回転しながら移動 | カップル CCW 180° + F ½ | L 字 → CL | 2 人が組んだまま半周してから CBL | JA, REF |
| B30 | Shoulder turn（ショルダーターン = 肩から回すインサイド） | LR + L 右手を F の肩に | 換 | L の左側 → 反対端 | F 左1½ | 反対端 | L の右手が F の肩甲骨に当たってから回転が始まる。頭上の手は低め | DD4, TDS, REF |
| B31 | Hip turn（ヒップターン） | LR + L 右手を F の腰に | 換 | L の左側 → 反対端 | F 左1½ | 反対端 | L の手が F の腰から回転を始める | DD4 |
| B32 | Sliding doors（スライディング・ドア） | LR | 換 | インサイドターンの終わり際に次の CBL へ | F 左1½ → 続けて ½ | 反対端（2 回目） | インサイドが終わり切る前に、次の横断が始まる | DD4 |
| B33 | Cross-hand (L over R) CBL inside turn（交差持ちのインサイド CBL） | X左上 | 換 | L の左側 → 反対端 | F 左1½ | 交差がほどける | 開始時に腕が X 字（左が上）。回転で交差が解ける | LOD, DC |

### C. ターン系（その場・L の回転・フリー）（26）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| C01 | Right turn（ライトターン、F のその場右ターン） | LR（指先） | 出: 2 で体を左へ開いてプレップ、3 で右足後ろに乗ってピボット。5-6-7 はベーシック。4 では踏まない | その場・同端 | F 右1 | 同端 | 頭上で手が時計回りの円を描く。左右の位置は変わらない | MG-rt, DD3, SU, TDS, SV1 |
| C02 | Left turn（レフトターン、F のその場左ターン） | LR | 出: 2 で右へプレップ、3 の後に続けてピボット、5 で着地、6 で下がり、7 で前 | 同端 | F 左1 | 同端 | 回り終わりが 5（右ターンより遅い）。頭上の手は反時計回り | MG-lt, DD3 |
| C03 | Double right turn / Double turn（ダブルターン） | LR | 出: 2 回転（MG はフックステップ方式） | 同端 | F 右2 | 同端 | 頭上の円が 2 周。L は 1 歩下がって空間を作る | MG-gl, DD3, JA, DF |
| C04 | Multiple turns 3+ / Triple turn（トリプルターン） | LR | — | 同端 | F 右3以上 | 同端 | 3 周以上。0.1 秒刻みではエイリアシングに注意する | DD1, HM |
| C05 | Leader's right turn（L の右ターン） | LR（waiter hold で頭上へ） | 換: L の前ブレイク側 5-6-7 | 同端 | L 右1 | 同端 | 頭上の腕の下で回っているのが **L**。F はベーシック | TDS, DD3, REF |
| C06 | Leader's left turn（L の左ターン） | LR / 両手 | 換: 5-6-7 | 同端 | L 左1 | 同端 | C05 の逆向き | DD3, DC |
| C07 | Spot turn（スポットターン） | 手を離す | 換: L は 5-6-7、F は 1-2-3 | 同端 | L / F が右または左に 1 回転 | 同端 | プレップしてからその場で回る。接触はない | DD3, LOD |
| C08 | Back spot turn（バックスポットターン） | 片手を低く → CL | — | その場 | 右回転が多い（DC では L） | CL | 回る前に**後ろへ**踏み込む。前へ踏み出すスポットターンとの違い | DC, DD1, SU |
| C09 | Multiple back spot turns（連続バックスポット） | 片手 / なし | — | その場 | 右に複数回 | — | C08 を連続する | DD1 |
| C10 | Simultaneous back spot turns（同時バックスポット） | なし | — | その場 | L と F が同時に回る | — | 2 人が同時に同じ向きに回る | DF |
| C11 | Hook turn（フックターン） | 問わない | 換: On1 の記述では L が 5-7 で CW | その場 | 多くは右（CW）。⚠ DD3 は「方向はさまざま」 | 元の向き | 回る直前に脚が後ろで交差する。上体は固め、足だけ回る | JA, DD3, MG-hook |
| C12 | Pencil turn / Check turn（ペンシルターン） | — | — | その場 | 細く速く | — | 足元がほとんど動かない | DF, DD6 |
| C13 | Half spot turn（L のハーフスポット → シャドーへ） | LR | 換 | — | L ½ | L が F に背を向ける | L が F に背中を向けた位置（シャドー）で止まり、続けて F の右ターンへ | DD3 |
| C14 | Half and half（ハーフ・アンド・ハーフ、L） | — | 換 | その場 | L 右½ → 左½ | 元の向き | 顔の向きが往復する（正面→横→背→横→正面） | DD3, LF |
| C15 | Free spin（フリースピン） | 手を離す | — | 同端 / 横断のどちらもある | F（左右とも）または L | — | 回転中に接触がない。直前に L の腕が振られる | DD1, DD4, WP1, LOD |
| C16 | Axle turn（アクスルターン） | LR | 出: 右アクスルは 5-6-7 で反時計回りの円を描いてプレップし、**1** で回す | 同端 | F 右1 | 同端 | 回転が 1 に来る（通常の右ターンは 2〜3）。直前に手が反時計回りの円を描く | MG-axle, MG-copa |
| C17 | Check（MG の用法 = left axle） | LR | 出: 6 でプレップ、7 から床を押す、1-2-3 で回り終える | 同端 | F 左1（1 カウントの左ターン） | 同端 | ⚠ SG の「Check = 途中で止める」とは**同名で中身が違う** | MG-check |
| C18 | Touch and go（タッチ・アンド・ゴー） | X右上 / LR | 出: 1 回目の回転で手を離し、3 でつなぎ直して回り切る | 同端 / 横断 | F 右2 または 右1½ | — | 回転中に一瞬手が離れ、また取られる | MG-tng, DD5 |
| C19 | Drop and catch（ドロップ・アンド・キャッチ） | LR（L 左手を F の手首の上に） | — | — | 持ち手だけが変わる | 下側から持つ | 手を離すと落ち、下から取り直される | MG-dnc |
| C20 | You turn - I turn / He goes, she goes（交互ターン） | LR | 換: F は 1-2-3、L は 5-6-7 | 同端 | F 右1 → L 右1 → F 右1 | 同端 | 回る人が半小節ごとに交互に入れ替わる | TDS, LOD |
| C21 | Natural top / Around the world（ナチュラルトップ） | CL | — | カップル一緒に | 2 人とも右1（CW） | ブレイク | クローズドのまま 2 人一緒に**時計回り**。⚠ DD の "Around the World" は別のパターン | SG10, DD2 |
| C22 | Loopy waiter（ルーピー・ウェイター） | waiter hold（掌が上） | — | 同端 | F 右1 → 腕のループ → チェック → 左ターン | — | 頭上に掌を上にした手（トレイ持ち） | DD2 |
| C23 | Checkpoint（チェックポイント） | RR | 換: On1 では 1-2 でオープン、3 で L 字、5 でスピン | 同端 | F 右（肩から） | CL | L の指 2 本が F の肩に当たり、腕を強く引く | JA |
| C24 | Arm check to continuous spin（連続スピン） | 両手 → RR | — | 同端 | F 右に連続 | — | L はその場で踏み、F だけが回り続ける | DC |
| C25 | Twister（ツイスター） | LR → RR | — | 同端 | F 右2 + 最後に L 右1 | — | 2 回転目で握手に持ち替え、最後に L も回る | HM |
| C26 | Tornado（トルネード） | 背中越しの握手 | — | 同端 | F 右2（1 回目は背中越しに握手、2 回目は手を離す） | — | 1 回目に F の手が背中側を回る | HM |

### D. コパ・チェック系（16）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| D01 | Copa / In-and-Out（コパ、イン・アンド・アウト） | ⚠ MG: LL / SG・NY 系: RR / 一部: LR | 出: 6-7・1-2-3 → 5-6 → 7 でチェックのプレップ。7 で向きを変えて 1 で回る | L の前に入ってから**来た方へ戻る** → 同端 | F 左½ + 左½（合計 CCW 約 360°） | 同端。⚠ MG は「横へ開いて次の技（Axle など）へ」 | 3〜4 付近で F が L の胸の前で背中を見せて止まり、元へ戻る | MG-copa, REF, SU, YT, LF |
| D02 | Copa with turn and a half（コパ＋1½） | RR | — | 同端 | 戻るときに回転を足す | 同端 | 戻りの半小節で頭上の輪 | DF, REF |
| D03 | Reverse copa（リバース・コパ） | — | — | ⚠ 手順の詳細は確認できず | — | — | 授業カリキュラムに名前だけある | LF, PP |
| D04 | Copa with outside turn（コパ＋アウトサイド） | RR | 換 | 同端 | F 左½ → 戻りで右回転 | 同端 | 入るときは左、戻るときは右に回る | REF |
| D05 | Outside copa（アウトサイド・コパ） | RR | 換: On1 では 1-3 で F が右 90°、5-7 でさらに 90° | L が F の腰で受ける | F CW 約 180° | 同じ向き → LL | 同じ向きに並んだ瞬間に L の手が F の腰で止める | JA |
| D06 | Copa（jantar 版、ゴブレット形） | CL → L 字 | 換: On1 では 1 でオープン、2-3 で F が 180° CCW | 2 人が同じ向きで、互いに逆へ傾く | F CCW 180° | L 字 → CBL へ | 杯の形の静止。⚠ NY 系の In-and-Out とは別物 | JA |
| D07 | Copa variants（Cradle / Free / Rainbow / Double rainbow copa） | — | — | — | — | — | 名前のみ確認。⚠ 動きの記載はない | LOD |
| D08 | Shoulder check（ショルダーチェック） | 片手（通常持ち / 交差 / なし）+ 肩 | — | 止めて送り返す → 同端 | F の回転が途中で止まって逆向きになる | 同端 | L の手が F の肩に当たり、F の回転が止まって逆転する | SG2, DD1, LF, DIT |
| D09 | Hip check（ヒップチェック） | 片手 + 腰 | — | 同端 | 同上 | 同端 | L の手が F の腰に当たる（シャドー位置で行うことが多い） | SG2 |
| D10 | Hand check（ハンドチェック：手を下げる / 上げる） | RR（下げる）/ RL（上げる） | — | 同端 | F が止まる | 同端 | 持った手だけで止める。体への接触はない | SG2 |
| D11 | Peek-a-boo（ピーカブー） | 両手 | — | ⚠ DC: 回転なし（L が肩を回して隠れる）/ REF: F 左½ → 戻す | — | CL | L と F が肩越しに顔を合わせる | DC, REF |
| D12 | Peekaboo to inside turn（ピーカブー → インサイド） | 両手 | — | オープン → 止めてから回る | F CCW | CL | ピーカブーの静止のあとに左回転 | DC |
| D13 | Arm check（アームチェック） | CL → 両手 | — | 同端 | F 左½ピボット | CL | バックベーシックから、手で回転を引き出す | DC |
| D14 | Stomach wrap（ストマック・ラップ） | — | — | 同端 | F を止める | — | ショルダーチェックとほぼ同じだが、止める場所が**腹**。L の腕が F の腹の前に入る | DD1 |
| D15 | Semi circle / Windmill（セミサークル / ウインドミル） | RR | — | 半円を描く | — | — | 握手のまま F が半円の軌道を回る | DD5, DD1 |
| D16 | Half turn + check（ハーフターン＋チェック） | LR | 換 | 同端 | F ½ で止めて逆へ ½ | 同端 | 180° の所（背中が見えた所）で止まり、逆回転で戻る | REF, DD3 |

### E. ハンマーロック系（9）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| E01 | Hammerlock（ハンマーロック、F の右腕） | 両手（L 左手を上げ、右手は下のまま） | 出: 1 で回り始め、2-3 と続ける。手は腰の高さ | 同端 | F 右1（右ターンから入る）。⚠ 左回転（inside）で入るとする資料もある | 向かい合う・F の右腕が背中 | 正面から F の片腕が消える。ほどくときは**手を下げたまま** | MG-hl, DD2, SU, LF, REF |
| E02 | Hammerlock unwind（ハンマーロック・アンワインド） | HL | 換 | 同端 | F 左1でほどく | 両手 | 背中の腕が逆回転で前に戻る | DD2 |
| E03 | Outside turn to hammerlock（アウトサイドからハンマーロック） | RL | — | — | F 右 | HL | 回転の終わりに腕が背中へ巻き込まれる | DD5 |
| E04 | Pass behind the back lock（左側ハンマーロック） | — | — | — | — | F が**左側**の HL | 背中に回るのが F の左腕 | A2S |
| E05 | Leader's hammerlock（L のハンマーロック） | 両手 | — | — | — | L の腕が背中 | 背中に腕が回っているのが L | SG-hl（REF 経由） |
| E06 | Half hammerlock / Broken arm（ハーフ・ハンマーロック） | 背中の腕の手だけを持つ | — | — | — | 片腕だけ HL | もう一方の手は空いている | SG1 |
| E07 | Blind hammer bounce / Hammerlock copa（ハンマーロック＋コパ） | 両手 | — | 同端（コパで戻る） | — | — | HL のままコパの In-Out を行う | A2S, SF2 |
| E08 | Hammerlock check to shadow（HL チェック → シャドー） | 両手 | — | — | F 回転 + チェック | L が後ろ | HL で止めたあと、L が F の後ろに入る | DC |
| E09 | Cross body lead to cuddle, hammerlock, arm check（CBL → カドル → HL → アームチェック） | 両手 | — | — | F | 両手 | 腕の形が 前で交差 → 背中 → 前 と変わっていく | DC |

### F. ラップ・クレイドル・腕を掛ける系（19）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| F01 | Wrap / Cuddle / Cradle / Sweetheart / Basket（ラップ / カドル / クレイドル / スイートハート / バスケット） | 両手 | 換: F の回転は 1-2-3 | F が L の横（多くは右）に入る | F 左½〜1（L の右手で inside に回す） | 並んで同じ向き・F の腕が自分の前で交差 | F の手首が腹の前で交差する。L の腕が F の腰に回る | LF, DD1, HM, SU, TDS, REF |
| F02 | Unwrap（アンラップ） | ラップ | 換 | 元の向かい合いへ | F 右1 | 両手 | 交差がほどけて正面に戻る | REF, LOD |
| F03 | Wrap with check / complete turn（チェック付きラップ） | 両手 | 換 | — | F 左1で止めて戻す、または 1½ 回り切る | 向かい合う | 1 回転で止まり、来た方へ戻る | DD4 |
| F04 | Tow truck（トウトラック = Basket） | 両手 | — | — | — | バスケット形 | ⚠ 名前と別名のみ確認 | DD1 |
| F05 | Barrel roll（バレルロール） | 両手 | 換 | — | F 左1½ の間に L がフックターン | 背中合わせ | 2 人の背中が向き合う。L の脚が交差する | DD4, DD1, REF |
| F06 | Back to back（バック・トゥ・バック） | 両手 / X右上 | 出: 5-6-7, 1-2-3。2 で腕が合わさる | — | F が回り、L も一緒に回る | — | 回転中も背中同士が離れない | MG-b2b |
| F07 | Wrap and walk（ラップ・アンド・ウォーク） | 両手（左が上） | 出: 5-6-7, 1, Breakback, 5-6-7 | **入れ替わらず**その側に残り、L が後ろから歩く | F ½左 → 7 で右ターン | 線に戻る | Enchufa のように始まるが渡り切らない。L が F の後ろに付く | MG-ww |
| F08 | Roll to wrap（ロール・トゥ・ラップ） | 片手 → 腰に手 | — | CBL を延長し、F が外へ転がってから L に巻き付く | F 外回り → 内回り | カドル | 一度離れてから巻き込まれる | DC |
| F09 | Simple wrap（DC 版） | 両手（片手を上げて「窓」） | — | F が L の右側を時計回りに回り込む | ⚠ F01 の inside（CCW）とは逆 | 向かい合って ¼ | 開いた手で窓を作り、F が L の横を回る | DC |
| F10 | Cuddle move（HM 版カドル） | LR | — | CBL の位置 | F 左回転 | L の右手が F の背中（肋骨の辺り） | CBL の途中で巻き込まれる | HM |
| F11 | Open cuddle（オープン・カドル） | LL | — | CBL の位置 | F 左回転 | L の右手が F の腹に回る | 左同士のホールドから入る | HM |
| F12 | Double cuddle（ダブル・カドル） | RR（指を組む） | 換: On1 では 7 で RR に持ち替え | — | F 右回転で背中側へ巻く → CBL の左回転でカドル | 両腕を巻いたカドル | 腕が 2 重に巻き付く | HM |
| F13 | Reach-in sweetheart（リーチイン・スイートハート） | — | — | — | F 右回転で L の背中側へ巻く → 左回転でほどく | — | L が右腕を F の右腕の下に差し入れて向きを戻す | HM |
| F14 | Forward travel wrap（フォワード・トラベル・ラップ） | — | — | ラップのまま前へ進む | — | — | ⚠ 名前と概要のみ確認 | A2S |
| F15 | Neck wrap / Neck loop（ネックラップ / ネックループ） | 片手 | 換 | 同端 | 回転後に止める | 腕が首の後ろ | 前腕が首の後ろに水平に掛かる（肘は肩の高さ） | REF, LOD |
| F16 | Arm loop（アームループ = L の腕を F の肩に掛ける） | 通常持ち | 換 | 同端 | 右ターン後なら L の右腕、左ターン後なら L の左腕を掛ける | 腕が F の肩 | 回転の直後、L の腕が F の両肩に乗る | SG9 |
| F17 | Arm lock / Arm hook（アームロック） | 片手 / 両手 | — | 向かい合う | — | F の手が L の肩の後ろ | F の腕が L の肩の後ろに引っ掛かる（左・右・両方がある） | SG8 |
| F18 | Neck roll / Neck turn（ネックロール） | 片手 | — | — | 首に沿って手を滑らせて回す | — | 首の後ろの前腕が滑り、そのまま回転になる | A2S, LOD, REF |
| F19 | Lead's face loop（L のフェイスループ） | 片手 → 両手 | — | — | L 右½（くぐる） | 手を F の肩へ | L が F の手の下をくぐり、手が顔の前を通る | DC, LOD |

### G. 交差持ち（Cross-hand）・並び系（14）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| G01 | Cross-hand outside (right) turn（交差持ちライトターン） | X右上 | 換: On1 では 1-3 でオープンブレイク、5-7 で回転し、途中で持ち替える | 同端 | F 右1 | 握手 | 開始時の X 字（右が上）が、回転とともにほどける | JA, LF, REF |
| G02 | Butterfly（バタフライ） | X左上 | 換 | 同端 | F 左1（チェック）または 1½ | — | 腕を**大きく左右へ開く**。⚠ LF は Butterfly = Titanic とし、SG5 は「ライン・オブ・ダンスに直角に並ぶ向き」の名前として使う | DD4, LF, SG5 |
| G03 | Sombrero（ソンブレロ） | X右上 | 換: 1-2 で準備、5-6-7 で回転（SOZ は On1）。キューバンは 1×8 で 2 回転 | F が L の前を回って **L の右側**へ（RW）。⚠ SG は左右両方あるとする | F 右1〜2（CW）。⚠ WB は「F は左回転」 | 並んで同じ向き・腕が両者の首の後ろ | 2 人とも肘が頭の高さまで上がる。抜けは CBL（LA）か DQN（キューバン） | RW, SOZ, DP, LOD, SG, WB, REF |
| G04 | Titanic（タイタニック、MG 定義） | RR（+ L の左手を F の肩に） | 出: RR でインサイドターン。1-2 でプレップし、5 でもう一方の手で**ブロック**する | L が F の**真後ろ**に入る | F 左（ブロックで途中で止める） | 同じ向き・L が後ろ | 2 人が縦に重なる。⚠ REF の旧定義は「腕を横に広げる」 | MG-titanic, MG-gl, LF, DIT |
| G05 | Titanic flare（タイタニック・フレア） | — | — | CBL の変形 | — | — | ⚠ 名前のみ確認 | DD1 |
| G06 | Half moon（ハーフムーン） | RR | — | スロットの上下に半円を描く CBL の連続 | F がアウトサイドターンを複数回 | CL | ⚠ DF は「Half moon with turn and a half を Titanic と呼ぶ人がいる」と書く | DC, DF |
| G07 | Loop and half moon（ループ・アンド・ハーフムーン） | RR → 両手 | — | スロット上を円弧で移動 | F 1 回転 | スロットに戻る | ループのあと半円を往復する | DC |
| G08 | Crucifix（クルシフィクス） | 握手（腕を交差） | 換: On1 では 1-3 で交差、5-7 で F が CCW 360°、次の 1-3 でアウトサイドターン | 同端 | F 左1 → 右（多くは 2 回） | — | 6-7 で掌を上にした「十字」の形。そのあと腕がほどける | JA |
| G09 | Windows（ウィンドウズ） | 交差 | — | 横並び | 横並びのまま回る | — | ⚠ 名前と簡単な説明のみ | LOD |
| G10 | Mixmaster（ミックスマスター） | 交差 | — | — | — | — | ⚠ 名前のみ（スイートハートの出口として使う） | LOD |
| G11 | Matador / Crossed-hand matador（マタドール） | 両手 / 交差 | — | — | 続けて F のダブル・インサイド | — | ⚠ 名前のみ | LOD |
| G12 | Hand juggle（ハンド・ジャグル） | 片手を保持し、もう一方を交差させる | 出: 右ジャグルはアクスル右から。5 で右手を交差させ、5-6 で反対の肩へ渡し、7 で戻す | 同端 | — | そのまま / HL へ | 腕が F の肩から肩へ横切る。**肘は低いまま** | MG-juggle |
| G13 | Grinder（グラインダー） | RR → 肩 | — | 同端 | L が自分の手の下をくぐり、F はアウトサイド | 足を揃える | ¼ 回転が繰り返され、肩の押しで回る | DC |
| G14 | Embrace（エンブレイス、手を自分の背中 / 前で交差） | 交差 / 通常 | — | 向かい合う / シャドー / 横並び | — | 一方の両手が自分の背中か前で交差 | L か F の両手が自分の体の後ろ（または前）で交差している | SG3 |

### H. 持ち替え・腕の通し方（12）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| H01 | Behind-the-back hand change（背中での持ち替え） | LR | 換: L が回るなら 5-6-7 | 同端 | L 右1 を伴うことが多い | RR | L が一瞬 F に背を向け、両手が L の腰の後ろで合わさる | DD5, LOD, TDS, REF |
| H02 | Over-the-head hand change（頭上での持ち替え） | LR | — | 同端 | — | RL など | 持ち替えが頭上で起こる | REF, HM |
| H03 | Hand toss / Flick（ハンドトス / フリック） | 片手 | — | — | 続けて回転することがある | 手が離れる | L が F の手を投げ上げ、手が上がってから落ちる | DD10, SG1, MG-gl, UW |
| H04 | Hand drop / Pick up（手を離す / 取り直す） | — | — | — | — | 同じ手か反対の手 | 一瞬接触が切れる | SG1 |
| H05 | Hair comb（ヘアコーム、F）/ Hair brush | 片手 | — | 同端 | **回転なし** | — | 手が上へ上がり、頭の後ろへ撫で下ろされる。MG によれば、手が外の斜めへ行けばターン、上の手前へ来ればコーム | MG-comb, SV1, SG1, REF |
| H06 | Leader's comb / Self comb（L のコーム / セルフコーム） | 片手 / 交差 | — | 同端 | 回転なし | — | 手が L 自身の頭を越えて後ろへ。MG には 12 の変種（平行・交差・セルフ） | MG-comb, HM |
| H07 | Back hand pass（バックハンド・パス） | — | — | — | — | — | ⚠ 名前のみ | DD1 |
| H08 | Back scratch（バック・スクラッチ） | CL → 両手 | 換: On1 では 1-5 で F のアウトサイド、6-7 で L が CCW | — | F 右 + L CCW | 開いた位置 | F の手が L の背中を滑り下りる。F の手が L の肩に乗る | JA |
| H09 | Hand drapes（ハンド・ドレープ） | — | — | — | — | — | ⚠ 名前のみ（NY の必修パターンに挙げられている） | DF |
| H10 | Arm spiral（アーム・スパイラル） | — | — | — | — | — | ⚠ 定義が曖昧（腕を螺旋状に下ろす / 体に巻き付ける） | DD1, REF |
| H11 | Lock twirl hand switch（ロック・トワール・ハンドスイッチ） | — | — | — | — | — | ⚠ 名前と概要のみ | A2S |
| H12 | Duck（ダック、腕の下をくぐる） | 片手 / 両手 | — | — | L か F がかがむ | — | 頭が一段下がり、腕の下を通る | SG1, HM |

### I. シャドー・並び・周回系（11）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| I01 | Shadow position（シャドー・ポジション） | ⚠ MG: LL（Titanic の反対側、L が F の左）/ SG: 持ち手の規定なし、L が F の真後ろで同じ向き | — | — | — | 同じ向き | カメラから見て 2 人が縦に重なる。同じ足が同時に出る | MG-shadow, SG4, LF |
| I02 | Shadow, man in front（L が前のシャドー） | — | — | — | — | L が前・F が後ろ | 前にいるのが L | SG4, SG5 |
| I03 | Titanic exit to shadow（タイタニック → シャドー） | RR | 出: 5-6-7, 1-2-3 のあと 6-7、1 でツイストしながら下がる | — | — | シャドー | 縦の重なりが、Titanic 側からシャドー側へ移る | MG-titanic |
| I04 | Check on shoulder / hip in shadow（シャドーでのチェック） | 片手 + 肩 / 腰 | — | — | F を止める | シャドー | 後ろの L の手が F の肩や腰に当たる | SG2 |
| I05 | Coca-Cola behind the back（コカコーラ・ビハインド・ザ・バック） | CL → 開いた位置 | 換: On1 では 1-5 で CBL、6-7 で平行の位置になり F が CCW、次の 1-5 でフリースピン | — | F CCW → フリースピン | CL | L が掌（指ではない）で F の腰からリードする | JA |
| I06 | Send off（センドオフ） | HL → 片手 | 出: CBL の位置 → フック → 7 で掌を下にして手首で受け、1 で L が線から出て、2 で右手を最大に引く | F を前へ送り出す | 複数の ½ 回転 | チェック・CBL 位置 | F が L の前方へ送り出され、L が背中をなぞる | MG-send |
| I07 | Promenade scallop / Sweetheart scallop（プロムナード・スカロップ） | CL → プロムナード / スイートハート | — | L の右側を円弧で回る | 両者 | スカロップ形 | 並んだまま弧を描いて回る | DC |
| I08 | Walk around（ウォークアラウンド） | 片手 / 両手 | — | ⚠ DD・REF: F が L の周りを歩く / DC: L が F の周りを歩く（プレッツェル持ち） | — | — | 片方が相手の後ろに一時的に隠れる | DD1, DC, REF |
| I09 | Waist catch（ウエスト・キャッチ） | 手を腰に | — | L が F の周りを回る | L が円を描く | 同じ向き | L の手が F の腰に当たったまま、L が回り込む | DC |
| I10 | Diva walks（ディーバ・ウォーク） | — | — | F の装飾的な歩き | — | — | ⚠ 名前のみ | DD1 |
| I11 | Butterfly position, back to back（バタフライ位置の背中合わせ） | — | — | — | — | 背中合わせ・ライン・オブ・ダンスに直角 | 2 人が背中合わせで、画面に対し横向きに並ぶ | SG5 |

### J. ディップ・ドロップ・シットダウン（9）

Wikipedia によれば、sit < dip < drop の順に、ベース（L）が支える重さが大きくなる。

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| J01 | Basic dip（ベーシック・ディップ） | CL（腰をしっかり抱く） | 換: On1 では 1-2 でコパ、3 で F CCW 360°、4 で L が後ろへ、5 で倒し、6 で保持、7 で 90° CCW しながら起こす | — | F CCW 1 | L 字 | F の頭が股関節〜肩の高さまで急に下がる。L は膝を曲げ、上体は立てたまま | JA, WP2 |
| J02 | Cuddle and drop（カドル・アンド・ドロップ） | カドル | 換: On1 では 5 でドロップ | — | — | — | カドルの形のまま F が沈む | HM |
| J03 | Hand behind back drop（ハンド・ビハインド・バック・ドロップ） | 背中越しの RR | 換: On1 では 5 でドロップ | — | L 左回転 | — | L の LL 側の手が F の鎖骨に当たる | HM |
| J04 | Both hands behind back drop（両手背中ドロップ） | LL を低く | 換: On1 では CBL の 7 で落とす | F が L の背中側へ | L 左回転 | — | 落とした瞬間、F が L の背後に位置する | HM |
| J05 | Cross-body lead dip（CBL ディップ） | — | — | CBL の途中 | — | — | 横断の途中で F が後ろへ倒れる | LOD |
| J06 | Face-to-face side dip（向かい合いのサイドディップ） | CL | — | — | — | — | 向かい合ったまま横へ傾く | LOD |
| J07 | Sombrero neck roll dip（ソンブレロ → ネックロール → ディップ） | X右上 | — | — | — | フリースピンへ | 帽子の形 → 首の手が滑る → 倒す | LOD |
| J08 | Titanic dip（タイタニック・ディップ） | — | — | — | — | — | F が後ろへ反り、L が支える。⚠ MG の Titanic（位置）とは別物 | SU |
| J09 | Sit down / Pa'l piso（シットダウン / パル・ピソ） | 両手 / HL | 換: On1 では 5-6-7 で沈み、次の 7 で起きる | — | — | — | L（または両者）が膝をついて床近くまで下がる。F が L の周りを歩くこともある | HM |

### K. L の見せ場・ブレイク（4）

| ID | 技名（別名・日本語） | 開始ホールド | On2 カウント | F の経路・端 | 回転 | 終了 | 映像の手がかり | 出典 |
|---|---|---|---|---|---|---|---|---|
| K01 | Leader's spin / Leader's free spin（L のスピン） | 手を離す / 保持 | 換: 5-6-7 | 同端 | L 右1〜2 | — | 回るのが L。F はフレームを保ってベーシック | SU, REF |
| K02 | Leader's half chase to hand drop（L のハーフチェイス） | 手を離す | — | 交互にスロットを往復 | 交互に回る | — | 接触がなく、2 人が交互に回る。⚠ 名前と構成のみ | DF, REF |
| K03 | Shine break with Suzy Q（スージーQ のシャイン区間） | なし | 出（MG）: Suzy Q は cross-back-cross。後ろの足はつま先で着く | 同端 | なし | 再びつなぐ | 手を離して向かい合い、腰をひねりながら足を交差させる。1〜2 m 離れる | MG-gl, UW, DD1 |
| K04 | Block（ブロック） | フレーム | — | 同端 | なし | — | 音楽のアクセントで 2 人が止まる | MG-gl |

### L. キューバン（カジノ）技名 — 比較用（12）

LA / NY の映像に出ることはあまりないが、技名の取り違えを防ぐために載せる。
スロットは無く、2 人が互いの周りを回る（円運動）。

| ID | 技名（別名・日本語） | 開始ホールド | カウント（キューバンは 1 で踏む） | F の経路 | 回転 | 終了 | 映像の手がかり / 線状サルサでの相当技 | 出典 |
|---|---|---|---|---|---|---|---|---|
| L01 | Dile que no（ディレケノ、DQN） | ガペア / 片手 | 1-2-3, 5-6-7 | F が L の右側から始まり、反時計回りに L の前を横切る | F CCW ½ | 開いた位置 | ≒ CBL。円弧を描き、1 で 2 人とも下がる | SS, RC, REF |
| L02 | Enchufla（エンチュフラ） | ガペア / LR | F は 1-2-3 で前進し、休拍でピボット、5-6-7 で再び前進 | **L の右脇**を抜ける | F CCW ½、L も CW に回り込む | 入れ替わる | 2 人が同じ点を中心に逆回りで 180° 回る。⚠ MG の Enchufa（B24）とは経路が違う | WP1, RW, SS |
| L03 | Setenta（セテンタ、"70"） | 交差 → HL | 2×8 以上 | HL → くぐり → くぐり → Enchufla → DQN | ⚠ HL への入り方が出典で違う | F は L の右側 | 腕が絡んではほどけるのが連続する | REF, WB |
| L04 | Prima（プリマ） | 片手 | — | バックブレイクのあと L が F を近くへ引き寄せ（F の右腕は上）、受け止めて一緒に回る | 2 人一緒に回る | ルエダでは次の F へ | 引き寄せて抱き止め、一緒に回る | RW, WB |
| L05 | Vacílala（バシララ） | 手を離す / 保持 | 1・3・6 のいずれかで始まる | 移動しながら回る | F 右（移動しながら） | DQN へ | ≒ 移動するフリーの右ターン | SS, REF |
| L06 | Exhíbela（エキシベラ） | 片手 | F が 3 歩前進 → 休拍で方向転換 → 戻る | L から離れて楕円を描き、戻る | F 右 | 元の位置 | 移動しながらの右回転で、最後は元の位置へ戻る | SS, RC, REF |
| L07 | Coca-Cola（コカコーラ） | 片手 / 両手 / 交差 | 5-6-7 で 3 歩のピボット（1 歩ごとに約 180°） | DQN の途中 | F CCW の小刻みなピボット | — | 横断中に CCW のピボットが重なる。≒ CBL 中の連続左ピボット | SS, RW, REF |
| L08 | Kentucky（ケンタッキー） | 両手 | — | inside でカドルへ | F CCW | DQN | カドルの形と、L の腕が頭上を越える動き | REF |
| L09 | Montaña（モンターニャ） | RR + LL | — | バックブレイクして入れ替わる | — | 入れ替わる | 両手を交差したままの入れ替え | RW |
| L10 | Paséala（パセアラ） | 片手 | — | L が F を自分の背中側へ引き回す | — | — | F が L の背後を通る（≒ ウォークアラウンド） | RW, REF |
| L11 | Siete（シエテ） | LR | 前の技の 7 でプレップ（左手を円の内側へ入れてから外へ振る） | 1-2-3 で巻き込み、5-6-7 でほどく | — | 元へ | 7 の振りが合図 | RW, REF |
| L12 | Sácala（サカラ） | 片手 | — | 向かい合って角度を入れ替える | — | — | ⚠ SU の説明は他と合わない（REF: Exhíbela と同一とする説あり） | SU, REF |

**合計: A 7 + B 33 + C 26 + D 16 + E 9 + F 19 + G 14 + H 12 + I 11 + J 9 + K 4 + L 12 = 172 行。**
このうち D07 は 4 つの派生名をまとめた 1 行なので、独立した技は 171 になる。
「⚠ 名前のみ」の行（約 20）は名称を確認しただけで、動きは確認できていない。

---

## 2. 紛らわしい組（映像での見分け方）

単眼カメラ・0.1 秒刻みのフレームを前提にした。
まず**7 拍目（On2 では横断が終わる 3 拍目の直後）に F がどちらの端にいるか**、次に**手の高さと初動の向き**を見る。この 2 つで大半が分かれる。

| # | 紛らわしい組 | 見分けるポイント |
|---|---|---|
| 1 | CBL（B01） ↔ その場の右ターン（C01） | 終わりに 2 人の左右が入れ替わっていれば CBL 系。CBL では L が体を 90° 開き、右ターンでは正面のまま 1 歩下がる |
| 2 | CBL インサイド（B02） ↔ アウトサイド（B03） | 回転方向で分ける（顔の向きの順序を 3 フレーム以上見る）。On2 ではアウトサイドが **2** で回り始め、インサイドは **3** で回り始める。手の初動はインサイドが内側、アウトサイドが外側へ振り出す |
| 3 | CBL（B01） ↔ リバース CBL（B09） | L が開く向きで分ける（CBL は左、リバースは右）。F が L のどちら側を通るか（CBL は L の左、リバースは L の右）。カメラで奥側を通る場合は grammar §4.2 の表で換算する |
| 4 | コパ（D01） ↔ CBL アウトサイド（B03） | 終わりに F がどちらの端にいるか。コパは**同端**（行って戻る）、CBL は**反対端**。コパでは 3〜4 で F が L の胸の前に背中を見せて止まる |
| 5 | 360° CBL（B14） ↔ CBL（B01） | B14 は 2 人が密着したまま一緒に CCW に回る。⚠ 終わりの位置は出典で違うので、端と向きを観測して書く |
| 6 | ナチュラルトップ（C21） ↔ 360° CBL（B14） | どちらもクローズドで 2 人一緒に回るが、**方向が逆**。トップは CW、360° CBL は CCW |
| 7 | インサイドターン（B02） ↔ ヘアコーム（H05） | 胴体が回ったかどうか。MG によれば、手が外の斜めへ出ればターン、上の手前に来ればコーム。コームは肘が上がったまま手だけ肩へ下りる |
| 8 | ウォークスルー（B23） ↔ トンネル（B25） ↔ CBL インサイド（B02） | 3 つとも腕が上がる。トンネルは回らずに歩き抜ける。ウォークスルーは 1 で腕の橋をくぐり、5 で回る。インサイドは 3 から連続で回る |
| 9 | Enchufa（MG, B24） ↔ キューバンの Enchufla（L02） | MG 版は L の左へ回らずに歩き抜け、スロット上で終わる。キューバン版は F が L の**右脇**で CCW にピボットし、L も CW に回り込んで円を描く |
| 10 | ラップ / カドル（F01） ↔ ハンマーロック（E01） | 腕が F の**体の前**で交差し、並んで同じ向きならラップ。片腕が**背中**に折れて正面から消え、多くは向かい合ったままならハンマーロック |
| 11 | ラップ（F01） ↔ バレルロール（F05） ↔ バック・トゥ・バック（F06） | ラップは並んで同じ向き。バレルロールは L がフックターンで背中合わせになる（脚の交差が見える）。バック・トゥ・バックは F の回転中ずっと背中同士が接している |
| 12 | Titanic（G04） ↔ シャドー（I01） | MG の定義では、Titanic は RR で L が F の真後ろ、シャドーは LL で反対側。つないだ手が右同士か左同士かを見る。⚠ 流派によっては両方を「L が後ろ」と呼ぶので、持ち手と L の位置を書く |
| 13 | Titanic（位置, G04） ↔ Titanic dip（J08） | 頭の高さが急に下がればディップ。立ったまま縦に重なるだけなら位置としての Titanic |
| 14 | ソンブレロ（G03） ↔ ネックラップ（F15） ↔ ヘアコーム（H05） | ソンブレロは**両腕が 2 人の首の後ろ**に掛かり、両者の肘が上がる。ネックラップは片腕が首の後ろに止まる。コームは通過して離れる |
| 15 | バタフライ（G02） ↔ 交差持ちライトターン（G01） | どちらが上で交差しているかで分ける（バタフライは左が上、G01 は右が上）。バタフライは腕を左右へ大きく開いた形を見せる。回転方向もバタフライは左、G01 は右 |
| 16 | フックターン（C11） ↔ スポットターン（C07） ↔ ペンシルターン（C12） | フックは回る直前に脚が後ろで交差し、上体が固まる。スポットは前へ踏み出して回る。ペンシルは足元がほぼ動かず細い |
| 17 | バックスポット（C08） ↔ スポットターン（C07） | 回る前の踏み込みが後ろ（バック）か前か。腰の位置が一瞬下がるかどうか |
| 18 | L の背中での持ち替え（H01） ↔ L のアンダーアームターン（C05） | 持ち替えでは手が L の腰の後ろで合わさり、腕は頭上に上がらない。ターンでは腕が L の頭上でアーチになる |
| 19 | アクスル（C16） ↔ 右ターン（C01） | アクスルは 5-6-7 で手が反時計回りの円を描いてから **1** で回る。右ターンは 2 でプレップし、2〜3 で回る |
| 20 | MG の Check（C17） ↔ ショルダーチェック（D08） ↔ ハーフターン＋チェック（D16） | MG の Check は 1 カウントで左 1 回転する。ショルダーチェックは L の手が**肩に当たって**止まる。D16 は 180° で止まり逆回転で戻る（顔の向きが往復する） |
| 21 | ショルダーチェック（D08） ↔ ストマックラップ（D14） | 止める接触点が肩か腹か。ストマックラップでは L の腕が F の腹の前を横切る |
| 22 | タッチ・アンド・ゴー（C18） ↔ フリースピン（C15） | タッチ・アンド・ゴーは回転中に手を離し、**3 で再びつなぐ**。フリースピンは回転の全体で接触がない |
| 23 | ダブルターン（C03） ↔ アウトサイド 2½（B05） | 端が変わるかどうか。ダブルはその場（同端）、アウトサイドは移動して反対端 |
| 24 | ハーフムーン（G06） ↔ CBL アウトサイドの連続 | ハーフムーンは RR のまま、スロットの上下に半円を描いて往復する。単発の CBL は直線で入れ替わる。⚠ 「Titanic」と呼ぶ人もいるので、名前より軌道を書く |
| 25 | シットダウン（J09） ↔ ディップ（J01） | 下がるのが L（膝をつく）ならシットダウン。F が後ろへ倒れ、L が支えるならディップ |
| 26 | ラップ・アンド・ウォーク（F07） ↔ CBL / Enchufa | 横断が始まったように見えて、**渡り切らずに同じ側に残り**、L が F の後ろに付いて歩く |
| 27 | DC の Simple wrap（F09） ↔ 通常のラップ（F01） | F が L の右側を**時計回り**に回り込む（F09）か、L の右手で **inside（CCW）** に巻かれる（F01）か |
| 28 | Suave（B15） ↔ Rejection（B16） | どちらも CBL 中に L が回る。Suave は左回転の足型（前へ踏んで回る）、Rejection はフックターン（脚の後ろでの交差） |

---

## 3. 出典で食い違う点（⚠ のまとめ）

| 項目 | 説 A | 説 B | 扱い |
|---|---|---|---|
| inside / outside | サルサの主流は L を基準に、inside = F の左回転（DD8, WP1, MG） | バチャータ流では F の腕が体の前を横切るかどうかで決める（DD8） | 左 / 右回転を必ず併記する |
| Copa の開始ホールド | MG: LL | SG・NY 系: RR（REF） / jantar: CL → ゴブレット形 | ホールドは観測して書く |
| Copa の終わり | NY 系: 元の端へ戻る（REF） | MG: 横へ開いて次の技（Axle など）へ | 「戻ったか・開いたか」を書く |
| Enchufa / Enchufla | MG: L の左へ回らずに歩き抜ける | キューバン（WP1, RW, SS）: L の右脇を CCW½ ピボット | 別の技として扱う（B24 / L02） |
| Titanic | MG: L が真後ろ・RR・左手を F の肩 / LF: Butterfly = Titanic | DF: Half moon with turn and a half / SU: ディップの一種 / REF: 腕を横に広げる | 持ち手・L の位置・頭の高さを書く |
| Shadow | MG: Titanic の反対側・LL | SG: L が F の真後ろ・同じ向き（持ち手の規定なし） | L の位置と持ち手を書く |
| Butterfly | DD4: X左上で腕を大きく開く | SG5: ライン・オブ・ダンスに直角に並ぶ向きの名前 / LF: = Titanic | 腕の形と向きを書く |
| Sombrero の回転 | RW・SOZ: F は CW（右） | WB: F は左回転 | 回転方向は観測して書く |
| Sombrero の終わり | RW: F は L の右側 | SG: 右・左の両方がある | 左右は観測して書く |
| Check | SG・DD: 途中で止めて送り返すこと | MG: 1 カウントの左ターン（left axle） | 「止めた」のか「回った」のかを書く |
| Hammerlock への入り方 | MG・DD2: 右ターンから、手を低く保つ | REF ほか: 左回転（inside）で巻き込む | 回転方向を観測して書く |
| Around the world | SG10: Natural top（2 人一緒に CW） | DD2: ライン・オブ・ダンス＋右ターン＋位置交換のパターン | 動きで書く |
| Hook turn の方向 | JA: CW | DD3: さまざま | 観測して書く |
| 360° CBL の終わり | SG7: 元の位置・元の向き | MG: 3 で逆向きに開く | 端と向きを観測して書く |
| Walk around | DD・REF: F が L の周りを歩く | DC: L が F の周りを歩く | 誰が歩いたかを書く |
| Peek-a-boo | DC: 回転なし（L が肩を回して隠れる） | REF: F を左½回して止める | 回転の有無を書く |
| On2 の CBL の数え方 | MG: L が 5-6-7 で開き、F は 1-2-3 で横断 | 教室によって 1×8 の起点が違う（REF §1.3） | F が半回転する拍を観測値として書く |

---

## 4. 足りない点（今後の課題）

- **On2 の拍が出典で確かめられたのは、主に The Mambo Guild の約 20 項目だけ**。残りは On1 の記述から換算した（「換」）か、拍の記載がない（「—」）。
  Eddie Torres の公式教材や、On2 スタジオのシラバス本文（YouTube の解説文を含む）は取得できなかった（会員制・JS 必須・403）。
- **日本語名**は、日本の教室で使われるカタカナ表記を付けただけで、日本語ソースとの照合は Salsa Vida 日本語版の「クロスボディ・リード」だけ。和名が別にある技は確認できなかった。
- 名前しか確認できなかった技（⚠ 名前のみ）: Tow truck、Titanic flare、Windows、Mixmaster、Matador、Hand drapes、Back hand pass、Lock twirl、Diva walks、Rainbow copa など。
  ほかに LA walk、Cape、Pizza turn、Illusion turn も名前だけ確認したので、表から外した。
- Salsa Crazy、Salsa Lovers、SalsaWay、BaileBaile、Learn to Dance Salsa は、検索で技の一覧ページを見つけられなかった。
  salsaforums.com・dance-forums.com のスレッドは 403 で読めず、Reddit の該当スレッドも見つからなかった。
- ディップの安全上の注意や、キューバンの Matrix（macho dip）は扱っていない。

---

## 5. 出典（コード → URL）

| コード | URL |
|---|---|
| REF | 既存 `docs/salsa-partnerwork-reference.md`（salsaisgood の Copa / Hammerlock / Sombrero、ruedawiki、Dance Central Rueda、jantar ほか約 30 件の集約） |
| DD1 | https://thedancedojo.com/blog/siesta-swoop/ （Salsa Moves List） |
| DD2 | https://thedancedojo.com/beginner-salsa-patterns/ |
| DD3 | https://thedancedojo.com/blog/9-salsa-turns-and-how-to-use-them/ |
| DD4 | https://thedancedojo.com/blog/7-salsa-inside-turn-variations-you-should-know/ |
| DD5 | https://thedancedojo.com/blog/7-salsa-outside-turn-variations/ |
| DD6 | https://thedancedojo.com/blog/add-turns-to-cross-body-lead/ |
| DD7 | https://thedancedojo.com/blog/how-to-do-the-reverse-cross-body-lead-right-side-pass/ |
| DD8 | https://thedancedojo.com/blog/inside-outside-turns-salsa-bachata/ |
| DD9 | https://thedancedojo.com/?p=5800 （Shoulder Catches） |
| DD10 | https://thedancedojo.com/blog/how-to-lead-and-follow-salsa-6-signals-to-master/ |
| MG-gl | https://www.themamboguild.com/glossary （On2 用語集の索引） |
| MG-copa | https://www.themamboguild.com/glossary/copa |
| MG-enchufa | https://www.themamboguild.com/glossary/enchufa |
| MG-walkthrough | https://www.themamboguild.com/glossary/walkthrough |
| MG-breakback | https://www.themamboguild.com/glossary/breakback |
| MG-360 | https://www.themamboguild.com/glossary/360-cross-body-lead |
| MG-titanic | https://www.themamboguild.com/glossary/titanic |
| MG-axle | https://www.themamboguild.com/glossary/partner-axle-turn |
| MG-hl | https://www.themamboguild.com/glossary/hammerlock |
| MG-b2b | https://www.themamboguild.com/glossary/back-to-back |
| MG-ww | https://www.themamboguild.com/glossary/wrap-and-walk |
| MG-in | https://www.themamboguild.com/glossary/inside-turn |
| MG-out | https://www.themamboguild.com/glossary/outside-turn |
| MG-check | https://www.themamboguild.com/glossary/check |
| MG-cbl | https://www.themamboguild.com/glossary/cross-body-lead |
| MG-shadow | https://www.themamboguild.com/glossary/shadow-position |
| MG-tng | https://www.themamboguild.com/glossary/touch-and-go |
| MG-dnc | https://www.themamboguild.com/glossary/drop-and-catch |
| MG-juggle | https://www.themamboguild.com/glossary/hand-juggle |
| MG-send | https://www.themamboguild.com/glossary/send-off |
| MG-rt | https://www.themamboguild.com/glossary/right-turn |
| MG-lt | https://www.themamboguild.com/glossary/left-turn |
| MG-hook | https://www.themamboguild.com/glossary/hook-the-annibal-one |
| MG-comb | https://www.themamboguild.com/glossary/partner-comb |
| SG1 | https://www.salsaisgood.com/dictionary/Salsa_dictionary.htm |
| SG2 | https://www.salsaisgood.com/dictionary/dictionary_Checks.htm |
| SG3 | https://www.salsaisgood.com/dictionary/dictionary_Embrace.htm |
| SG4 | https://www.salsaisgood.com/dictionary/dictionary_Orientations_Shadow.htm |
| SG5 | https://www.salsaisgood.com/dictionary/dictionary_Orientations_Butterfly.htm |
| SG6 | https://www.salsaisgood.com/dictionary/dictionary_turns.htm |
| SG7 | https://www.salsaisgood.com/dictionary/dictionary_XBL.htm |
| SG8 | https://www.salsaisgood.com/dictionary/dictionary_Arm%20Lock.htm |
| SG9 | https://www.salsaisgood.com/dictionary/dictionary_Loop.htm |
| SG10 | https://www.salsaisgood.com/dictionary/dictionary_top.htm |
| SG / SG-hl | salsaisgood の Sombrero / Hammerlock ページ（REF に URL 記載） |
| JA | https://www.jantar.org/salsa/ |
| DF | https://dancefeverstudios.com/nyc-salsa-must-know-patterns/ |
| DIT | https://danceintime.com/info/syllabus |
| DC | https://www.dancecentral.info/ballroom/club-dances/salsa/salsa-notes |
| LOD | https://libraryofdance.org/dances/salsa |
| SOZ | https://sozai.app/transcript/salsa-deacher-sombrero/index.md |
| DP | https://dancepapi.com/videos/sombrero-cuban-salsa/ |
| A2S | https://www.addicted2salsa.com/videos/ |
| HM | https://www.salsaville.com/hmsa/HMSA-IV_guide_detailed.htm |
| SV1 | https://www.salsavida.com/articles/salsa-steps/ |
| SV2 | https://www.salsavida.com/salsa-101/salsa-dance-terms/ |
| SV3 | https://www.salsavida.com/?p=24637 （日本語版: ニューヨークスタイル・サルサ On2）、https://www.salsavida.com/?p=24599 （日本語用語集） |
| WP1 | https://en.wikipedia.org/wiki/Glossary_of_dance_moves |
| WP2 | https://en.wikipedia.org/wiki/Dip_(dance_move) |
| WB | https://en.wikibooks.org/wiki/Rueda_de_Casino |
| RW | https://ruedawiki.org/ |
| SS | https://salsaselfie.com/list-of-dance-terms-in-cuban-salsa-casino/ |
| RC | https://rueda.casino/rueda/beginner/free/ |
| SU | https://www.salsauniversity.com/blog/top-10-salsa-techniques-for-perfect-partner-dancing |
| TDS | https://torontodancesalsa.ca/6wksn1complete28672/ |
| UW | https://dance.washington.edu/salsa-ii-placement-criteria |
| LF | https://lafontaine.atlassian.net/wiki/spaces/PUB/pages/726401041/Salsa+On+1 |
| SF2 | https://salsa.thesalsafoundation.com.au/salsa2point0 （Copa の変種・Hammerlock copa・Titanic、検索結果の抜粋のみ参照） |
| PP | https://on2ourage.punchpass.com/classes/15303087 、https://app.punchpass.com/org/1281/classes/15853477 （On2 クラスの概要） |
| YT | YouTube の講座タイトル: "SALSA ON2 - Partnerwork Basics"（Lesson 2 Cross Body Lead / Lesson 10 Traveling Right Turn）、"Copa Tutorial - Adv Beg Partnerwork L2 - Salsa ON2"（https://www.youtube.com/watch?v=DgJR7yEzTO4）、"Salsa On2 Intermediate Turn Pattern Combo"（https://www.youtube.com/watch?v=GwrdZ3jvIQw） |
