import { describe, expect, it } from 'vitest';
import { AUTO_DESCRIPTION_RE, appendAutoDescription, describeUpload, KNOWLEDGE_DESCRIPTION_MAX } from '../src';

const D = '2026-11-11';

describe('업로드 자동 설명 한 줄 (describeUpload)', () => {
  it('저장소: 언어별 코드 수·문서 수·매니페스트 소개를 담는다', () => {
    const line = describeUpload(
      { kind: 'github', names: ['octo-cli'], fileCount: 130, exts: { ts: 100, tsx: 20, md: 8, json: 2 }, titles: ['설치 가이드'], manifest: { name: 'octo-cli', description: '명령줄 도구' } },
      D,
    );
    expect(line).toMatch(AUTO_DESCRIPTION_RE);
    expect(line).toContain('octo-cli');
    expect(line).toContain('TypeScript');
    expect(line).toContain('120');
    expect(line).toContain("'명령줄 도구'");
    expect(line).toContain('설치 가이드');
  });

  it('파일 하나: 이름과 종류를 괄호로 붙인다', () => {
    const line = describeUpload({ kind: 'files', names: ['report.pdf'], fileCount: 1, exts: { pdf: 1 }, titles: [] }, D);
    expect(line.startsWith(`- ${D} `)).toBe(true);
    expect(line).toContain('report.pdf (');
  });

  it('이름이 많으면 3개만 보이고 나머지는 개수로 줄인다', () => {
    const names = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
    const line = describeUpload({ kind: 'files', names, fileCount: 5, exts: { md: 5 }, titles: [] }, D);
    expect(line).toContain('a.md, b.md, c.md');
    expect(line).not.toContain('d.md');
    expect(line).toContain('2');
  });

  it('줄바꿈·제어 문자를 지우고 300자로 자른다', () => {
    const line = describeUpload({ kind: 'web', names: [`제목\n${'x'.repeat(500)}`], fileCount: 1, exts: { md: 1 }, titles: ['y'.repeat(400)] }, D);
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(300);
  });
});

describe('설명에 자동 줄 붙이기 (appendAutoDescription)', () => {
  it('빈 설명이면 그 줄만, 있으면 끝에 줄을 바꿔 붙인다', () => {
    expect(appendAutoDescription(undefined, '- 2026-11-11 a')).toBe('- 2026-11-11 a');
    expect(appendAutoDescription('내 설명', '- 2026-11-11 a')).toBe('내 설명\n- 2026-11-11 a');
  });

  it('넘치면 가장 오래된 자동 줄부터 지우고 사용자 글은 남긴다', () => {
    const user = '사용자 설명';
    const old = `- 2026-01-01 ${'o'.repeat(50)}`;
    const mid = `- 2026-02-01 ${'m'.repeat(50)}`;
    const add = `- 2026-03-01 ${'n'.repeat(50)}`;
    const next = appendAutoDescription([user, old, mid].join('\n'), add, user.length + mid.length + add.length + 2);
    expect(next).toBe([user, mid, add].join('\n'));
  });

  it('사용자 글만으로 넘치면 새 줄을 붙이지 않는다', () => {
    const user = '가'.repeat(KNOWLEDGE_DESCRIPTION_MAX);
    expect(appendAutoDescription(user, '- 2026-11-11 a')).toBe(user);
  });
});
