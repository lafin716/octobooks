import { useEffect, useMemo, useState } from 'react';
import { effectiveKnowledgeIds, knowledgeInherited, knowledgeUsesAll, type DesktopKnowledgeApi, type ID } from '@branch/core';
import { actions, useApp, useAppShallow } from '../app/store';
import { useKnowledgeApi } from './remoteApi';

/**
 * 세션에 적용되는 지식베이스 상태 (ADR-113).
 * ids: 직접 정한 목록 (상속 포함). inherited: 부모 가지에서 물려받는 중. overridden: 이 세션이 직접 정한 목록이 있다.
 * all: 목록을 정한 적이 없어 PC의 지식베이스 전체를 쓴다 (ADR-141). 이때 ids는 비어 있다.
 */
export function useSessionKnowledge(sessionId: ID) {
  const ids = useAppShallow((s) => effectiveKnowledgeIds(s.sessions, sessionId));
  const inherited = useApp((s) => knowledgeInherited(s.sessions, sessionId));
  const overridden = useApp((s) => {
    const cur = s.sessions[sessionId];
    return !!cur?.parentId && cur.knowledgeIds !== undefined;
  });
  const all = useApp((s) => knowledgeUsesAll(s.sessions, sessionId));
  return { ids, inherited, overridden, all };
}

/**
 * 지식베이스 하나를 연결하거나 끊는다. 상속 중이면 부모 목록을 이 세션의 목록으로 옮긴 뒤 바꾼다.
 * 전체 사용 중이면 currentIds로 지금 있는 지식베이스 전체를 넘긴다 (하나를 끄면 나머지 목록이 된다)
 */
export function toggleSessionKnowledge(sessionId: ID, currentIds: readonly string[], kbId: string) {
  const next = currentIds.includes(kbId) ? currentIds.filter((id) => id !== kbId) : [...currentIds, kbId];
  actions().setSessionKnowledgeIds(sessionId, next);
}

/** 가지의 지식베이스 덮어쓰기를 풀고 부모를 따른다. 루트면 전체 사용(기본)으로 돌아간다 */
export function resetSessionKnowledge(sessionId: ID) {
  actions().setSessionKnowledgeIds(sessionId, null);
}

/** 마지막으로 받은 지식베이스 목록 (id → 이름). 입력창이 다시 그려질 때마다 부르지 않으려고 모듈에 둔다 */
let namesCache: { api: DesktopKnowledgeApi; bases: { id: string; name: string }[] } | null = null;
const namesListeners = new Set<() => void>();

async function refreshKnowledgeNames(api: DesktopKnowledgeApi) {
  try {
    const list = await api.list();
    namesCache = { api, bases: list.map((b) => ({ id: b.id, name: b.name })) };
    namesListeners.forEach((l) => l());
  } catch {
    // 목록을 못 받으면 이름 매칭만 빠진다. 지식베이스 사용 여부는 답변 모델이 판단한다
  }
}

/**
 * 이 세션이 쓸 수 있는 지식베이스 이름 (ADR-144). 질문이 이름을 말하면 지식베이스 탐색 스킬을 고른다.
 * 전체 사용이면 모든 이름, 아니면 연결한 지식베이스 이름만 준다. 입력창이 열릴 때 목록을 새로 받는다.
 */
export function useKnowledgeNames(sessionId: ID): string[] {
  const api = useKnowledgeApi();
  const { ids, all } = useSessionKnowledge(sessionId);
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    namesListeners.add(l);
    if (api) void refreshKnowledgeNames(api);
    return () => {
      namesListeners.delete(l);
    };
  }, [api]);
  return useMemo(() => {
    if (!api || namesCache?.api !== api) return [];
    const bases = all ? namesCache.bases : namesCache.bases.filter((b) => ids.includes(b.id));
    return bases.map((b) => b.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- namesCache 변화는 bump로 다시 그려 반영한다
  }, [api, all, ids, namesCache]);
}
