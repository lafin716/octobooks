import { KB_TOOLS_GUIDE } from '@branch/core';
import { KB_MCP_TOOL_PREFIX } from './config';

/**
 * 답변 시스템 안내: 이번 답에 연결된 지식베이스 목록과 도구 사용법 (ADR-137).
 * 사용 여부 판단(질문이 자료를 요구할 때만, 일정·퀴즈·잡담에는 쓰지 않음)은 KB_TOOLS_GUIDE가 맡는다.
 * 미리 검색한 결과는 넣지 않는다. Claude는 도구 이름에 접두어가 붙는다.
 */
export function kbToolsNote(kbs: { kbId: string; kbName: string }[], provider: 'claude-cli' | 'codex-cli'): string {
  // 이름의 제어 문자·줄바꿈·공백 연속은 한 칸으로: 이름으로 안내문에 줄을 끼워 넣지 못하게
  const list = kbs.map((k) => `- ${k.kbName.replace(/[\p{Cc}\s]+/gu, ' ').trim()} (kbId: ${k.kbId})`);
  const names = provider === 'claude-cli' ? `In this CLI the tool names are prefixed with ${KB_MCP_TOOL_PREFIX}.` : '';
  return ['Knowledge bases for this answer:', ...list, KB_TOOLS_GUIDE, names].filter(Boolean).join('\n');
}
