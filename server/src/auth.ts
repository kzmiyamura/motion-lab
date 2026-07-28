/**
 * 書き込み系APIの共有トークン検証。
 * relay 経由の公開URLから spec（Claude Code に渡る指示書）を書き換えられる注入経路を塞ぐ。
 * docs/folder-analysis-detailed-design.md §4.1 / 基本設計 §11-2 参照
 *
 * API_WRITE_TOKEN 未設定時は警告を出して素通し（ローカル開発・移行期の互換）。
 */
import type { NextFunction, Request, Response } from 'express';

const API_WRITE_TOKEN = process.env.API_WRITE_TOKEN ?? '';

let warned = false;

export function requireWriteToken(req: Request, res: Response, next: NextFunction): void {
  if (!API_WRITE_TOKEN) {
    if (!warned) {
      warned = true;
      console.warn('[auth] API_WRITE_TOKEN が未設定のため書き込みAPIを無認証で許可しています（本番では設定推奨）');
    }
    return next();
  }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (token !== API_WRITE_TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
