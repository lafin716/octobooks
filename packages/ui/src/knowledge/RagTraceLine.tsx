import { t } from '../i18n';

/**
 * 답변 아래 한 줄 표시: 이 답변을 만들 때 지식베이스를 몇 번 탐색했는지만 보여 준다.
 * 이전 버전이 남긴 풍부한 trace 객체(검색 단계·시간 등)는 무시하고 toolCalls만 본다.
 */
export interface KnowledgeTrace {
  toolCalls: number;
}

/** 저장된 값이 객체가 아니거나 toolCalls가 정상 숫자가 아니면 null */
export function knowledgeToolCalls(trace: unknown): number | null {
  if (typeof trace !== 'object' || trace === null) return null;
  const n = (trace as { toolCalls?: unknown }).toolCalls;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function RagTraceLine({ trace }: { trace: unknown }) {
  const calls = knowledgeToolCalls(trace);
  if (calls === null) return null;
  return (
    <p data-rag-trace="" className="mt-1 text-[12px] text-fg-2">
      {t('knowledge.trace.explored', { count: calls })}
    </p>
  );
}
