import { useId } from 'react';
import type { MoveDiagramData } from '../engine/choreoSheet';
import { fmtRotations } from '../engine/choreoSheet';
import styles from './ChoreoSheet.module.css';

/**
 * 技1つの「上から見た図」（SVG・依存なし）。下がカメラ側なので、図の左右は動画の左右と同じ。
 * - 男（青）・女（ピンク）の始まりの位置。女性が反対側へ抜ける技は、女性の通り道を矢印で描き、
 *   男の体から見て通った側（左/右）へふくらませる。男は始まる前に女性の方を向いている前提
 *   （analyze_pair.detect_pass_side と同じ）なので、女性が右にいれば男の左 = 図の上（奥）
 * - 回転は、回る人の周りの円弧の矢印。上から見た図なので、右回り（回る人自身の右へ）は図でも時計回り
 * - 片手でつないでいれば2人の間の点線と「男左×女右」
 */

const W = 220, H = 128, Y = 64, R = 13;
const SLOT = { left: 78, right: 142 } as const;
const OUTER = { left: 30, right: 190 } as const;
const BLUE = '#0066ff', PINK = '#d1009f';
const HAND = { L: '左', R: '右' } as const;

function other(s: 'left' | 'right'): 'left' | 'right' {
  return s === 'left' ? 'right' : 'left';
}

/** 回転の円弧（290°）。時計回りなら SVG の角度が増える向き（sweep=1） */
function arcPath(cx: number, cy: number, r: number, clockwise: boolean): string {
  const a0 = (-70 * Math.PI) / 180;
  const a1 = a0 + ((clockwise ? 290 : -290) * Math.PI) / 180;
  const p = (a: number) => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  return `M ${p(a0)} A ${r} ${r} 0 1 ${clockwise ? 1 : 0} ${p(a1)}`;
}

function Person({ x, label, color, ghost }: { x: number; label: string; color: string; ghost?: boolean }) {
  return (
    <g>
      <circle cx={x} cy={Y} r={R} fill={ghost ? 'none' : color} stroke={color} strokeWidth={2}
        strokeDasharray={ghost ? '3 2' : undefined} />
      <text x={x} y={Y + 4.5} textAnchor="middle" fontSize={13} fontWeight={800} fill={ghost ? color : '#fff'}>{label}</text>
    </g>
  );
}

export function MoveDiagram({ data }: { data: MoveDiagramData }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const pinkHead = `mdp${uid}`, blueHead = `mdb${uid}`;
  const passes = data.pass === 'left' || data.pass === 'right'
    || (!!data.followerStart && !!data.followerEnd && data.followerStart !== data.followerEnd);
  // 立ち位置が分からなければ 女＝右 で描く（パスがあれば終わりは反対側）
  const ws = data.followerStart ?? (data.followerEnd && passes ? other(data.followerEnd) : 'right');
  const we = passes ? other(ws) : ws;
  const ms = other(ws);
  const wx = SLOT[ws], mx = SLOT[ms];
  const endX = passes ? OUTER[we] : wx;

  // 通り道のふくらみ: 男は女の方を向いている。女が右（E）なら男の左は奥（図の上）
  const hx = wx > mx ? 1 : -1;
  const bulge = data.pass === 'right' ? hx : -hx;          // +1 = 図の下（カメラ側）
  const passKnown = data.pass === 'left' || data.pass === 'right';
  const cy = Y + bulge * 40;

  const turn = data.turn;
  const turner = turn && turn.by === 'leader' ? { x: mx, color: BLUE, head: blueHead } : turn ? { x: endX, color: PINK, head: pinkHead } : null;
  const rot = turn?.rotations ? `×${fmtRotations(turn.rotations)}` : '';
  const dirWord = turn?.direction === 'right' ? '右回り' : turn?.direction === 'left' ? '左回り' : '回る';
  const kindWord = turn?.kind === 'inside' ? 'インサイド' : turn?.kind === 'outside' ? 'アウトサイド' : '';

  return (
    <figure className={styles.diagram} data-testid="move-diagram">
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.diagramSvg} aria-hidden="true" focusable="false">
        <defs>
          <marker id={pinkHead} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={PINK} />
          </marker>
          <marker id={blueHead} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={BLUE} />
          </marker>
        </defs>
        <text x={4} y={H - 3} fontSize={9} fill="currentColor" opacity={0.7}>上から見た図</text>
        <text x={W - 4} y={H - 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.7}>▼ カメラ側</text>

        {data.hold && (
          <g>
            <line x1={mx} y1={Y} x2={wx} y2={Y} stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 3" opacity={0.6} />
            <text x={(mx + wx) / 2} y={Y - 6} textAnchor="middle" fontSize={9} fill="currentColor">
              男{HAND[data.hold[0] as 'L' | 'R']}×女{HAND[data.hold[1] as 'L' | 'R']}
            </text>
          </g>
        )}

        {passes && (
          <g>
            <path d={`M ${wx} ${Y + bulge * (R - 2)} Q ${mx} ${cy} ${endX + (we === 'left' ? 4 : -4)} ${Y + bulge * 6}`}
              fill="none" stroke={PINK} strokeWidth={2.2} strokeDasharray={passKnown ? undefined : '5 3'}
              markerEnd={`url(#${pinkHead})`} />
            <text x={mx} y={cy + (bulge > 0 ? 12 : -4)} textAnchor="middle" fontSize={9} fill={PINK}>
              {passKnown ? `男の${data.pass === 'left' ? '左' : '右'}側を通る` : '反対側へ'}
            </text>
            <Person x={endX} label="女" color={PINK} ghost />
          </g>
        )}

        <Person x={mx} label="男" color={BLUE} />
        <Person x={wx} label="女" color={PINK} />

        {turner && (
          <g>
            {turn!.direction
              ? <path d={arcPath(turner.x, Y, R + 7, turn!.direction === 'right')} fill="none" stroke={turner.color}
                  strokeWidth={2} markerEnd={`url(#${turner.head})`} />
              : <circle cx={turner.x} cy={Y} r={R + 7} fill="none" stroke={turner.color} strokeWidth={1.5} strokeDasharray="3 3" />}
            <text x={turner.x < 60 ? 4 : turner.x > W - 60 ? W - 4 : turner.x} y={Y + R + 20}
              textAnchor={turner.x < 60 ? 'start' : turner.x > W - 60 ? 'end' : 'middle'}
              fontSize={9.5} fontWeight={700} fill={turner.color}>
              {kindWord ? `${kindWord}（${dirWord}）${rot}` : `${dirWord}${rot}`}
            </text>
          </g>
        )}
      </svg>
      {data.caption && <figcaption className={styles.diagramCaption}>{data.caption}</figcaption>}
    </figure>
  );
}
