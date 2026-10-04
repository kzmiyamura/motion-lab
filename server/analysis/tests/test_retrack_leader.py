"""
README 31 の単体テスト（動画も YOLO も使わない）: 付け直した人物 ID（update_events.retrack）の男の pid の決め方。

古い追跡が途中で男女を入れ替えたまま戻らなかった動画（1230b3d5: 16 秒で入れ替わり、全編の 9 割が逆）では、
全編の多数決は入れ替わった後の人を男にしてしまう。冒頭（2 人がそろった最初のコマから 8 秒）で合わせる。

実行: python -m pytest server/analysis/tests
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import update_events as ue  # noqa: E402


def frames_and_saved(old_pids, new_pids, dt=0.1):
    """各コマ 2 人。old_pids / new_pids: コマごとの (pid_a, pid_b)"""
    frames = [{"t": i * dt, "kept": [{"pid": n[0]}, {"pid": n[1]}]} for i, n in enumerate(new_pids)]
    saved = [list(o) for o in old_pids]
    return frames, saved


class TestMatchLeader(unittest.TestCase):
    def test_old_tracking_swapped_after_start_keeps_start_leader(self):
        # 元の追跡: 0〜15 秒は (0, 1)、以後は入れ替わって (1, 0)。付け直しは全編 (1, 0)（= 元の 0 番が新の 1 番）。
        # 冒頭は元と逆（swapped）なので男は 1 - 元。全編では元と同じ 10% しか一致しないが、全編の多数決でも
        # 結果は同じになる向きに作る（一致 < 入れ替わり）。ここで効くのは「冒頭で決める」こと
        n_early, n_late = 150, 1350
        old = [(0, 1)] * n_early + [(1, 0)] * n_late
        new = [(1, 0)] * (n_early + n_late)
        frames, saved = frames_and_saved(old, new)
        same, swapped, leader = ue.match_leader(frames, saved, old_leader=1)
        self.assertEqual((same, swapped), (n_late * 2, n_early * 2))
        # 冒頭は入れ替わり → 男は 1 - 1 = 0。全編の多数決（一致が多い）なら 1 のまま = 後半の人を男にして逆
        self.assertEqual(leader, 0)

    def test_whole_video_majority_would_be_wrong(self):
        # 付け直しが冒頭では元と同じ、以後は元が入れ替わった側 → 全編は入れ替わりが多数でも、男は冒頭に合わせて元のまま
        n_early, n_late = 150, 1350
        old = [(0, 1)] * n_early + [(1, 0)] * n_late
        new = [(0, 1)] * (n_early + n_late)
        frames, saved = frames_and_saved(old, new)
        same, swapped, leader = ue.match_leader(frames, saved, old_leader=1)
        self.assertLess(same, swapped)  # 全編の多数決なら 1 - 1 = 0 に倒れる
        self.assertEqual(leader, 1)     # 冒頭に合わせるので元のまま

    def test_identical_labels_keep_leader(self):
        frames, saved = frames_and_saved([(0, 1)] * 50, [(0, 1)] * 50)
        self.assertEqual(ue.match_leader(frames, saved, old_leader=0)[2], 0)

    def test_unknown_leader_stays(self):
        frames, saved = frames_and_saved([(0, 1)] * 5, [(1, 0)] * 5)
        self.assertIsNone(ue.match_leader(frames, saved, old_leader=None)[2])


if __name__ == "__main__":
    unittest.main()
