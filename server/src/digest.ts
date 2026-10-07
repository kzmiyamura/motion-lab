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
import { buildSegmentDigest, type Tracks } from './segmentDigest.js';

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

function listKeyframes(keyframesDir: string): DigestKeyframe[] {
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
 * 技の窓（このイベントの少し前〜次のイベントまで）の手のヒント。区間再解析（segmentDigest）と同じ計算を本解析にも使う。
 * 「分かれて見える最初の時刻で決め、離す動きが見えなければさかのぼる」ために、重なる区間と区間のあとの jointHands を渡す。
 * tracks が無い・窓にコマが無いときは null
 */
export function buildHandHints(tracks: Tracks, events: Json[], index: number, aspect: number): HandHints | null {
  const e = events[index];
  const t = Number(e.t);
  if (!Number.isFinite(t)) return null;
  const next = events.slice(index + 1).map(x => Number(x.t)).find(x => Number.isFinite(x) && x > t + 0.5);
  const from = Math.max(0, t - 0.5);
  const to = Math.min(next ?? t + HAND_HINT_MAX_SEC, t + HAND_HINT_MAX_SEC);
  const d = buildSegmentDigest({ tracks, from, to, aspect, summaryEvents: [], drop: ['holds', 'turns', 'cardHands'] });
  if (!d.occludedSpans.length && !d.jointHands.length && !d.handRaise.length && !d.wristNearHead.length) return null;
  return {
    occluded: d.occludedSpans.map(s => s.replace(/。この間の手の計測・回る人の取り違えは当てにならない$/, '')),
    jointHands: d.jointHands,
    headHand: [...d.wristNearHead, ...d.handRaise.filter(s => !s.startsWith('t='))],
  };
}

export function buildDigest(measurements: Json, keyframes: DigestKeyframe[], env: DigestEnv, tracks?: Tracks | null): Json {
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
        const hh = buildHandHints(tracks, events, i, aspect);
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
