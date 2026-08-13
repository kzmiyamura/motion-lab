# -*- coding: utf-8 -*-
"""クリップから腕タイムライン（armTimeline）を生成するオフライン幾何パス。

docs/arm-state-machine-design.md の実装。腕の実観測は使わない。
腰・肩線・鼻・動線という観測率の高い量と、events × beatGrid だけから
「どの手をつないでいるか」「各手がどの状態か」を決定的に起こす。

使い方:
    python build_arm_timeline.py <clip.json> [--write] [--bpm=176]
    音声から拍が取れているクリップは clip.beatGrid を使う。無音のクリップは --bpm で拍を与える。
    --write を付けるとクリップ JSON に armTimeline キーを埋め込み、
    サイドカー <id>_armtimeline.json も並べて書く。無ければ標準出力に要約のみ。

記録済みの hold 文字列は入力として使わない（3本18件で 2D/3D 一致0件のため）。
"""
import json
import math
import sys
from pathlib import Path

ARM_REACH_PAIR = 1.02   # これを超えたら手は届かない（ランタイムの PAIR_MAX と揃える）
SHINE_MIN_BEATS = 4     # hold なしがこの拍数続いたらシャイン（両者 free）とみなす
BPM_MIN, BPM_MAX = 140.0, 230.0   # サルサの実用域（analyze_beats.py と揃える）


def load(path):
    return json.load(open(path, encoding='utf-8'))


def joint_idx(clip):
    j = clip['joints']
    return {name: j.index(name) for name in j}


def frame_series(clip, pid):
    """人物 pid の時系列: t, 腰中点, 肩線, 鼻（欠測フレームはスキップ）"""
    J = joint_idx(clip)
    out = []
    for f in clip['frames']:
        p = f['p'].get(str(pid))
        if not p:
            continue
        v, j = p['v'], p['j']
        if v[J['lHip']] <= 0 or v[J['rHip']] <= 0:
            continue
        def pt(name):
            i = J[name]
            return (j[i * 3], j[i * 3 + 1], j[i * 3 + 2])
        lh, rh = pt('lHip'), pt('rHip')
        ls, rs = pt('lShoulder'), pt('rShoulder')
        nose = pt('nose') if v[J['nose']] > 0 else None
        out.append({
            't': f['t'],
            'hip': ((lh[0] + rh[0]) / 2, (lh[2] + rh[2]) / 2),
            'shoulders': (ls, rs) if v[J['lShoulder']] > 0 and v[J['rShoulder']] > 0 else None,
            'nose': nose,
        })
    return out


def sample(series, t):
    """時刻 t に最も近い観測（±0.3s 以内）。無ければ None"""
    best, bd = None, 0.3
    for s in series:
        d = abs(s['t'] - t)
        if d < bd:
            best, bd = s, d
    return best


def leader_frame(s):
    """リーダーの正面単位ベクトル（XZ）。肩線の法線2択を鼻で解く。取れなければ None"""
    if not s or not s['shoulders']:
        return None
    ls, rs = s['shoulders']
    ax, az = rs[0] - ls[0], rs[2] - ls[2]   # 肩線（左→右）
    n = math.hypot(ax, az)
    if n < 1e-6:
        return None
    # 法線の2候補
    f1 = (-az / n, ax / n)
    f2 = (az / n, -ax / n)
    if s['nose'] is None:
        return None
    cx, cz = (ls[0] + rs[0]) / 2, (ls[2] + rs[2]) / 2
    nx, nz = s['nose'][0] - cx, s['nose'][2] - cz
    # 鼻が向いている側が正面
    return f1 if f1[0] * nx + f1[1] * nz >= 0 else f2


def side_of(leader_s, follower_s):
    """リーダーから見てフォロワーが左(+)か右(-)か。読めなければ None"""
    fwd = leader_frame(leader_s)
    if fwd is None or follower_s is None:
        return None
    dx = follower_s['hip'][0] - leader_s['hip'][0]
    dz = follower_s['hip'][1] - leader_s['hip'][1]
    # 正面ベクトルと外積: 正 = リーダーの左側
    return fwd[0] * dz - fwd[1] * dx


