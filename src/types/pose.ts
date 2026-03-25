/** MediaPipe 生ランドマーク（計算処理なし） */
export interface RawLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;  // NormalizedLandmark との互換性のため optional
}

/** 1フレーム分の生ポーズデータ */
export interface RawPoseFrame {
  t: number;          // video.currentTime (秒)
  frameIdx: number;   // 連番インデックス
  poses: Array<{
    landmarks: RawLandmark[];  // MediaPipe 33点
  }>;
}

/** ロガーが書き出す JSON のルート */
export interface RawPoseLog {
  version: 'salsa_raw_v2';
  datetime: string;
  videoName: string;
  samplingMs: number;
  frames: RawPoseFrame[];
}

/** アノテーションラベル */
export type AnnotationLabel =
  | 'ok'                    // 現判定が正しい
  | 'swap'                  // スロット0/1が逆転している
  | 'single'                // 1人のみ（もう1人は画外）
  | 'overlap_leader_front'  // 重なり：Leaderが手前
  | 'overlap_follower_front'// 重なり：Followerが手前
  | 'skip';                 // このフレームはスキップ

/** アノテーション済みフレーム */
export interface AnnotatedFrame extends RawPoseFrame {
  label: AnnotationLabel;
}

/** アノテーター書き出し JSON のルート */
export interface AnnotatedPoseLog {
  version: 'salsa_annotated_v1';
  sourceFile: string;
  annotatedAt: string;
  totalFrames: number;
  labeledFrames: number;
  frames: AnnotatedFrame[];
}

/** 33点の接続（描画用） */
export const POSE_CONNECTIONS: Array<[number, number]> = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
  [9,10],
  [11,12],[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
  [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
  [11,23],[12,24],[23,24],
  [23,25],[24,26],[25,27],[26,28],
  [27,29],[28,30],[29,31],[30,32],[27,31],[28,32],
];
