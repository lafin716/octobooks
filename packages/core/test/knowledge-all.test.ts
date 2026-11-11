import { describe, expect, it } from 'vitest';
import { defaultSkills, knowledgeUsesAll, matchSkill, wantsKnowledge, type ID, type Session } from '../src';

/** 테스트에 필요한 필드만 채운 세션 */
function s(id: ID, parentId: ID | null, extra: Partial<Session> = {}): Session {
  return { id, parentId, rootId: 'r', ...extra } as Session;
}

describe('지식베이스 기본 전체 사용 (ADR-141)', () => {
  it('루트까지 아무 목록도 정하지 않았으면 전체를 쓴다', () => {
    const sessions = { r: s('r', null), b: s('b', 'r') };
    expect(knowledgeUsesAll(sessions, 'r')).toBe(true);
    expect(knowledgeUsesAll(sessions, 'b')).toBe(true);
  });

  it('직접 고른 목록, 명시적 끔([]), 예전 knowledgeId가 있으면 전체가 아니다', () => {
    expect(knowledgeUsesAll({ r: s('r', null, { knowledgeIds: ['kb1'] }) }, 'r')).toBe(false);
    expect(knowledgeUsesAll({ r: s('r', null, { knowledgeIds: [] }) }, 'r')).toBe(false);
    expect(knowledgeUsesAll({ r: s('r', null, { knowledgeId: 'kb1' }) }, 'r')).toBe(false);
    // 가지가 자기 목록을 정하면 부모가 전체여도 그 목록을 쓴다
    expect(knowledgeUsesAll({ r: s('r', null), b: s('b', 'r', { knowledgeIds: ['kb1'] }) }, 'b')).toBe(false);
  });

  it('전체 사용 요청은 일반 대화에만 지식베이스를 붙인다', () => {
    expect(wantsKnowledge({ knowledgeAll: true })).toBe(true);
    expect(wantsKnowledge({ knowledgeAll: true, purpose: 'chat' })).toBe(true);
    expect(wantsKnowledge({ knowledgeAll: true, purpose: 'summary' as never })).toBe(false);
    expect(wantsKnowledge({})).toBe(false);
  });
});

describe('지식베이스 탐색 스킬 자동 선택 (ADR-144)', () => {
  const skills = defaultSkills(1);
  const name = (text: string, kbs: string[] = []) => matchSkill(text, skills, kbs)?.name ?? null;

  it('자기 자료를 가리키는 말이면 고른다', () => {
    expect(name('지식베이스에서 Pod IP 할당 방식 찾아줘')).toBe('knowledge');
    expect(name('내가 올린 문서 기준으로 설명해줘')).toBe('knowledge');
    expect(name('업로드한 코드에서 로그인 처리 흐름 알려줘')).toBe('knowledge');
    expect(name('Explain this from my uploaded docs')).toBe('knowledge');
  });

  it('질문이 지식베이스 이름을 말하면 고른다. 짧은 이름은 무시한다', () => {
    expect(name('쿠버네티스 문서에 나온 CNI 설명해줘', ['쿠버네티스 문서'])).toBe('knowledge');
    expect(name('쿠버네티스문서 정리해줘', ['쿠버네티스 문서'])).toBe('knowledge');
    expect(name('Go 언어 문법 알려줘', ['Go'])).toBeNull();
    expect(name('CNI가 뭐야?', ['쿠버네티스 문서'])).toBeNull();
  });

  it('관련 없는 질문이나 다른 의도가 분명하면 고르지 않는다', () => {
    expect(name('5분 뒤 퀴즈 내줘', ['쿠버네티스 문서'])).toBe('schedule');
    expect(name('쿠버네티스 문서로 퀴즈 내줘', ['쿠버네티스 문서'])).toBe('quiz');
    expect(name('안녕! 오늘 날씨 어때?', ['쿠버네티스 문서'])).toBeNull();
  });
});