def avg_side(lead, fol, t0, t1):
    vals = []
    t = t0
    while t <= t1:
        v = side_of(sample(lead, t), sample(fol, t))
        if v is not None:
            vals.append(v)
        t += 0.1
    return sum(vals) / len(vals) if vals else None


def pair_distance(lead, fol, t):
    a, b = sample(lead, t), sample(fol, t)
    if not a or not b:
        return None
    return math.hypot(a['hip'][0] - b['hip'][0], a['hip'][1] - b['hip'][1])


def beatgrid_from_bpm(bpm, source='given'):
    """BPM から等間隔格子を作る。音声が無いクリップ用。

    位相（カウント1がどこか）は決まらないが、腕の文法は全て「イベント時刻 ± k拍」の
    相対量なので、必要なのは拍の長さだけ。firstBeatSec は 0 の飾り。
    """
    interval = 60.0 / float(bpm)
    return {
        'bpm': round(float(bpm), 1),
        'firstBeatSec': 0.0,
        'beatIntervalSec': round(interval, 4),
        'confidence': 0.0,
        'source': source,
        'note': '音声にビートが無いため拍の長さのみ推定した格子。カウント1の位相は未確定',
    }


def estimate_bpm_from_events(clip):
    """技イベントの間隔から「1エイト（8拍）の長さ」を取り、拍に割り戻す。

    サルサの技は8カウント単位で入るので、隣接イベント間隔は1エイトの整数倍に集まる。
    範囲内（140〜230bpm 相当の 2.09〜3.43秒）の間隔のカーネル密度の山を1エイトとみなす。

    測って落ちた対抗案（2026-08-13・真値 172.3bpm の 2fda2815 で検定）:
      - 足首/腰/膝の速さ・加速度の包絡 × 自己相関/コム/小節割り: 誤差 3〜45% で
        推定値が 140〜250bpm に散る。乱数と区別がつかない
      - イベント絶対時刻の格子当て（Rayleigh）: 最良でも 163bpm（5.4%外し）、
        走査幅ぶんの多重比較を考えると有意でない
      - サルサのベーシック（1,2,3動く/4休む）テンプレート: 207.7bpm（17%外し）。
        技主体のクリップではベーシックを踏んでいないので当たらない
    この方式だけが真値クリップで誤差 3.2%（166.8 vs 172.3）。ただし根拠は間隔5〜10本で
    薄く、n=1 でしか検定できていない。過信しないこと。
    """
    ts = sorted(e['t'] for e in clip.get('events', []))
    ev = []
    for t in ts:
        if not ev or t - ev[-1] > 0.25:   # 同時刻の CBL+Turn は1つに畳む
            ev.append(t)
    lo, hi = 8 * 60.0 / BPM_MAX, 8 * 60.0 / BPM_MIN
    gaps = [ev[i + 1] - ev[i] for i in range(len(ev) - 1)]
    inr = [g for g in gaps if lo <= g <= hi]
    if len(inr) < 3:
        return None, 0
    bw = 0.08
    best, bestd, x = None, -1.0, lo
    while x <= hi:
        d = sum(math.exp(-0.5 * ((x - v) / bw) ** 2) for v in inr)
        if d > bestd:
            best, bestd = x, d
        x += 0.005
    return 8 * 60.0 / best, len(inr)


def detect_style(clip, bg):
    """On1/On2 の判定: リーダー足首の前後変位ピークが 8 拍のどこに乗るか。
    On1 はブレイク（最大変位）が 1・5 拍、On2 は 2・6 拍。confidence 低めの参考値"""
    J = joint_idx(clip)
    hist = [0.0] * 8
    prev = None
    for f in clip['frames']:
        p = f['p'].get(str(clip['leaderPid']))
        if not p or p['v'][J['lAnkle']] <= 0:
            continue
        z = p['j'][J['lAnkle'] * 3 + 2]
        if prev is not None:
            speed = abs(z - prev)
            beat = (f['t'] - bg['firstBeatSec']) / bg['beatIntervalSec']
            hist[int(beat) % 8] += speed
        prev = z
    if sum(hist) < 1e-6:
        return 'unknown', 0.0
    on1 = hist[0] + hist[4]
    on2 = hist[1] + hist[5]
    total = sum(hist)
    # 2/8 = 0.25 が偶然の水準。どちらかがそれを明確に超えていなければ判定しない
    share = max(on1, on2) / total
    if share < 0.30 or abs(on1 - on2) / (on1 + on2 + 1e-9) < 0.15:
        return 'unknown', round(share, 2)
    return ('On1' if on1 > on2 else 'On2'), round(share, 2)


