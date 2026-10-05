// 汎用解析（preset: general）の result.json {summary, findings: [{t, title, detail}], limitations} を読む純粋関数
export type GeneralFinding = { t: number | null; title: string; detail: string };
export type GeneralResult = { summary: string; findings: GeneralFinding[]; limitations: string };
export type StillImage = { t: number; file: string };

function safeParse(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 振付シート（routine）を持たない general のジョブか。preset が general、または routine が無く findings がある */
export function isGeneralJob(preset: string | null | undefined, resultJson: string | null | undefined): boolean {
  if (preset === 'general') return true;
  if (preset === 'salsa-pair') return false;
  const r = safeParse(resultJson);
  return !!r && !r.routine && Array.isArray(r.findings);
}

export function parseGeneralResult(json: string | null | undefined): GeneralResult | null {
  const r = safeParse(json);
  if (!r) return null;
  const findings: GeneralFinding[] = [];
  if (Array.isArray(r.findings)) {
    for (const f of r.findings) {
      if (!f || typeof f !== 'object') continue;
      const o = f as Record<string, unknown>;
      const t = typeof o.t === 'number' && Number.isFinite(o.t) ? o.t : null;
      const title = typeof o.title === 'string' ? o.title : '';
      const detail = typeof o.detail === 'string' ? o.detail : '';
      if (title || detail) findings.push({ t, title, detail });
    }
  }
  return {
    summary: typeof r.summary === 'string' ? r.summary : '',
    findings,
    limitations: typeof r.limitations === 'string' ? r.limitations : '',
  };
}

/** measurements.json から単独の静止画（時刻つき）を取り出す。imageIndex（single）優先、古いジョブは keyframes */
export function stillImagesFrom(measurements: unknown): StillImage[] {
  const s = (measurements as { summary?: Record<string, unknown> } | null)?.summary;
  if (!s) return [];
  const out: StillImage[] = [];
  if (Array.isArray(s.imageIndex)) {
    for (const e of s.imageIndex) {
      const o = e as { file?: unknown; kind?: unknown; times?: unknown };
      if (o?.kind === 'single' && typeof o.file === 'string' && Array.isArray(o.times) && typeof o.times[0] === 'number') {
        out.push({ t: o.times[0], file: o.file });
      }
    }
  } else if (Array.isArray(s.keyframes)) {
    for (const k of s.keyframes) {
      const o = k as { file?: unknown; t?: unknown };
      if (typeof o?.file === 'string' && typeof o.t === 'number') out.push({ t: o.t, file: o.file });
    }
  }
  return out;
}

/** t に一番近い静止画（maxGap 秒以内）。無ければ null */
export function nearestStill(images: StillImage[], t: number | null, maxGap = 1.5): StillImage | null {
  if (t === null) return null;
  let best: StillImage | null = null;
  for (const im of images) {
    if (!best || Math.abs(im.t - t) < Math.abs(best.t - t)) best = im;
  }
  return best && Math.abs(best.t - t) <= maxGap ? best : null;
}

export function formatClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
