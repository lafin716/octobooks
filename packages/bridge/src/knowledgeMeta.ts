import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isKnowledgeId } from '@branch/core';

/**
 * meta.json 읽기 전용 공용 도우미. MCP 서버와 store가 같은 규칙으로 KB의 이름과 원본 위치를 본다.
 * 쓰기는 knowledgeStore만 한다.
 *
 * KB 유형(kind)과 벡터 색인은 없어졌다 (ADR-136). 모든 KB는 파일 폴더로 탐색한다.
 * linkedPath가 있는 구버전 KB는 읽기 전용 연결 폴더로 계속 탐색한다.
 */
export interface KbMetaView {
  id: string;
  name: string;
  /** 읽기 전용 연결 폴더 (절대 경로, 구버전 데이터) */
  linkedPath?: string;
  /** 사용자가 쓰거나 업로드 때 자동으로 붙은 설명 (ADR-142). 모델이 질문과 관련 있는지 판단하는 데 쓴다 */
  description?: string;
}

/** meta.json을 읽는다. 없거나 깨졌거나 id 형식이 틀리면 undefined */
export function readKbMeta(root: string, id: string): KbMetaView | undefined {
  if (!isKnowledgeId(id)) return undefined;
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, id, 'meta.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    raw = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : id;
  const linkedPath = typeof raw.linkedPath === 'string' && path.isAbsolute(raw.linkedPath) ? raw.linkedPath : undefined;
  const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined;
  return { id, name, ...(linkedPath ? { linkedPath } : {}), ...(description ? { description } : {}) };
}

/**
 * 원본 파일 루트. 읽기 전용 연결 폴더는 그 폴더(realpath), 아니면 `<root>/<id>/files`.
 * 연결 폴더가 사라졌으면 undefined (호출 쪽이 알린다).
 */
export function filesRootOf(root: string, id: string, meta: KbMetaView | undefined = readKbMeta(root, id)): string | undefined {
  if (meta?.linkedPath) {
    try {
      const real = realpathSync(meta.linkedPath);
      return statSync(real).isDirectory() ? real : undefined;
    } catch {
      return undefined;
    }
  }
  return path.join(root, id, 'files');
}
