/**
 * フォルダ別解析指示書（MD）のファイルI/O。
 *   server/storage/specs/<folderId>/analysis.md に保存する。
 * frontmatter は依存を増やさないため簡易な自前パース（preset / version のみ抽出）。
 * docs/folder-analysis-detailed-design.md §2 参照
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from './presets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SPECS_DIR = path.resolve(__dirname, '../storage/specs');

export class SpecValidationError extends Error {}

export interface ParsedSpec {
  preset: string;
  version: number;
  markdown: string;
}

function specPath(folderId: string): string {
  return path.join(SPECS_DIR, folderId, 'analysis.md');
}

/**
 * frontmatter（先頭の --- ... --- ブロック）から preset / version を抽出する。
 * YAMLライブラリは使わず `key: value` 形式のみ対応。
 */
export function parseSpec(markdown: string): ParsedSpec {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new SpecValidationError('frontmatter（--- で囲まれたブロック）がありません');

  const front = m[1];
  const presetMatch = front.match(/^preset:\s*(\S+)\s*$/m);
  if (!presetMatch) throw new SpecValidationError('frontmatter に preset がありません');
  const preset = presetMatch[1];
  if (!(preset in PRESETS)) {
    throw new SpecValidationError(`未知の preset です: ${preset}（利用可能: ${Object.keys(PRESETS).join(', ')}）`);
  }

  const versionMatch = front.match(/^version:\s*(\d+)\s*$/m);
  const version = versionMatch ? Number(versionMatch[1]) : 1;

  return { preset, version, markdown };
}

/** 指示書を読む。無ければ null */
export function readSpec(folderId: string): ParsedSpec | null {
  const p = specPath(folderId);
  if (!existsSync(p)) return null;
  return parseSpec(readFileSync(p, 'utf-8'));
}

/** 検証してから保存する。検証失敗時は SpecValidationError を投げる（保存されない） */
export function writeSpec(folderId: string, markdown: string): ParsedSpec {
  const parsed = parseSpec(markdown);
  const dir = path.dirname(specPath(folderId));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(specPath(folderId), markdown, 'utf-8');
  return parsed;
}

/** フォルダ削除時に指示書ディレクトリごと削除する */
export function deleteSpec(folderId: string): void {
  rmSync(path.join(SPECS_DIR, folderId), { recursive: true, force: true });
}
