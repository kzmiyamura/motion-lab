import { useEffect, useState } from 'react';
import { getFolderSpec, putFolderSpec, reanalyzeFolder } from '../engine/homeServer';
import styles from './SpecEditorModal.module.css';

type Props = {
  folderId: string;
  folderName: string;
  baseUrl: string;
  onClose: () => void;
  /** 保存後に呼ばれる（一覧のバッジ更新用） */
  onSaved?: () => void;
};

/** 指示書がまだ無いフォルダ向けのテンプレート（docs/folder-analysis-design.md §5） */
const TEMPLATE_MD = `---
preset: salsa-pair
version: 1
---

# このフォルダの解析

## やること
- 各フレームの男女（Leader/Follower）判定
- 重なっている区間も手前/奥を判別

## 判断のヒント（自由記述 — Claudeが読む）
- （例）この教室の動画は基本、画面左からスタートするのが男性

## レポート形式
- 冒頭にサマリ（誰がリーダーか・自信度）
- 判定が難しかった区間を表で（mm:ss / 理由 / 判定）
`;

export function SpecEditorModal({ folderId, folderName, baseUrl, onClose, onSaved }: Props) {
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const spec = await getFolderSpec(baseUrl, folderId);
        if (cancelled) return;
        if (spec) {
          setMarkdown(spec.markdown);
        } else {
          setMarkdown(TEMPLATE_MD);
          setIsNew(true);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '指示書の取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, folderId]);

  const save = async (alsoReanalyze: boolean) => {
    setSaving(true);
    setError('');
    try {
      await putFolderSpec(baseUrl, folderId, markdown);
      if (alsoReanalyze) {
        const { jobIds } = await reanalyzeFolder(baseUrl, folderId);
        alert(`保存しました。${jobIds.length} 件の解析ジョブを積みました。`);
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 className={styles.title}>📝 解析指示書 — {folderName}</h3>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {isNew && (
          <p className={styles.hint}>
            このフォルダにはまだ指示書がありません。テンプレートを編集して保存すると、
            以降このフォルダに入った動画は指示書どおりに自動解析されます。
          </p>
        )}

        {loading ? (
          <p className={styles.hint}>読み込み中…</p>
        ) : (
          <textarea
            className={styles.editor}
            value={markdown}
            onChange={e => setMarkdown(e.target.value)}
            spellCheck={false}
          />
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose} disabled={saving}>キャンセル</button>
          <button className={styles.saveBtn} onClick={() => save(false)} disabled={saving || loading}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button className={styles.saveBtn} onClick={() => save(true)} disabled={saving || loading}>
            保存して既存動画も再解析
          </button>
        </div>
      </div>
    </div>
  );
}
