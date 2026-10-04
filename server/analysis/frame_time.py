"""
コマの時刻（動画のタイムスタンプ PTS）を、解析スクリプトのあいだで同じ取り方にそろえる共通の部品（README 26・27）。

可変フレームレート（画面録画・SNS から落とした動画）では「コマ番号 / 平均 fps」が本当の時刻（PTS。ブラウザの
video.currentTime・正解表・音声の拍と同じ時計）から最大 1 秒ずれる。analyze_pair はコマの時刻を
「コマ番号 / fps ＋ 前後 FRAME_TIME_SMOOTH_SEC 秒の（PTS − コマ番号 / fps）の中央値」にしている（pts_offsets）。
同じ動画のコマを読む他のスクリプト（analyze_rotation・refine_events・refine_turns_dense・prototype_lift3d）も
FrameClock を通して同じ時刻を使う。

  - 順に読む（コマ番号が分かる）: clock.time(idx)
  - 時刻 → コマ番号: clock.index_at(t) / clock.indices_between(t0, t1)
  - 時刻でコマを取る: seek_read(cap, clock.to_pts(t)) / grab_at(cap, t)。読んだコマの
    cap.get(POS_MSEC)（PTS そのもの）は clock.from_pts(p) で解析の時刻に直す
    （ならした時刻と PTS の差は画面録画のコマの揺れの分だけ。最大 0.1 秒ほど）

cv2 の CAP_PROP_POS_MSEC のシークは可変フレームレートで狙いより最大 0.34 秒ずれたコマに着く（着いたコマの
POS_MSEC は正しい PTS。README 27 で 6 本を確かめた）ので、直接使わず seek_read / grab_at を通す。CAP_PROP_POS_FRAMES の
シークも中では「PTS × 平均 fps」の番号なので、可変フレームレートでは「頭から数えた N 番目のコマ」にはならない。
コマ番号で取りたいときは頭から順に grab() / read() で数えること。
"""
import bisect
import math

FRAME_TIME_PTS = True
# 画面録画は 60fps の時間軸にコマが 1〜3 枠おきに不規則に並ぶので、PTS そのものではなく
# 「コマ番号 / fps」に、前後 FRAME_TIME_SMOOTH_SEC 秒の（PTS − コマ番号 / fps）の中央値を足した時刻を使う
# （ゆっくり溜まるずれだけ直し、コマごとの揺れは入れない）。0 = PTS そのもの
FRAME_TIME_SMOOTH_SEC = 1.0


def pts_offsets(pts, fps, smooth_sec=None):
    """コマごとの PTS（秒）の並び → コマごとの時刻（秒）。smooth_sec > 0 なら「コマ番号 / fps + 前後 smooth_sec 秒の
    (PTS − コマ番号 / fps) の中央値」、0 なら PTS そのもの。PTS が使えない（空・単調でない）なら None"""
    smooth_sec = FRAME_TIME_SMOOTH_SEC if smooth_sec is None else smooth_sec
    if not pts or any(not math.isfinite(p) for p in pts) or any(b < a for a, b in zip(pts, pts[1:])):
        return None
    if smooth_sec <= 0:
        return list(pts)
    off = [p - i / fps for i, p in enumerate(pts)]
    half = max(1, int(round(smooth_sec * fps)))
    out = []
    for i in range(len(pts)):
        w = sorted(off[max(0, i - half):i + half + 1])
        out.append(i / fps + w[len(w) // 2])
    return out


def read_pts(video_path):
    """動画を 1 回 grab() でなめてコマごとの PTS（秒）を返す。取れない・戻る（0 に落ちる）なら None"""
    import cv2
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    pts = []
    while cap.grab():
        p = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if not math.isfinite(p) or (pts and p <= 0):
            cap.release()
            return None
        pts.append(p)
    cap.release()
    return pts or None


def frame_time_map(video_path, fps, enabled=None, smooth_sec=None):
    """動画を 1 回なめてコマごとの時刻（pts_offsets）を返す。無効・PTS が取れなければ None"""
    if not (FRAME_TIME_PTS if enabled is None else enabled):
        return None
    pts = read_pts(video_path)
    return pts_offsets(pts, fps, smooth_sec) if pts else None


# cv2 の CAP_PROP_POS_MSEC のシークは、可変フレームレートの動画では狙いより遅れたコマに着くことがある
# （正解表 5 本で中央値 +0.005〜0.04 秒・最大 +0.31 秒。着いたコマの cap.get(POS_MSEC) は正しい PTS。README 27）。
# 狙いより SEEK_BACK_SEC 手前にシークして、着いた PTS を確かめてから前へ読み進める
SEEK_BACK_SEC = 0.5
SEEK_TRIES = 4


def seek_read(cap, t):
    """PTS が t 以下のコマに着くようにシークして 1 コマ読む。戻り値 (frame, pts) か (None, None)。
    呼び出し側はこのコマから順に read() で読み進める（時刻 t 以降のコマを取りこぼさない）"""
    import cv2
    t = max(0.0, t)
    back = SEEK_BACK_SEC if t > 0 else 0.0
    frame = p = None
    for _ in range(SEEK_TRIES):
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t - back) * 1000)
        ok, frame = cap.read()
        if not ok:
            frame = p = None
            back *= 2
            continue
        p = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if p <= t + 1e-3:
            break
        if t - back <= 0:
            # 頭まで戻しても遅れて着く → コマ番号 0 へ（頭は番号でも PTS でも同じ）
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
            ok, frame = cap.read()
            p = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000 if ok else None
            frame = frame if ok else None
            break
        back = back * 2 if back else SEEK_BACK_SEC
    return frame, p


