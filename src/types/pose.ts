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
  | 'standard_pos'      // [1] 正常: L(0)/F(1) が正しく離れている
  | 'swapped_pos'       // [2] 反転: ID逆転 → export時に座標swap→standard_pos変換
  | 'single_leader'     // [3] 単体(L): リーダーのみ認識
  | 'single_follower'   // [4] 単体(F): フォロワーのみ認識
  | 'overlap_L_front'   // [5] 重なり: リーダー手前
  | 'overlap_F_front'   // [6] 重なり: フォロワー手前
  | 'side_L_right'      // [7] 横並び: L右・F左
  | 'side_L_left'       // [9] 横並び: L左・F右
  | 'complex_turn'      // [8] 回転中: スピン等で手足が交差
  | 'ignore_trash'      // [0] 破棄: ノイズ・画面外など学習に有害
  | 'skip';             // 未レビュー（内部状態）

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
