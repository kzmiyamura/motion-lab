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
}

export const PRESETS: Record<string, PresetDef> = {
  'salsa-pair': {
    name: 'salsa-pair',
    cvSteps: [
      { script: 'analyze_pair.py', args: ctx => [ctx.videoPath, ctx.modelPath, ctx.measurementsPath] },
    ],
    useClaude: false, // P2 で true に切り替え
  },
};
