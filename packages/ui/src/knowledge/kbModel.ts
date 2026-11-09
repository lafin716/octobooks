/**
 * 지식베이스 목록·등록 화면의 순수 헬퍼 (DOM·React 무관, 단위 테스트 대상).
 */
import type { KnowledgeBase } from '@branch/core';

export type KbSort = 'recent' | 'name' | 'size';

/** 이름·설명·연결 경로에서 검색어를 찾는다 (대소문자 무시, 공백으로 나눈 모든 토막이 있어야 함). */
export function matchesQuery(kb: KnowledgeBase, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [kb.name, kb.description ?? '', kb.linkedPath ?? ''].join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function filterBases(bases: readonly KnowledgeBase[], opts: { query?: string }): KnowledgeBase[] {
  return bases.filter((kb) => matchesQuery(kb, opts.query ?? ''));
}

/** 정렬은 새 배열을 돌려준다. size는 totalBytes 큰 순, name은 한국어 로케일 비교. */
export function sortBases(bases: readonly KnowledgeBase[], sort: KbSort): KnowledgeBase[] {
  const out = [...bases];
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  else if (sort === 'size') out.sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name, 'ko'));
  else out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** 파일 이름과 크기가 같은 항목끼리 묶는다 (중복 후보). 키는 `name|size`. */
export function duplicateKey(name: string, size: number): string {
  return `${name.trim().toLowerCase()}|${size}`;
}

/**
 * 추가하려는 파일 중 이미 있는 것을 찾는다.
 * existing: KB 안에 이미 있는 파일 (경로·이름·크기), incoming: 새로 고른 파일.
 * 같은 이름+크기를 기준으로 하며, 목록 안 중복과 KB 안 중복을 모두 본다.
 */
export function findDuplicates<T extends { name: string; size: number }>(
  incoming: readonly T[],
  existing: readonly { name: string; size: number }[],
): { duplicates: T[]; unique: T[] } {
  const seen = new Set(existing.map((e) => duplicateKey(e.name, e.size)));
  const duplicates: T[] = [];
  const unique: T[] = [];
  for (const item of incoming) {
    const key = duplicateKey(item.name, item.size);
    if (seen.has(key)) duplicates.push(item);
    else {
      seen.add(key);
      unique.push(item);
    }
  }
  return { duplicates, unique };
}

/** 폴더 경로(또는 선택한 폴더)의 이름에서 기본 KB 이름을 만든다. */
export function defaultNameFromPath(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '');
  const last = cleaned.split(/[\\/]/).pop() ?? '';
  return last.trim();
}

/** GitHub 주소(owner/repo 또는 https://github.com/owner/repo)에서 기본 이름(repo)을 얻는다. */
export function defaultNameFromGit(input: string): string {
  const m = input.trim().replace(/\.git$/, '').match(/([^/\s]+)\/([^/\s]+)$/);
  return m?.[2] ?? '';
}

/** 파일 크기 표시 (기존 formatBytes와 같은 단위 규칙). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 표시할 수 있는 시각(ms)만 돌려준다. 0 이하·NaN·범위 밖이면 null (예: 1970년 표시 방지). */
export function validTime(ts: unknown): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  return Number.isFinite(new Date(ts).getTime()) ? ts : null;
}

/** 긴 문자열을 가운데 줄임표로 자른다. 앞·뒤를 남겨 경로의 폴더명과 파일명이 모두 보이게 한다. */
export function middleEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ''}`;
}
