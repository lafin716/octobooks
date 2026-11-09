import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { BINARY_EXTS, DEFAULT_CODEBASE_EXCLUDES, cleanExcludes, compileExcludes, extOf } from '@branch/core';

/**
 * 연결 폴더(구버전 linkedPath, 읽기 전용) 도우미 (ADR-136).
 * 새 연결 폴더는 만들 수 없다. 남은 연결 폴더는 개수·크기 캐시만 다시 잰다.
 */

/** 폴더 훑기 상한 (항목 수). 넘으면 truncated로 표시하고 멈춘다 */
export const FOLDER_WALK_MAX_ENTRIES = 20_000;
/** 훑으며 세는 파일 상한 (크기 합 계산 포함) */
const FOLDER_WALK_MAX_FILES = 50_000;

/** 폴더의 .gitignore 규칙 (있으면). 기본 제외에 더해 쓴다 */
async function gitignoreRules(dir: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(dir, '.gitignore'), 'utf8');
    return cleanExcludes(raw.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')));
  } catch {
    return [];
  }
}

export interface LinkedWalkResult {
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

/**
 * 연결 폴더를 제외 규칙(기본 + 사용자 + .gitignore)을 적용해 훑는다. 숨김 항목·심볼릭 링크는 건너뛴다.
 * 상한에 닿으면 truncated. 파일 내용은 읽지 않는다.
 */
export async function walkLinkedFolder(
  root: string,
  excludes: readonly string[],
  opts: { maxEntries?: number } = {},
): Promise<LinkedWalkResult> {
  const matcher = compileExcludes([...DEFAULT_CODEBASE_EXCLUDES, ...excludes, ...(await gitignoreRules(root))]);
  const max = opts.maxEntries ?? FOLDER_WALK_MAX_ENTRIES;
  const res: LinkedWalkResult = { fileCount: 0, totalBytes: 0, truncated: false };
  let visited = 0;

  async function visit(absDir: string, rel: string): Promise<void> {
    if (res.truncated) return;
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const isDir = d.isDirectory();
      if (!isDir && !d.isFile()) continue;
      if (matcher(childRel, isDir)) continue;
      visited++;
      if (visited > max) {
        res.truncated = true;
        return;
      }
      if (isDir) {
        await visit(path.join(absDir, d.name), childRel);
        if (res.truncated) return;
        continue;
      }
      if (BINARY_EXTS.has(extOf(d.name))) continue;
      const st = await lstat(path.join(absDir, d.name)).catch(() => null);
      if (!st) continue;
      res.fileCount++;
      res.totalBytes += st.size;
      if (res.fileCount >= FOLDER_WALK_MAX_FILES) {
        res.truncated = true;
        return;
      }
    }
  }

  await visit(root, '');
  return res;
}

/** 연결 폴더의 개수·크기 (KB 목록 캐시용). 제외 규칙을 따른다 */
export async function measureLinked(root: string, excludes: readonly string[]): Promise<{ fileCount: number; totalBytes: number }> {
  const w = await walkLinkedFolder(root, excludes, { maxEntries: FOLDER_WALK_MAX_ENTRIES });
  return { fileCount: w.fileCount, totalBytes: w.totalBytes };
}