def build_timeline(clip, bpm=None):
    lead = frame_series(clip, clip['leaderPid'])
    fol = frame_series(clip, 1 - clip['leaderPid'])
    bg = clip.get('beatGrid')
    if not bg and bpm:
        bg = beatgrid_from_bpm(bpm)
    if not bg:
        est, n = estimate_bpm_from_events(clip)
        if est:
            bg = beatgrid_from_bpm(est, source='events')
            bg['note'] += '（イベント間隔 %d 本から推定。真値クリップでの誤差 3.2%%）' % n
    if not bg:
        raise SystemExit('拍が決まりません（音声にビート無し・イベントも少なすぎる）。--bpm=<値> で与えてください')
    beat = bg['beatIntervalSec']
    duration = clip['duration']

    # ── イベントの統合: 同時刻の CBL + Turn は「ターン付きCBL」1件にする
    events = sorted(clip['events'], key=lambda e: e['t'])
    merged = []
    for ev in events:
        if merged and abs(ev['t'] - merged[-1]['t']) < 0.2:
            m = merged[-1]
            if ev['type'] == 'Turn':
                m['turn'] = {'rotations': ev.get('rotations', 1), 'by': ev.get('by', 'follower')}
            elif ev['type'] == 'CBL':
                m['type'] = 'CBL'
            continue
        m = {'t': ev['t'], 'type': ev['type']}
        if ev['type'] == 'Turn':
            m['turn'] = {'rotations': ev.get('rotations', 1), 'by': ev.get('by', 'follower')}
        merged.append(m)

    # ── 各イベントの通過側と手の対応
    for m in merged:
        rot = (m.get('turn') or {}).get('rotations', 1)
        dur = 1.6 + (rot - 1) * 0.5 if m.get('turn') else 2 * beat
        pre = avg_side(lead, fol, m['t'] - 1.6, m['t'] - 0.2)
        post = avg_side(lead, fol, m['t'] + dur, m['t'] + dur + 1.2)
        m['dur'] = dur
        m['sidePre'], m['sidePost'] = pre, post
        if pre is not None and post is not None and (pre > 0) != (post > 0) and abs(pre - post) > 0.25:
            m['passSide'] = 'right' if post < 0 else 'left'   # 負 = リーダーの右
        else:
            m['passSide'] = None   # その場（手は替わらない）

    # ── 手の対応の時系列: 通過イベントでのみ切り替える
    #    右へ通過 → リーダー右手 × フォロワー左手（左は鏡像）
    def hold_for(pass_side):
        return {'leader': 'R', 'follower': 'L'} if pass_side == 'right' \
            else {'leader': 'L', 'follower': 'R'}
    # 最初の通過イベントから逆算して開始時の hold を決める
    #（通過前は「これから通る側と逆」の手をつないでいたはず）
    first_pass = next((m for m in merged if m['passSide']), None)
    if first_pass:
        cur_hold = hold_for('left' if first_pass['passSide'] == 'right' else 'right')
    else:
        cur_hold = {'leader': 'L', 'follower': 'R'}   # オープンホールドの既定
    for m in merged:
        m['holdBefore'] = dict(cur_hold)
        if m['passSide']:
            cur_hold = hold_for(m['passSide'])
        m['holdAfter'] = dict(cur_hold)

    # ── セグメント展開
    segs = []

    def emit(t0, t1, phase, hold, states_l, states_f, extra=None):
        if t1 - t0 < 0.02:
            return
        seg = {
            't0': round(max(0, t0), 3), 't1': round(min(duration, t1), 3),
            'phase': phase, 'hold': hold,
            'leader': states_l, 'follower': states_f,
        }
        if extra:
            seg.update(extra)
        segs.append(seg)

    def hold_states(hold):
        l = {'L': 'hold' if hold and hold['leader'] == 'L' else 'free',
             'R': 'hold' if hold and hold['leader'] == 'R' else 'free'}
        f = {'L': 'hold' if hold and hold['follower'] == 'L' else 'free',
             'R': 'hold' if hold and hold['follower'] == 'R' else 'free'}
        return l, f

    def emit_idle(t0, t1, hold):
        """イベント間: 距離で hold / free（シャイン）を分ける"""
        if t1 - t0 < 0.02:
            return
        # 距離の中央値で判定（区間をまたぐ細かい切り替えはしない）
        ds = [d for d in (pair_distance(lead, fol, t0 + i * 0.2)
                          for i in range(int((t1 - t0) / 0.2) + 1)) if d is not None]
        med = sorted(ds)[len(ds) // 2] if ds else None
        if med is not None and med > ARM_REACH_PAIR and (t1 - t0) > SHINE_MIN_BEATS * beat:
            l, f = hold_states(None)
            emit(t0, t1, 'shine', None, l, f, {'confidence': 'observed'})
        else:
            l, f = hold_states(hold)
            emit(t0, t1, 'hold', hold, l, f,
                 {'confidence': 'observed' if med is not None else 'inferred'})

    def monotonic(ts, floor):
        """フェーズ境界を単調非減少に均す（前の技がはみ出した分だけ後ろの技を詰める）"""
        out, prev = [], floor
        for t in ts:
            prev = max(prev, t)
            out.append(prev)
        return out

    cursor = 0.0
    swallowed = 0
    for m in merged:
        turn = m.get('turn')
        conf = 'observed' if m['sidePre'] is not None and m['sidePost'] is not None else 'inferred'
        if m['type'] == 'CBL':
            t_open, t_pass, t_close, t_end = monotonic(
                [m['t'] - beat, m['t'], m['t'] + 2 * beat, m['t'] + 3 * beat], cursor)
            if t_end - t_open < 0.02:
                swallowed += 1
                continue
            emit_idle(cursor, t_open, m['holdBefore'])
            l, f = hold_states(m['holdBefore'])
            emit(t_open, t_pass, 'open', m['holdBefore'], l, f,
                 {'passSide': m['passSide'], 'confidence': conf})
            # pass 中: 右手=背中サポート、左手=胸の高さでキープ（ユーザー確認済み）
            hold_pass = {'leader': 'L', 'follower': m['holdBefore']['follower']}
            lp = {'L': 'hold', 'R': 'back_support'}
            fp = {'L': 'hold' if hold_pass['follower'] == 'L' else 'free',
                  'R': 'hold' if hold_pass['follower'] == 'R' else 'free'}
            extra = {'passSide': m['passSide'], 'confidence': conf, 'holdHeight': 'chest'}
            if turn:
                extra['turn'] = {'dir': 'CW', 'rotations': turn['rotations'],
                                 'turner': turn['by']}
            emit(t_pass, t_close, 'pass', hold_pass, lp, fp, extra)
            l, f = hold_states(m['holdAfter'])
            emit(t_close, t_end, 'close', m['holdAfter'], l, f, {'confidence': conf})
            cursor = t_end
        elif turn:
            t_prep, t_init, t_rot0, t_rot1, t_end = monotonic(
                [m['t'] - 2 * beat, m['t'] - 0.5 * beat, m['t'] + 0.5 * beat,
                 m['t'] + turn['rotations'] * 2 * beat,
                 m['t'] + turn['rotations'] * 2 * beat + beat], cursor)
            if t_end - t_prep < 0.02:
                swallowed += 1
                continue
            emit_idle(cursor, t_prep, m['holdBefore'])
            # 回るのがフォロワーなら、リーダーのつなぎ手が prep → lead_turn とリードする。
            # リーダー自身が回る技（by=leader）では手はつないだまま。誰が回るかは turn.turner
            lh = m['holdBefore']['leader']
            leads = turn['by'] != 'leader'
            tinfo = {'turner': turn['by'], 'rotations': turn['rotations']}
            l, f = hold_states(m['holdBefore'])
            if leads:
                l = dict(l); l[lh] = 'prep'
            emit(t_prep, t_init, 'prep', m['holdBefore'], l, f,
                 {'turn': tinfo, 'confidence': conf})
            l, f = hold_states(m['holdBefore'])
            if leads:
                l = dict(l); l[lh] = 'lead_turn'
            emit(t_init, t_rot0, 'initiate', m['holdBefore'], l, f,
                 {'turn': tinfo, 'passSide': m['passSide'], 'confidence': conf})
            emit(t_rot0, t_rot1, 'rotate', m['holdBefore'], l, f,
                 {'turn': tinfo, 'passSide': m['passSide'], 'confidence': conf})
            l, f = hold_states(m['holdAfter'])
            emit(t_rot1, t_end, 'settle', m['holdAfter'], l, f, {'confidence': conf})
            cursor = t_end
    emit_idle(cursor, duration, cur_hold)

    # ── 連続・非重複の保証（スキーマの前提）。emit_idle が飛ばした穴も可視化のため潰す
    segs.sort(key=lambda s: (s['t0'], s['t1']))
    for i in range(1, len(segs)):
        if segs[i]['t0'] < segs[i - 1]['t1']:
            segs[i - 1]['t1'] = segs[i]['t0']
    segs = [s for s in segs if s['t1'] - s['t0'] > 0.02]
    # 微小セグメントを落とした跡の穴は、直前のセグメントを伸ばして埋める（連続の保証）
    for i in range(1, len(segs)):
        if segs[i]['t0'] > segs[i - 1]['t1']:
            segs[i - 1]['t1'] = segs[i]['t0']

    style, style_conf = detect_style(clip, bg)
    inferred = sum(1 for s in segs if s.get('confidence') != 'observed')
    return {
        'version': 1,
        'source': 'geometry',
        'style': style, 'styleConfidence': style_conf,
        'beatGrid': bg,
        'stats': {'segments': len(segs), 'inferred': inferred,
                  'swallowedEvents': swallowed},
        'segments': segs,
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    write = '--write' in sys.argv
    bpm = next((float(a.split('=', 1)[1]) for a in sys.argv[1:] if a.startswith('--bpm=')), None)
    for path in args:
        path = Path(path)
        clip = load(path)
        tl = build_timeline(clip, bpm)
        bg = tl['beatGrid']
        print(f"== {path.name}: style={tl['style']}({tl['styleConfidence']}) "
              f"beat={bg['bpm']}bpm/{bg.get('source', 'audio')}(conf={bg['confidence']}) "
              f"segments={tl['stats']['segments']} inferred={tl['stats']['inferred']} "
              f"swallowed={tl['stats']['swallowedEvents']}")
        for s in tl['segments']:
            hold = s['hold']
            hs = f"L{hold['leader']}xF{hold['follower']}" if hold else '--'
            extra = ''
            if s.get('turn'):
                extra += f" turn={s['turn']['turner']}x{s['turn'].get('rotations','?')}"
            if s.get('passSide'):
                extra += f" pass={s['passSide']}"
            print(f"  {s['t0']:6.2f}-{s['t1']:6.2f} {s['phase']:<8} {hs:<6} "
                  f"L:{s['leader']['L']}/{s['leader']['R']} "
                  f"F:{s['follower']['L']}/{s['follower']['R']} "
                  f"[{s['confidence']}]{extra}")
        if write:
            side = path.with_name(path.stem.replace('_clip', '') + '_armtimeline.json')
            side.write_text(json.dumps(tl, ensure_ascii=False, indent=1), encoding='utf-8')
            clip['armTimeline'] = tl
            path.write_text(json.dumps(clip, ensure_ascii=False), encoding='utf-8')
            print(f"  -> wrote {side.name} + embedded into {path.name}")


if __name__ == '__main__':
    main()
