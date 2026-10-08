/**
 * 区間ダイジェスト（純粋関数）のテスト。claude・動画は使わず、手で作った骨格で確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySegmentRows, buildSegmentDigest, buildSegmentPrompt, cardsIn, closestWristPair, extractHandRules, facingOf, handOfWrist,
  pairPersons, pairState, parseSegmentAnswer, raisedHands, toIntervals, wristsNearHead, type TrackFrame, type TrackPerson,
} from './segmentDigest.js';

type P = [number, number, number];
/** 17 点の骨格。指定した番号以外は信頼度 0 */
function kps(over: Record<number, P>): number[][] {
  const k: number[][] = Array.from({ length: 17 }, () => [0, 0, 0]);
  for (const [i, v] of Object.entries(over)) k[Number(i)] = v;
  return k;
}

/** 顔が見える人（左肩 5 が画面の右）。cx=体の中心 x、wristL/wristR は 9/10 の位置 */
function frontPerson(pid: number, cx: number, wr: { l?: [number, number]; r?: [number, number] } = {}): TrackPerson {
  return {
    pid, bbox: [cx - 0.1, 0.2, cx + 0.1, 0.8],
    kps: kps({
      0: [cx, 0.28, 0.95], 1: [cx - 0.01, 0.27, 0.9], 2: [cx + 0.01, 0.27, 0.9],
      5: [cx + 0.05, 0.4, 0.95], 6: [cx - 0.05, 0.4, 0.95], 11: [cx + 0.03, 0.6, 0.95], 12: [cx - 0.03, 0.6, 0.95],
      9: [...(wr.l ?? [cx + 0.08, 0.55]), 0.9] as P, 10: [...(wr.r ?? [cx - 0.08, 0.55]), 0.9] as P,
    }),
  };
}

/** 背中向きの人（左肩 5 が画面の左。鼻・目は見えない） */
function backPerson(pid: number, cx: number, wr: { l?: [number, number]; r?: [number, number] } = {}): TrackPerson {
  return {
    pid, bbox: [cx - 0.1, 0.2, cx + 0.1, 0.8],
    kps: kps({
      0: [cx, 0.28, 0.05],
      5: [cx - 0.05, 0.4, 0.95], 6: [cx + 0.05, 0.4, 0.95], 11: [cx - 0.03, 0.6, 0.95], 12: [cx + 0.03, 0.6, 0.95],
      9: [...(wr.l ?? [cx - 0.08, 0.55]), 0.9] as P, 10: [...(wr.r ?? [cx + 0.08, 0.55]), 0.9] as P,
    }),
  };
}

test('pairPersons: 背の低い奥の別人は除き、1人になる（片方が隠れている）', () => {
  const near: TrackPerson = { pid: 0, bbox: [0.1, 0.2, 0.5, 0.8] };
  const far: TrackPerson = { pid: 1, bbox: [0.6, 0.3, 0.7, 0.5] };
  const f: TrackFrame = { t: 0, kept: [near, far] };
  assert.deepEqual(pairPersons(f).map(p => p.pid), [0]);
  assert.equal(pairState(pairPersons(f)), 'hidden');
});

test('pairState: 箱が横に重なっていれば overlap、離れていれば apart', () => {
  const a: TrackPerson = { pid: 0, bbox: [0.1, 0.2, 0.4, 0.8] };
  assert.equal(pairState([a, { pid: 1, bbox: [0.25, 0.2, 0.55, 0.8] }]), 'overlap');
  assert.equal(pairState([a, { pid: 1, bbox: [0.5, 0.2, 0.8, 0.8] }]), 'apart');
  assert.equal(pairState([]), 'none');
});

test('facingOf: 鼻・目の信頼度で顔が見えるか', () => {
  assert.equal(facingOf(frontPerson(0, 0.3)), 'face');
  assert.equal(facingOf(backPerson(0, 0.3)), 'back');
});

test('handOfWrist: 顔が見える人は画面の左の手=右手、背中向きは画面の左の手=左手', () => {
  const front = frontPerson(0, 0.5, { l: [0.62, 0.55], r: [0.38, 0.55] }); // 画面の左(0.38)にある手首
  assert.equal(handOfWrist(front, 10), '右手');
  assert.equal(handOfWrist(front, 9), '左手');
  const back = backPerson(0, 0.5, { l: [0.38, 0.55], r: [0.62, 0.55] });
  assert.equal(handOfWrist(back, 9), '左手');
  assert.equal(handOfWrist(back, 10), '右手');
});

