/**
 * digest.json — Claude に渡す計測の要約。
 *
 * out/measurements.json は persons[]（全フレーム）が大半（180KB 級 ≒ 6 万トークン）で、Claude が毎回
 * 読み直す文脈になっていた。Claude が自前で書いていた要約スクリプト（summ.py）の中身を
 * サーバー側で先に作り、数 KB〜数十 KB にまとめて渡す。数値は measurements.json の値をそのまま写す
 * （丸め・加工をしない。出力の質を変えないため）。persons[] と、重複する内部用フィールド
 * （spinCoarse / span / tMid）だけを落とす。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildHandRegions, buildSegmentDigest, describeLeadIn, type Tracks } from './segmentDigest.js';

type Json = Record<string, unknown>;

export interface DigestEnv {
  /** プロンプトに渡す Python の実パス（探させない） */
  pythonBin: string;
}

/** キーフレーム 1 枚 */
export interface DigestKeyframe {
  file: string;
  t: number;
  kind: 'turn' | 'cbl' | 'contested' | 'other';
  /** 21 コマを超える場面の続き（_strip_2.jpg 以降）なら 2 以降 */
  part: number;
  /** 手のつなぎ・腕の形を読む詳細画像（_detail.jpg）なら true */
  detail?: boolean;
}

/** out/keyframes の「<秒>_<種別>[_strip[_n]].jpg」を読む。読めないものは null */
export function parseKeyframeName(file: string): DigestKeyframe | null {
  const m = /^(\d+(?:\.\d+)?)_([a-z]+)(?:_strip(?:_(\d+))?|(_detail))?\.jpg$/i.exec(file);
  if (!m) return null;
  const kind = m[2] === 'turn' || m[2] === 'cbl' || m[2] === 'contested' ? m[2] : 'other';
  const base: DigestKeyframe = { file, t: Number(m[1]), kind, part: m[3] ? Number(m[3]) : 1 };
  return m[4] ? { ...base, detail: true } : base;
}

const DROP_EVENT_KEYS = new Set(['spinCoarse', 'span', 'tMid']);

export function listKeyframes(keyframesDir: string): DigestKeyframe[] {
  if (!existsSync(keyframesDir)) return [];
  return readdirSync(keyframesDir)
    .map(parseKeyframeName)
    .filter((k): k is DigestKeyframe => k !== null)
    .sort((a, b) => a.t - b.t || a.part - b.part);
}

export function mmss(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** 技 1 つ（カード）が使える窓の長さの上限（次の技までが長いとき）。8 カウント ≒ 3〜4 秒 */
const HAND_HINT_MAX_SEC = 4.0;

export interface HandHints {
  /** 重なり・片方が隠れる区間（この間の手の計測は当てにならない） */
  occluded: string[];
  /** つないだ手の候補（手首同士が近い組。区間のあと 2.5 秒まで。向きのルールで右手/左手に直してある） */
  jointHands: string[];
  /** 相手の頭の近くにある手首（頭に手をかける動きの候補）と、頭より上に上がった手 */
  headHand: string[];
}

/**
 * handHints の文は同じ言い回しの繰り返しで digest の半分以上を占める（820f0461 で 40.6k 文字のうち 21.5k）。
 * 値（時刻・手の組・あとの区間か・重なりの注意）は変えずに、(1) 間が 0.3 秒以内の同じ手・同じ相手の区間を 1 つにし、
 * (2) 同じ手・同じ相手の区間を「中身: 区間, 区間」と 1 行にまとめ、(3) 言い回しを短くして凡例（HAND_HINTS_KEY）に書く。
 * expandHandHints は圧縮の逆変換（テストと照合ツール用。元の「from〜to 秒 中身」の文に戻す）
 */
export const HAND_HINTS_KEY =
  'handHints の書き方: 「中身: 区間, 区間」（区間は from〜to の秒。1 つの時刻だけなら数字 1 つ）。' +
  '「左人」=画面左の人・「右人」=画面右の人・「1人」=見えている1人・「(後)」=この技の窓のあとの区間・「※重」=2人が重なっていて当てにならない。' +
  'headHand の「…の頭が近い」は胴長 0.6 以内。同じ中身で間が 0.3 秒以内の区間は 1 つにまとめてある';
const HINT_ABBR: Array<[string, string]> = [
  ['画面左の人', '左人'],
  ['画面右の人', '右人'],
  ['見えている1人', '1人'],
  ['（胴長0.6以内）', ''],
  ['（2人が重なっていて当てにならない）', '※重'],
];
const HINT_RUN = /^(\d+(?:\.\d+)?)〜(\d+(?:\.\d+)?) 秒(\(区間のあと\))? (.*)$/;
const HINT_GROUP = /^(\(後\) )?(.*): ((?:\d+(?:\.\d+)?(?:〜\d+(?:\.\d+)?)?)(?:, \d+(?:\.\d+)?(?:〜\d+(?:\.\d+)?)?)*)$/;
const HINT_MERGE_GAP = 0.3;

const abbr = (s: string) => HINT_ABBR.reduce((o, [from, to]) => o.split(from).join(to), s);
const unabbr = (s: string) => {
  let rest = s.split('※重').join('（2人が重なっていて当てにならない）');
  rest = rest.replace(/(^|[→×の])1人/g, '$1見えている1人').replace(/左人/g, '画面左の人').replace(/右人/g, '画面右の人');
  if (/の頭が近い$/.test(rest)) rest += '（胴長0.6以内）';
  return rest;
};
const runText = (a: number, b: number) => (a === b ? `${a}` : `${a}〜${b}`);

/** 「from〜to 秒[(区間のあと)] 中身」の文の一覧 → 同じ中身ごとに間 gap 秒以内の区間をつなぎ「[(後) ]中身: 区間, 区間」にする。区間の形でない文はそのまま短くする */
export function compactHandHints(list: string[], gap = HINT_MERGE_GAP): string[] {
  const runs = new Map<string, Array<[number, number]>>();
  const other: string[] = [];
  for (const s of list) {
    const m = HINT_RUN.exec(s);
    if (!m) { other.push(abbr(s)); continue; }
    const key = `${m[3] ? '(後) ' : ''}${abbr(m[4])}`;
    if (!runs.has(key)) runs.set(key, []);
    runs.get(key)!.push([Number(m[1]), Number(m[2])]);
  }
  const groups: Array<{ at: number; text: string }> = [];
  for (const [key, rs] of runs) {
    rs.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of rs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] <= gap + 1e-9) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    const post = key.startsWith('(後) ');
    const rest = post ? key.slice('(後) '.length) : key;
    groups.push({ at: merged[0][0], text: `${post ? '(後) ' : ''}${rest}: ${merged.map(([a, b]) => runText(a, b)).join(', ')}` });
  }
  return [...groups.sort((x, y) => x.at - y.at).map(g => g.text), ...other];
}

