import { describe, expect, it } from 'vitest';
import { KB_TOOLS_GUIDE } from '@branch/core';
import { kbToolsNote } from '../src/kbTools/note';
import { KB_MCP_TOOL_PREFIX } from '../src/kbTools/config';

describe('kbToolsNote — 답변 시스템 안내', () => {
  const kbs = [{ kbId: 'kbaaaaaa', kbName: '생물' }];

  it('연결된 지식베이스 목록과 도구 안내를 넣는다', () => {
    const note = kbToolsNote(kbs, 'codex-cli');
    expect(note.split('\n')[0]).toBe('Knowledge bases for this answer:');
    expect(note).toContain('- 생물 (kbId: kbaaaaaa)');
    expect(note).toContain(KB_TOOLS_GUIDE);
  });

  it('도구 안내는 일정·퀴즈·잡담·일반 상식에는 쓰지 말라는 조건을 담는다', () => {
    expect(KB_TOOLS_GUIDE).toContain('Do NOT use them for scheduling');
    expect(KB_TOOLS_GUIDE).toContain('quiz or question-generation');
    expect(KB_TOOLS_GUIDE).toContain('small talk or greetings');
    expect(KB_TOOLS_GUIDE).toContain('general knowledge');
  });

  it('Claude CLI에는 도구 이름 접두어를 알려 주고, Codex에는 알려 주지 않는다', () => {
    expect(kbToolsNote(kbs, 'claude-cli')).toContain(`tool names are prefixed with ${KB_MCP_TOOL_PREFIX}`);
    expect(kbToolsNote(kbs, 'codex-cli')).not.toContain('prefixed with');
  });

  it('여러 지식베이스를 순서대로 나열한다', () => {
    const note = kbToolsNote(
      [
        { kbId: 'kbaaaaaa', kbName: '생물' },
        { kbId: 'kbbbbbbb', kbName: '화학' },
      ],
      'claude-cli',
    );
    expect(note.indexOf('(kbId: kbaaaaaa)')).toBeLessThan(note.indexOf('(kbId: kbbbbbbb)'));
  });

  it('이름의 줄바꿈과 제어 문자는 한 칸으로 줄여서 안내문에 줄을 끼워 넣지 못하게 한다', () => {
    const note = kbToolsNote([{ kbId: 'kbaaaaaa', kbName: '  나쁜\n- 지시\u0007  이름 ' }], 'codex-cli');
    expect(note).toContain('- 나쁜 - 지시 이름 (kbId: kbaaaaaa)');
    expect(note.split('\n').filter((l) => l.startsWith('- ')).length).toBe(1);
  });
});