test('handOfWrist: 顔が決まらないときは肩の並びで補う。それも無ければ null', () => {
  const p = backPerson(0, 0.5);
  p.kps![0] = [0.5, 0.28, 0.4]; // 鼻が中途半端 → unclear
  assert.equal(facingOf(p), 'unclear');
  assert.equal(handOfWrist(p, 9), '左手'); // 左肩が画面の左 = 背中向き
  p.kps![5] = [0.5, 0.4, 0.95]; p.kps![6] = [0.505, 0.4, 0.95]; // 肩が重なって並びが読めない
  assert.equal(handOfWrist(p, 9), null);
});

test('raisedHands / wristsNearHead / closestWristPair', () => {
  const up = frontPerson(0, 0.3, { r: [0.25, 0.1] }); // 右の手首が頭（y=0.27）より上
  assert.deepEqual(raisedHands(up), ['右手']);
  const partner = backPerson(1, 0.6);
  const reach = frontPerson(0, 0.3, { l: [0.58, 0.3] }); // 相手の頭付近
  const near = wristsNearHead(reach, partner, 0.5625);
  assert.equal(near.length, 1);
  assert.equal(near[0].hand, '左手');
  // つないだ手: 2人の手首が同じ場所
  const a = frontPerson(0, 0.3, { r: [0.45, 0.55] });
  const b = backPerson(1, 0.6, { l: [0.45, 0.55] });
  const c = closestWristPair(a, b, 0.5625)!;
  assert.ok(c.dist < 0.05);
  assert.equal(c.handA, '左手'); // 顔が見える人の、体の画面右側にある手
  assert.equal(c.handB, '左手'); // 背中向きの人の画面左の手
});

test('toIntervals: 隙間以内の時刻をまとめる', () => {
  assert.deepEqual(toIntervals([0, 0.1, 0.2, 1.0, 1.1], 0.25), [[0, 0.2], [1.0, 1.1]]);
});

test('cardsIn: 区間にかかるカードと前後の技名', () => {
  const result = { routine: { bpm: 120, moves: [
    { start: 0, counts: 8, name: 'A' }, { start: 4, counts: 8, name: 'B' }, { start: 8, counts: 8, name: 'C' },
  ] } };
  const c = cardsIn(result, 4.5, 5);
  assert.deepEqual(c.cards.map(x => x.name), ['B']);
  assert.equal(c.prev, 'A');
  assert.equal(c.next, 'C');
});

function frames(): TrackFrame[] {
  const out: TrackFrame[] = [];
  for (let i = 0; i < 40; i++) {
    const t = i * 0.1;
    if (t < 1.0) {
      // 冒頭: 手前の人だけ（奥の別人は背が低い）= 片方が隠れている
      out.push({ t, kept: [backPerson(0, 0.3), { pid: 1, bbox: [0.7, 0.3, 0.8, 0.5] }] });
    } else {
      // 後半: 2人が分かれて、手首同士が近い（つないだ手）
      out.push({ t, kept: [frontPerson(0, 0.3, { r: [0.45, 0.55] }), backPerson(1, 0.6, { l: [0.45, 0.55] })] });
    }
  }
  return out;
}

