/**
 * preset レジストリ — 指示書 frontmatter の preset 名から CVスクリプト構成を決める。
 * docs/folder-analysis-detailed-design.md §3 参照
 *
 * P0 時点では cvSteps は空・useClaude:false のダミー（配管の疎通確認用）。
 * P1 で analyze_pair.py を配線し、P2 で useClaude:true に切り替える。
 */
import path from 'node:path';

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

/**
 * jobWorker の段階ごとの ON/OFF。preset ごとに「どの段階を使うか」を選ぶ（server/CLAUDE.md その7〜その11 の段階）。
 * salsa-pair は全部 true（従来どおりの順番・引数）。general は種目を問わない計測だけ。
 */
export interface PresetStages {
  /** CV 前に Claude へ静止画を見せてリーダー左右を聞く（runClaudeAnchor）。useClaude && cvSteps があるときのみ */
  leaderAnchor: boolean;
  /** CBL・ターンの前後だけ高fpsで取り直す（refine_events.py。analyze_pair.py が前提） */
  refineEvents: boolean;
  /** ターンの向き・回転数を Claude に判定させる（judgeTurns。analyze_pair.py が前提） */
  turnJudge: boolean;
  /** 音声 → analyze_beats.py（拍・BPM） */
  beats: boolean;
  /** analyze_onbeat.py（On1/On2 材料。tracks.json 前提。beats が true のときだけ意味がある） */
  onBeat: boolean;
  /** contested 区間のキーフレーム */
  contestedFrames: boolean;
  /** 技イベントごとの一覧画像（make_strips.py） */
  eventStrips: boolean;
  /** デバッグ動画・骨格人形動画の H.264 変換 */
  debugVideos: boolean;
  /** Claude 後: normalize_routine.py（振付シート化） */
  normalizeRoutine: boolean;
  /** Claude 後: make_move_frames.py */
  moveFrames: boolean;
  /** Claude 後: make_report_frames.py（レポートの場面画像） */
  sceneFrames: boolean;
}

export interface PresetDef {
  name: string;
  /** 段階の ON/OFF */
  stages: PresetStages;
  /** Claude に渡す固定プロンプト（prompts/ のファイル名）。省略時は runner-prompt.md */
  promptFile?: string;
  /** true なら Claude の作業ディレクトリへサルサ用の技辞典（knowledge/）を写す */
  copySalsaKnowledge: boolean;
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
    stages: {
      leaderAnchor: true, refineEvents: true, turnJudge: true, beats: true, onBeat: true,
      contestedFrames: true, eventStrips: true, debugVideos: true,
      normalizeRoutine: true, moveFrames: true, sceneFrames: true,
    },
    copySalsaKnowledge: true,
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
  // 種目を問わない汎用 preset。指示書（spec.md）が「何を見てどう書くか」の唯一の指示。
  // CV は骨格の時系列・動きの大きさ・キーフレームだけ（analyze_general.py）。音声があれば拍も使う
  general: {
    name: 'general',
    stages: {
      leaderAnchor: false, refineEvents: false, turnJudge: false, beats: true, onBeat: false,
      contestedFrames: false, eventStrips: false, debugVideos: false,
      normalizeRoutine: false, moveFrames: false, sceneFrames: false,
    },
    promptFile: 'general-prompt.md',
    copySalsaKnowledge: false,
    cvSteps: [
      { script: 'analyze_general.py', args: ctx => [
        ctx.videoPath, ctx.modelPath, ctx.measurementsPath, path.join(ctx.jobDir, 'out', 'keyframes'),
      ] },
    ],
    useClaude: true,
  },
};
