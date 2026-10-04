import type { ReactNode } from 'react';
import type { RoutineHold } from '../engine/routineClip';
import {
  clockHour, HOLD_SHORT, POSITION_WORD,
  type CardState, type ContinuityWarning, type PairState, type PartChip, type Prov,
} from '../engine/sheetState';
import styles from './StateStrip.module.css';

/**
 * カードの「始 → 終」の状態の帯（engine/sheetState.ts）。文字は最小限にして、
 * 向きは小さな時計（12 時 = ルーティンの頭で男が向いていた向き。青 = 男・ピンク = 女の向く方向）、
 * 手は小さな記号＋「男左手×女右手」、見えたものは実線のチップ・推定は点線のチップに「推定」。
 */

const BLUE = '#0066ff', PINK = '#d1009f';

/** 向きの時計（直径 18px）。向きが分からない人は線を描かない */
export function FacingClock({ leader, follower }: { leader: number | null; follower: number | null }) {
  const hand = (deg: number, color: string, len: number) => {
    const a = (deg * Math.PI) / 180;
    const x = Math.sin(a) * len, y = -Math.cos(a) * len;
    return (
      <g>
        <line x1={0} y1={0} x2={x.toFixed(2)} y2={y.toFixed(2)} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r={1.6} fill={color} />
      </g>
    );
  };
  return (
    <svg viewBox="-10 -10 20 20" className={styles.clock} aria-hidden="true" focusable="false">
      <circle r={9} fill="none" stroke="currentColor" strokeWidth={1} opacity={0.5} />
      <line x1={0} y1={-9} x2={0} y2={-6.5} stroke="currentColor" strokeWidth={1.4} />
      {leader !== null && hand(leader, BLUE, 7)}
      {follower !== null && hand(follower, PINK, 5.5)}
    </svg>
  );
}

/** つなぎの記号: 青（男）とピンク（女）の点を、片手 = 1 本・両手 = 2 本・クロス = ×・クローズド = 弧で結ぶ */
export function HoldIcon({ hold }: { hold: RoutineHold }) {
  const link = (() => {
    switch (hold) {
      case 'double': return <><line x1={4} y1={3} x2={14} y2={3} /><line x1={4} y1={7} x2={14} y2={7} /></>;
      case 'cross': return <><line x1={4} y1={2} x2={14} y2={8} /><line x1={4} y1={8} x2={14} y2={2} /></>;
      case 'closed': return <path d="M4 5 Q9 -1 14 5 Q9 11 4 5" fill="none" />;
      case 'none': return null;
      default: return <line x1={4} y1={5} x2={14} y2={5} />;
    }
  })();
  return (
    <svg viewBox="0 0 18 10" className={styles.holdIcon} aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth={1.3}>{link}</g>
      <circle cx={3} cy={5} r={2.4} fill={BLUE} />
      <circle cx={15} cy={5} r={2.4} fill={PINK} />
    </svg>
  );
}

function Chip({ prov, children, title }: { prov: Prov | null; children: ReactNode; title?: string }) {
  const inferred = prov === 'inferred';
  return (
    <span className={`${styles.chip} ${inferred ? styles.inferred : styles.seen}`} title={title}
      data-prov={prov ?? 'unknown'}>
      {children}
      {inferred && <span className={styles.suffix}>推定</span>}
    </span>
  );
}

function StateLine({ tag, s, slot }: { tag: string; s: PairState; slot?: { word: string; prov: Prov | null } | null }) {
  const lh = clockHour(s.leaderFacing), fh = clockHour(s.followerFacing);
  return (
    <div className={styles.line} data-testid={`state-${tag === '始' ? 'start' : 'end'}`}>
      <span className={styles.tag}>{tag}</span>
      <span className={styles.facing} title="向き（12時 = 最初に男が向いていた向き）">
        <FacingClock leader={s.leaderFacing} follower={s.followerFacing} />
        <span><b className={styles.m}>男</b>{lh ?? '?'}</span>
        <span><b className={styles.f}>女</b>{fh ?? '?'}</span>
      </span>
      <span className={styles.pos} title="女性の位置（男から見て）">{s.position ? POSITION_WORD[s.position] : '位置?'}</span>
      {s.hold && (
        <Chip prov={s.holdProv} title="つないでいる手">
          <HoldIcon hold={s.hold} />{HOLD_SHORT[s.hold]}
        </Chip>
      )}
      {slot && <Chip prov={slot.prov} title="スロットの端（この技の始まりと比べて）">{slot.word}</Chip>}
    </div>
  );
}

/** カードの状態の帯: 始まり・終わりの 2 行と、部品（通過・回る向き・回転数）の見えた/推定 */
export function StateStrip({ state }: { state: CardState }) {
  const slot = state.slotEnd ? { word: state.slotEnd === 'opposite' ? '反対の端' : '同じ端', prov: state.slotProv } : null;
  return (
    <div className={styles.strip} data-testid="state-strip">
      <StateLine tag="始" s={state.start} />
      <StateLine tag="終" s={state.end} slot={slot} />
      {state.parts.length > 0 && (
        <div className={styles.parts}>
          {state.parts.map((p: PartChip, i) => <Chip key={i} prov={p.prov}>{p.label}</Chip>)}
        </div>
      )}
    </div>
  );
}

/** 前のカードの終わりとこのカードの始まりの食い違い（カードの境目に小さく ⚠） */
export function ContinuityMark({ warnings }: { warnings: ContinuityWarning[] }) {
  if (warnings.length === 0) return null;
  const detail = warnings.map(w => w.detail).join('\n');
  return (
    <p className={styles.gap} title={detail} aria-label={`前の技とのつながりが合わない: ${detail}`} data-testid="continuity-warning">
      ⚠ {warnings.map(w => w.label).join('・')}
    </p>
  );
}
