// 지식베이스 IPC의 인자 검증 (ADR-136). Electron에 의존하지 않는 순수 모듈이라 단위 테스트한다.
// 렌더러 입력은 여기서 다시 확인한다. 종류·색인·벡터 정책은 없다 (모든 KB가 같은 폴더 탐색 방식을 쓴다).
import { KNOWLEDGE_DESCRIPTION_MAX, isGitImportMode, isKnowledgeId, isKnowledgePath, type GitImportMode, type KnowledgeCreateOptions } from '@branch/core';

export class KbArgError extends Error {
  constructor(readonly field: string) {
    super(`kb-arg:${field}`);
    this.name = 'KbArgError';
  }
}

export function kbIdArg(v: unknown): string {
  if (!isKnowledgeId(v)) throw new KbArgError('id');
  return v;
}

export function kbRelPathArg(v: unknown, field = 'path'): string {
  if (!isKnowledgePath(v)) throw new KbArgError(field);
  return v;
}

export function kbDescriptionArg(v: unknown): string {
  if (typeof v !== 'string' || v.length > KNOWLEDGE_DESCRIPTION_MAX) throw new KbArgError('description');
  return v.trim();
}

/**
 * 새 지식베이스 옵션. 설명만 받는다.
 * 연결 폴더(linkedPath)는 새로 만들 수 없다 (ADR-136). 기존 연결만 읽기 전용으로 탐색한다.
 */
export function kbCreateOptsArg(v: unknown): KnowledgeCreateOptions {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new KbArgError('create');
  const o = v as Record<string, unknown>;
  if (o.linkedPath !== undefined) throw new KbArgError('linkedPath');
  const out: KnowledgeCreateOptions = {};
  if (o.description !== undefined) out.description = kbDescriptionArg(o.description);
  return out;
}

/** GitHub 가져오기 방식 (ADR-138). 생략하면 clone (.git 유지, pull로 갱신). 값이 있으면 clone·zip만 받는다 */
export function gitModeArg(opts: unknown): GitImportMode {
  if (opts === undefined || opts === null) return 'clone';
  if (typeof opts !== 'object' || Array.isArray(opts)) throw new KbArgError('mode');
  const mode = (opts as { mode?: unknown }).mode;
  if (mode === undefined) return 'clone';
  if (!isGitImportMode(mode)) throw new KbArgError('mode');
  return mode;
}