def grab_at(cap, t):
    """時刻 t（PTS 秒）に画面に出ているコマ（PTS が t 以下で最後のコマ。ブラウザで currentTime = t にしたときと同じ）。
    戻り値 (frame, pts) か (None, None)。t が最初のコマより前なら最初のコマ"""
    import cv2
    frame, p = seek_read(cap, t)
    if frame is None:
        return None, None
    while p < t - 1e-3:
        ok, nxt = cap.read()
        if not ok:
            break
        q = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
        if q > t + 1e-3:
            break
        frame, p = nxt, q
    return frame, p


def _monotone(xs):
    """単調に増える並びにする（中央値でならした時刻は PTS の飛びの前後でわずかに戻ることがある）"""
    out, last = [], -math.inf
    for x in xs:
        last = max(x, last + 1e-6)
        out.append(last)
    return out


class FrameClock:
    """コマ番号 ↔ 解析の時刻（ならした PTS）。PTS が取れない動画は コマ番号 / fps（従来）に戻る"""

    def __init__(self, fps, times=None, raw=None):
        self.fps = float(fps) if fps and fps > 0 else 30.0
        self.times = _monotone(times) if times else None
        self.raw = list(raw) if raw and times and len(raw) == len(times) else None

    @classmethod
    def from_video(cls, video_path, fps=None, enabled=None, smooth_sec=None):
        import cv2
        if not fps:
            cap = cv2.VideoCapture(video_path)
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            cap.release()
        if not (FRAME_TIME_PTS if enabled is None else enabled):
            return cls(fps)
        raw = read_pts(video_path)
        times = pts_offsets(raw, fps, smooth_sec) if raw else None
        return cls(fps, times, raw)

    @classmethod
    def from_tracks(cls, frames, fps, n_frames=None):
        """tracks.json の frames（frameIdx と t。analyze_pair が 4 コマおきに書いた時刻）から、間のコマの時刻を線形に埋めた時計。
        動画をなめ直さない（refine_events の予算を食わない）。PTS の生の値は持たない（to_pts / from_pts は素通し）"""
        pts = sorted({f["frameIdx"]: f["t"] for f in frames or []
                      if isinstance(f.get("frameIdx"), int) and isinstance(f.get("t"), (int, float))}.items())
        if len(pts) < 2:
            return cls(fps)
        fps = float(fps) if fps and fps > 0 else 30.0
        last = max(pts[-1][0], (n_frames or 0) - 1)
        times = []
        k = 0
        for i in range(last + 1):
            while k + 2 < len(pts) and pts[k + 1][0] <= i:
                k += 1
            (i0, t0), (i1, t1) = pts[k], pts[k + 1]
            times.append(t0 + (t1 - t0) * (i - i0) / (i1 - i0))   # 端の外はその区間の傾きで延ばす
        return cls(fps, times)

    @property
    def is_pts(self):
        return self.times is not None

    def __len__(self):
        return len(self.times) if self.times else 0

    def time(self, idx):
        """コマ idx の時刻。範囲外は端のずれ（時刻 − コマ番号 / fps）をそのまま延ばす"""
        if not self.times:
            return idx / self.fps
        n = len(self.times)
        if 0 <= idx < n:
            return self.times[idx]
        j = 0 if idx < 0 else n - 1
        return idx / self.fps + (self.times[j] - j / self.fps)

    def index_at(self, t):
        """時刻 t に最も近いコマの番号（0 以上）"""
        if not self.times:
            return max(0, int(round(t * self.fps)))
        i = bisect.bisect_left(self.times, t)
        if i <= 0:
            return 0
        if i >= len(self.times):
            n = len(self.times) - 1
            return max(n, n + int(round((t - self.times[n]) * self.fps)))
        return i if self.times[i] - t < t - self.times[i - 1] else i - 1

    def indices_between(self, t0, t1):
        """時刻が [t0, t1] に入るコマの番号（昇順）"""
        if not self.times:
            return list(range(max(0, int(math.ceil(t0 * self.fps - 1e-9))), int(math.floor(t1 * self.fps + 1e-9)) + 1))
        a = bisect.bisect_left(self.times, t0 - 1e-9)
        b = bisect.bisect_right(self.times, t1 + 1e-9)
        return list(range(a, b))

    def to_pts(self, t):
        """解析の時刻 t → そのコマの PTS（CAP_PROP_POS_MSEC でシークする値）。PTS が無ければ t"""
        if not self.raw:
            return t
        i = self.index_at(t)
        return self.raw[min(i, len(self.raw) - 1)] + (t - self.time(i))

    def from_pts(self, p):
        """読んだコマの PTS（cap.get(CAP_PROP_POS_MSEC) / 1000）→ 解析の時刻"""
        if not self.raw:
            return p
        i = bisect.bisect_left(self.raw, p)
        if i >= len(self.raw):
            i = len(self.raw) - 1
        elif i > 0 and p - self.raw[i - 1] < self.raw[i] - p:
            i -= 1
        return self.times[i] + (p - self.raw[i])