/** compactHandHints の逆。圧縮した 1 文 →「from〜to 秒[(区間のあと)] 中身」の文の一覧（つないだ区間はつないだまま） */
export function expandHandHints(s: string): string[] {
  const m = HINT_GROUP.exec(s);
  if (!m) return [unabbr(s)];
  return m[3].split(', ').map(r => {
    const [a, b] = r.includes('〜') ? r.split('〜') : [r, r];
    return `${a}〜${b} 秒${m[1] ? '(区間のあと)' : ''} ${unabbr(m[2])}`;
  });
}

/**
 * 技の窓（このイベントの少し前〜次のイベントまで）の手のヒント。区間再解析（segmentDigest）と同じ計算を本解析にも使う。
 * 「分かれて見える最初の時刻で決め、離す動きが見えなければさかのぼる」ために、重なる区間と区間のあとの jointHands を渡す。
 * tracks が無い・窓にコマが無いときは null
 */
export function buildHandHints(tracks: Tracks, events: Json[], index: number, aspect: number, compact = true): HandHints | null {
  const e = events[index];
  const t = Number(e.t);
  if (!Number.isFinite(t)) return null;
  const next = events.slice(index + 1).map(x => Number(x.t)).find(x => Number.isFinite(x) && x > t + 0.5);
  const from = Math.max(0, t - 0.5);
  const to = Math.min(next ?? t + HAND_HINT_MAX_SEC, t + HAND_HINT_MAX_SEC);
  const d = buildSegmentDigest({ tracks, from, to, aspect, summaryEvents: [], drop: ['holds', 'turns', 'cardHands'] });
  if (!d.occludedSpans.length && !d.jointHands.length && !d.handRaise.length && !d.wristNearHead.length) return null;
  const pack = (list: string[]) => (compact ? compactHandHints(list) : list);
  return {
    occluded: d.occludedSpans.map(s => s.replace(/。この間の手の計測・回る人の取り違えは当てにならない$/, '')),
    jointHands: pack(d.jointHands),
    headHand: pack([...d.wristNearHead, ...d.handRaise.filter(s => !s.startsWith('t='))]),
  };
}