test('buildSegmentDigest: 隠れ区間・hold の信頼度・つないだ手・今のカードを出す', () => {
  const d = buildSegmentDigest({
    tracks: {
      frames: frames(),
      holdTimeline: [{ from: 0.2, to: 0.8, hold: 'リーダー左手×フォロワー右手' }, { from: 2, to: 3, hold: 'リーダー右手×フォロワー右手' }],
      events: [{ t: 0.5, type: 'Turn', by: 'leader', rotations: 1, spin: { runs: [{ dir: 'right', turns: 0.5 }], from: 0.2, to: 0.8 } }],
    },
    result: { events: [{ t: 0.5, type: 'Turn', verdict: 'doubtful' }], routine: { bpm: 120, moves: [{ start: 0, counts: 8, name: 'ベーシック', leadHand: 'L' }] } },
    from: 0, to: 1.5, aspect: 0.5625, cuts: [0.7, 9],
  });
  assert.equal(d.occludedSpans.length, 1);
  assert.match(d.occludedSpans[0], /隠れている/);
  assert.equal(d.holds.inSegment.length, 1);
  assert.equal((d.holds.inSegment[0] as { 信頼度: string }).信頼度, 'low');
  assert.equal((d.holds.after as { 信頼度?: string }).信頼度, 'normal');
  assert.deepEqual(d.cuts, [0.7]); // 区間外のカットは落とす
  // 重なり中の Turn は「回った人は当てにならない」、向きは残る
  assert.match(String(d.turns[0].回った人), /当てにならない/);
  assert.match(String(d.turns[0].向き), /右回り/);
  assert.equal(d.turns[0].信頼, 'doubtful');
  assert.equal(d.turns[0].回転数, null); // 重なり中の回転数（CV は 1 と数えた）は出さない
  // つないだ手は向きのルールで右手/左手に直る（顔が見える人の体の画面右側の手=左手、背中向きの画面左の手=左手）
  assert.ok(d.jointHands.some(s => s.includes('画面左の人の左手×画面右の人の左手')));
  assert.equal(d.currentCards[0].name, 'ベーシック');
  assert.ok(d.timeline[0].includes('片方が隠れている'));
});

test('buildSegmentDigest: drop で hold と今のカードの手を落とせる（実験用）', () => {
  const d = buildSegmentDigest({
    tracks: { frames: frames(), holdTimeline: [{ from: 2, to: 3, hold: 'x' }] },
    result: { routine: { bpm: 120, moves: [{ start: 0, counts: 8, name: 'A', leadHand: 'L' }] } },
    from: 0, to: 1.5, drop: ['holds', 'cardHands'],
  });
  assert.equal(d.holds.after, null);
  assert.equal('leadHand' in d.currentCards[0], false);
});

test('正解らしき語を入れない: digest にもプロンプトにも「男性右手×女性右手」等の答えは出ない', () => {
  const d = buildSegmentDigest({ tracks: { frames: frames() }, from: 0, to: 1.5 });
  const p = buildSegmentPrompt(d, { handRules: 'ルール', images: [{ file: 'a.jpg', note: 'n' }] });
  assert.ok(!/男性右手×女性右手/.test(JSON.stringify(d) + p.replace(/男性◯手×女性◯手/g, '')));
});

test('extractHandRules: 手のつなぎ〜回転数の直前までを抜く', () => {
  const md = ['# x', '   - 手のつなぎは必ず「男性◯手×女性◯手」の形で。', '   - どちらの手かは向きから決める', '   - 回る向きは本人の右/左', '   - 回転数は「1回」', '   - 補足には'].join('\n');
  const r = extractHandRules(md);
  assert.ok(r.includes('手のつなぎは必ず') && r.includes('回る向きは'));
  assert.ok(!r.includes('回転数は') && !r.includes('補足には'));
  assert.equal(extractHandRules('なし'), '');
});

test('parseSegmentAnswer: 前後に説明があっても {"rows":[...]} を拾う', () => {
  const a = parseSegmentAnswer('答え:\n```json\n{"rows":[{"start":0,"name":"A","hands":"B","description":"C"}],"basis":"根拠"}\n```');
  assert.equal(a?.rows.length, 1);
  assert.equal(a?.basis, '根拠');
  assert.equal(parseSegmentAnswer('壊れた'), null);
  assert.equal(parseSegmentAnswer('{"x":1}'), null);
});

test('applySegmentRows: 区間内のカードだけ置き換え、元の result は変えない', () => {
  const result = { leader: 'x', routine: { moves: [{ start: 0, name: 'A' }, { start: 5, name: 'B' }, { start: 9, name: 'C' }] } };
  const before = JSON.stringify(result);
  const out = applySegmentRows(result, 4, 8, [{ start: 5.2, name: 'N', hands: 'H', description: 'D' }]) as typeof result;
  assert.deepEqual(out.routine.moves.map(m => m.name), ['A', 'N', 'C']);
  assert.equal(out.leader, 'x');
  assert.equal(JSON.stringify(result), before);
});
