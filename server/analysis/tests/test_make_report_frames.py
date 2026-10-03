"""
make_report_frames.py の見出し解析（parse_scenes）の単体テスト。

Claude がレポートの「技のタイムライン」をどんな書き方で書いても場面を拾えること、
画像を差し込む位置が箇条書きを壊さないことを確かめる。

実行: python -m unittest discover -s server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from make_report_frames import IMAGE_LINE_RE, parse_scenes  # noqa: E402


def scenes_of(md):
    return parse_scenes(md.split("\n"))


class ParseScenesTest(unittest.TestCase):
    def test_bold_paragraph(self):
        s = scenes_of("## 2. 技のタイムライン\n\n**0:16 クロスボディリード**\n説明")
        self.assertEqual(s, [(2, 16.0, None, 2)])

    def test_bold_range_with_decimal(self):
        s = scenes_of("## 技のタイムライン\n**0:10.7〜0:11.1 CBL** — 説明")
        self.assertEqual(len(s), 1)
        self.assertAlmostEqual(s[0][1], 10.7)
        self.assertAlmostEqual(s[0][2], 11.1)

    def test_list_items_mmss_and_dashes(self):
        md = "\n".join([
            "## 2. 技のタイムライン",
            "- **00:00 フリースピン** — 説明",
            "- **00:08–00:09 クロスボディリード＋インサイドターン?** — 説明",
            "* **00:14 - 00:15 CBL**",
            "1. **1:02~1:05 ターン**",
            "- **0:20 — 0:24 ラップ**",
            "- **0:27〜0:28 CBL＋ダブル**",
        ])
        s = scenes_of(md)
        self.assertEqual([x[1] for x in s], [0.0, 8.0, 14.0, 62.0, 20.0, 27.0])
        self.assertEqual([x[2] for x in s], [None, 9.0, 15.0, 65.0, 24.0, 28.0])

    def test_hash_heading_and_plain_list(self):
        md = "## 技のタイムライン\n### 0:16 ターン\n- 0:20 CBL（太字なし）"
        s = scenes_of(md)
        self.assertEqual([(x[0], x[1]) for x in s], [(1, 16.0), (2, 20.0)])

    def test_only_inside_timeline_section(self):
        md = "\n".join([
            "## 1. 結論",
            "- **0:05 は導入**",
            "## 2. 技のタイムライン",
            "### シャイン（0:00〜0:32頃）",
            "- **0:17 ソロターン**",
            "## 3. 根拠",
            "- **0:07 の画像では**",
            "| 0:07 | 表の行 |",
        ])
        s = scenes_of(md)
        self.assertEqual([x[0] for x in s], [4])

    def test_no_timeline_section_requires_bold_or_heading(self):
        md = "**0:16 CBL**\n- 0:20 ただのメモ\n### 0:30 ターン"
        s = scenes_of(md)
        self.assertEqual([x[0] for x in s], [0, 2])

    def test_list_item_inserts_after_indented_continuation(self):
        md = "\n".join([
            "## 技のタイムライン",
            "- **0:08 CBL** — 説明",
            "  - 子項目1",
            "  続きの行",
            "- **0:12 ターン**",
        ])
        s = scenes_of(md)
        self.assertEqual([(x[0], x[3]) for x in s], [(1, 3), (4, 4)])

    def test_not_time_like(self):
        md = "## 技のタイムライン\n**10:005 x**\n**ルーティン 0:16**\n- 【5-6-7】"
        self.assertEqual(scenes_of(md), [])

    def test_image_line_re(self):
        self.assertTrue(IMAGE_LINE_RE.match("![0:16.0〜0:18.5](/analysis-output/j/out/report_frames/0016.0.jpg)"))
        self.assertFalse(IMAGE_LINE_RE.match("![x](/analysis-output/j/out/keyframes/a.jpg)"))


if __name__ == "__main__":
    unittest.main()
