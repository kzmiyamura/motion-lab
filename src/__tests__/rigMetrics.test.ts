import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { segSegDist, jointAngles, capsules, penetrations } from '../engine/rigMetrics';
import { buildRigObjects } from '../engine/coupleSolver';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('segSegDist', () => {
  it('ねじれの位置で交差して見える2線分 = 高さの差', () => {
    expect(segSegDist(V(-1, 0, 0), V(1, 0, 0), V(0, 0.3, -1), V(0, 0.3, 1))).toBeCloseTo(0.3, 9);
  });
  it('交わる線分は 0', () => {
    expect(segSegDist(V(-1, 0, 0), V(1, 0, 0), V(0, -1, 0), V(0, 1, 0))).toBeCloseTo(0, 9);
  });
  it('平行な線分（重なりあり）= 線間距離', () => {
    expect(segSegDist(V(0, 0, 0), V(1, 0, 0), V(0.5, 0.2, 0), V(1.5, 0.2, 0))).toBeCloseTo(0.2, 9);
  });
  it('平行で重ならない線分 = 端点どうし', () => {
    expect(segSegDist(V(0, 0, 0), V(1, 0, 0), V(2, 0, 0), V(3, 0, 0))).toBeCloseTo(1, 9);
  });
  it('端点が最近点になる（延長線上の交点は数えない）', () => {
    expect(segSegDist(V(0, 0, 0), V(1, 0, 0), V(2, -1, 0), V(2, 1, 0))).toBeCloseTo(1, 9);
  });
  it('点と点・点と線分', () => {
    expect(segSegDist(V(0, 0, 0), V(0, 0, 0), V(0, 3, 4), V(0, 3, 4))).toBeCloseTo(5, 9);
    expect(segSegDist(V(0, 1, 0), V(0, 1, 0), V(-1, 0, 0), V(1, 0, 0))).toBeCloseTo(1, 9);
  });
  it('対称（引数の順を入れ替えても同じ）', () => {
    const a = [V(0.1, 0.2, 0.3), V(-0.4, 0.9, 0.1)], b = [V(0.5, -0.2, 0.7), V(0.2, 0.6, -0.3)];
    expect(segSegDist(a[0], a[1], b[0], b[1])).toBeCloseTo(segSegDist(b[1], b[0], a[1], a[0]), 9);
  });
});

describe('jointAngles（胸郭ローカル: +X = 本人の左、+Z = 前）', () => {
  const rig = buildRigObjects();
  const setArm = (k: number, q: THREE.Quaternion, bend: number) => {
    rig.shldr[k].quaternion.copy(q);
    rig.elbow[k].rotation.set(bend, 0, 0);
  };
  const Ry = (a: number) => new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), a);
  const Rx = (a: number) => new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), a);
  const D = Math.PI / 180;

  it('腕を下ろして肘を前へ曲げた構え = 捻り 0・挙上 0', () => {
    // 骨ローカル +Z（肘頭）を真後ろへ向ける = y まわり 180°
    setArm(0, Ry(Math.PI), 90 * D);
    const a = jointAngles(rig).arm[0];
    expect(a.elev).toBeCloseTo(0, 6);
    expect(a.twist).toBeCloseTo(0, 6);
    expect(a.elbow).toBeCloseTo(90, 6);
  });

  it('外旋（前腕が外へ開く）が正。左右とも同じ符号', () => {
    setArm(0, Ry(Math.PI + 30 * D), 90 * D);   // 左: 肘頭が内（-X）へ = 前腕が外（+X）へ
    expect(jointAngles(rig).arm[0].twist).toBeCloseTo(30, 6);
    setArm(1, Ry(Math.PI - 30 * D), 90 * D);   // 右は鏡
    expect(jointAngles(rig).arm[1].twist).toBeCloseTo(30, 6);
    setArm(0, Ry(Math.PI - 50 * D), 90 * D);   // 左の内旋
    expect(jointAngles(rig).arm[0].twist).toBeCloseTo(-50, 6);
  });

  it('前へ水平に上げた腕 = 挙上 90・伸展 0・横切り 0', () => {
    setArm(0, Rx(-90 * D), 0);                  // 真下 → 前（+Z）
    const a = jointAngles(rig).arm[0];
    expect(a.elev).toBeCloseTo(90, 6);
    expect(a.ext).toBeCloseTo(0, 6);
    expect(a.cross).toBeCloseTo(0, 6);
  });

  it('後ろへ 40° 引いた腕 = 伸展 40', () => {
    setArm(0, Rx(40 * D), 0);                   // 真下 → 後ろ（-Z）へ 40°
    expect(jointAngles(rig).arm[0].ext).toBeCloseTo(40, 6);
  });

  it('体を横切る腕: 左腕が正中を越えて右へ 30° = 横切り 30', () => {
    // 水平・前方から右（-X）へ 30° 振った向き
    const u = V(-Math.sin(30 * D), 0, Math.cos(30 * D));
    setArm(0, new THREE.Quaternion().setFromUnitVectors(V(0, -1, 0), u), 0);
    expect(jointAngles(rig).arm[0].cross).toBeCloseTo(30, 6);
  });

  it('股関節: 前へ 30° = 屈曲 30、外へ 20° = 外転 20、膝頭が外へ 25° = 外旋 25', () => {
    rig.thigh[0].quaternion.copy(Rx(-30 * D));
    expect(jointAngles(rig).leg[0].flex).toBeCloseTo(30, 6);
    const Rz = (a: number) => new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), a);
    rig.thigh[1].quaternion.copy(Rz(-20 * D));   // 右脚: 下 → 右（-X）へ = 外転
    expect(jointAngles(rig).leg[1].abd).toBeCloseTo(20, 6);
    rig.thigh[0].quaternion.copy(Ry(25 * D));    // 左脚: 膝頭 +Z → +X（外）
    expect(jointAngles(rig).leg[0].rot).toBeCloseTo(25, 6);
  });

  it('体幹のねじれ・首', () => {
    rig.spine.rotation.set(0, 0.5, 0);
    rig.head.rotation.set(0, -0.8, 0);
    const a = jointAngles(rig);
    expect(a.trunkTwist).toBeCloseTo(0.5 / D, 4);
    expect(a.headChest).toBeCloseTo(0.8 / D, 4);
  });
});

describe('capsules / penetrations', () => {
  it('離れて立つ2人は食い込まない・重ねれば胴が食い込む', () => {
    const a = buildRigObjects(), b = buildRigObjects();
    b.root.position.set(1, 0, 0);
    a.root.updateMatrixWorld(true); b.root.updateMatrixWorld(true);
    expect(capsules(a, 0).length).toBeGreaterThan(10);
    const p = penetrations([a, b]);
    expect(p.armPartner).toBeLessThanOrEqual(0);
    expect(p.legPartner).toBeLessThanOrEqual(0);
    // 自分の両脚は 0.2m 離れた平行（太もも r 0.078 × 2 = 0.156 < 0.2）
    expect(p.legSelf).toBeLessThanOrEqual(0);
    b.root.position.set(0.2, 0, 0);
    b.root.updateMatrixWorld(true);
    expect(penetrations([a, b]).legPartner).toBeGreaterThan(0.05);
  });
});
