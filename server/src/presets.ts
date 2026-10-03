/**
 * preset レジストリ — 指示書 frontmatter の preset 名から CVスクリプト構成を決める。
 * docs/folder-analysis-detailed-design.md §3 参照
 *
 * P0 時点では cvSteps は空・useClaude:false のダミー（配管の疎通確認用）。
 * P1 で analyze_pair.py を配線し、P2 で useClaude:true に切り替える。
 */

export interface JobContext {
  jobId: string;
  videoPath: string;
  modelPath: string;
  jobDir: string;
  measurementsPath: string;
  /** ROIマスク可視化のデバッグ動画（mp4v生出力。jobWorkerがH.264へ変換して配信） */
  debugVideoRawPath: string;
  /** 骨格人形だけで踊りを再現した動画（mp4v生出力。同上） */
  skeletonVideoRawPath: string;
  /** Claude アンカーが判定したリーダー位置（例: "right@5.00"）。null なら CV 単独判定 */
  leaderHint: string | null;
}

export interface PresetDef {
  name: string;
  /** CVパス: 順に実行するPythonスクリプト（analysis/ からの相対パス）と引数 */
  cvSteps: {
    script: string;
    args: (ctx: JobContext) => string[];
  }[];
  /** false の間は CV 結果だけで done にする（Claude はスキップ） */
  useClaude: boolean;
  /** Claude が On1/On2 を決めなかったとき（unclear・無し）の数え方。normalize_routine.py に渡す */
  defaultOnBeat?: 'on1' | 'on2';
}

export const PRESETS: Record<string, PresetDef> = {
  'salsa-pair': {
    name: 'salsa-pair',
    cvSteps: [
      { script: 'analyze_pair.py', args: ctx => [
        ctx.videoPath, ctx.modelPath, ctx.measurementsPath, ctx.debugVideoRawPath, ctx.skeletonVideoRawPath,
        ...(ctx.leaderHint ? [`--leader-hint=${ctx.leaderHint}`] : []),
      ] },
    ],
    useClaude: true, // P2: claude CLI 未導入の環境では [CLAUDE] エラーになる（server/CLAUDE.md その7参照）
    // ユーザーが上げるサルサ動画は基本 On2（2026-10-03「on2動画しか上げない」）
    defaultOnBeat: 'on2',
  },
};