export function buildDigest(measurements: Json, keyframes: DigestKeyframe[], env: DigestEnv, tracks?: Tracks | null, compactHints = true): Json {
  const summary = (measurements.summary ?? {}) as Json;
  const events = Array.isArray(summary.events) ? (summary.events as Json[]) : [];
  const contested = Array.isArray(summary.contested) ? (summary.contested as Json[]) : [];
  const aspect = typeof measurements.width === 'number' && typeof measurements.height === 'number' && measurements.height > 0
    ? measurements.width / measurements.height : 0.5625;

  const stripsOf = (type: string, t: number, detail = false): string[] =>
    keyframes
      .filter(k => k.kind === type.toLowerCase() && Math.abs(k.t - t) <= 0.06 && !!k.detail === detail)
      .map(k => k.file);

  const slim = events.map((e, i) => {
    const o: Json = {};
    for (const [k, v] of Object.entries(e)) if (!DROP_EVENT_KEYS.has(k)) o[k] = v;
    const t = Number(e.t);
    o.mmss = mmss(t);
    const strips = stripsOf(String(e.type), t);
    if (strips.length) o.strips = strips;
    const details = stripsOf(String(e.type), t, true);
    if (details.length) o.detail = details[0];
    if (tracks) {
      try {
        const hh = buildHandHints(tracks, events, i, aspect, compactHints);
        if (hh) o.handHints = hh;
      } catch (err) { console.warn(`[digest] handHints failed: ${(err as Error).message}`); }
    }
    return o;
  });

  const contestedOut = contested.map(c => ({
    ...c,
    frames: keyframes.filter(k => k.kind === 'contested' && k.t >= Number(c.from) - 0.06 && k.t <= Number(c.to) + 0.06).map(k => k.file),
  }));

  const counts = {
    events: events.length,
    turn: events.filter(e => e.type === 'Turn').length,
    cbl: events.filter(e => e.type === 'CBL').length,
    contested: contested.length,
    keyframes: keyframes.length,
  };

  return {
    about: 'measurements.json の要約。まずこれを読む。measurements.json 全体（persons[] = 全フレームの骨格）は読まなくてよい。',
    env: { pythonBin: env.pythonBin },
    video: {
      fps: measurements.fps, sampledFps: measurements.sampledFps,
      totalFrames: measurements.totalFrames, sampledFrames: measurements.sampledFrames,
      detector: measurements.detector, shrMode: measurements.shrMode,
    },
    counts,
    ...(tracks && compactHints ? { handHintsKey: HAND_HINTS_KEY } : {}),
    // 冒頭が重なり・隠れで手が読めないとき、冒頭からの手の推定（CV の決定的な計算。離す動きが見えるまで同じ手）。無ければ出さない
    ...(() => {
      if (!tracks) return {};
      try {
        const line = describeLeadIn(buildHandRegions(tracks, aspect), tracks.holdTimeline ?? []);
        return line ? { handLeadIn: line } : {};
      } catch (err) { console.warn(`[digest] handLeadIn failed: ${(err as Error).message}`); return {}; }
    })(),
    verdictByRule: summary.verdictByRule ?? null,
    // リーダーを何で決めたか: source=anchor（Claude の写真判定）/ cv-vote（CV 多数決。カメラに近い人に偏って逆になることがある）
    leaderDecision: summary.leaderDecision ?? null,
    reliability: summary.reliability ?? null,
    slot0: summary.slot0 ?? null,
    slot1: summary.slot1 ?? null,
    beatGrid: summary.beatGrid ?? null,
    beatGridReason: summary.beatGridReason ?? null,
    onBeat: summary.onBeat ?? null,
    contested: contestedOut,
    // 手のつなぎの全編タイムライン。estimated: [from, to] が付いた区間は、その秒の範囲の手が計測でなく前後からの推定
    holdTimeline: summary.holdTimeline ?? [],
    // 2人が重なる・片方が隠れる等で、手首から手のつなぎを読めない区間（この間の hold は信用しない）
    holdUnclear: summary.holdUnclear ?? [],
    events: slim,
    keyframes: keyframes.map(k => k.file),
  };
}

/** 1 イベント 1 行の JSON（インデント無しで小さく、読みやすさは行単位で保つ） */
export function stringifyDigest(d: Json): string {
  const lines: string[] = ['{'];
  const entries = Object.entries(d);
  entries.forEach(([k, v], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
      lines.push(`${JSON.stringify(k)}: [`);
      v.forEach((x, j) => lines.push(`  ${JSON.stringify(x)}${j < v.length - 1 ? ',' : ''}`));
      lines.push(`]${comma}`);
    } else {
      lines.push(`${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
    }
  });
  lines.push('}');
  return lines.join('\n') + '\n';
}

/**
 * out/measurements.json と out/keyframes から out/digest.json を書く（outDir の外は触らない）。
 * outputDir を省略すると outDir に書く。失敗したら null（呼び出し側は digest 無しで続ける）
 */
export function writeDigest(outDir: string, env: DigestEnv, outputDir: string = outDir): string | null {
  const mPath = path.join(outDir, 'measurements.json');
  if (!existsSync(mPath)) return null;
  try {
    const m = JSON.parse(readFileSync(mPath, 'utf-8')) as Json;
    const tPath = path.join(outDir, 'measurements.tracks.json');
    let tracks: Tracks | null = null;
    if (existsSync(tPath)) {
      try { tracks = JSON.parse(readFileSync(tPath, 'utf-8')) as Tracks; } catch { /* tracks が読めなければヒント無しで続ける */ }
    }
    const digest = buildDigest(m, listKeyframes(path.join(outDir, 'keyframes')), env, tracks);
    const dst = path.join(outputDir, 'digest.json');
    writeFileSync(dst, stringifyDigest(digest), 'utf-8');
    return dst;
  } catch (e) {
    console.warn(`[digest] failed: ${(e as Error).message}`);
    return null;
  }
}
