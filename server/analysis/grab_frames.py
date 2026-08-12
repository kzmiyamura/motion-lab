# 元動画から指定時刻のフレームを切り出す（3D側と1フレームずつ見比べるため）
# 使い方: python grab_frames.py <video.mp4> <outdir> <t1> <t2> ...
import cv2, sys, os

src, outdir = sys.argv[1], sys.argv[2]
ts = [float(x) for x in sys.argv[3:]]
os.makedirs(outdir, exist_ok=True)
cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS)
n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
print(f'fps={fps:.3f} frames={n:.0f} size={w:.0f}x{h:.0f}')
for t in ts:
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, img = cap.read()
    if not ok:
        print(f't={t}: read failed'); continue
    # 縦長は長辺 720px に縮めて保存（見比べ用）
    s = 720 / max(img.shape[:2])
    if s < 1:
        img = cv2.resize(img, (int(img.shape[1] * s), int(img.shape[0] * s)))
    p = os.path.join(outdir, f'v_{t:06.2f}.jpg')
    cv2.imwrite(p, img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    print('wrote', p)
cap.release()
