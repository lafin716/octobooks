import { describe, expect, it } from 'vitest';
// 데스크탑 앱의 IPC 인자 검증은 Electron에 의존하지 않는 순수 모듈이라 여기서 함께 테스트한다.
import { gitModeArg, kbCreateOptsArg, kbIdArg, kbRelPathArg, KbArgError } from '../../../apps/desktop/src/kbGuard';

function argErrorField(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof KbArgError ? err.field : `not-kb-arg:${String(err)}`;
  }
}

describe('gitModeArg — GitHub 가져오기 방식 (ADR-138)', () => {
  it('생략하면 clone이다 (.git 유지, pull 가능)', () => {
    expect(gitModeArg(undefined)).toBe('clone');
    expect(gitModeArg(null)).toBe('clone');
    expect(gitModeArg({})).toBe('clone');
    expect(gitModeArg({ mode: undefined })).toBe('clone');
  });

  it('clone과 zip만 받는다', () => {
    expect(gitModeArg({ mode: 'clone' })).toBe('clone');
    expect(gitModeArg({ mode: 'zip' })).toBe('zip');
  });

  it('그 밖의 값이나 객체가 아니면 mode 오류', () => {
    for (const bad of [{ mode: 'svn' }, { mode: 'ZIP' }, { mode: 1 }, { mode: null }, 'zip', []]) {
      expect(argErrorField(() => gitModeArg(bad))).toBe('mode');
    }
  });
});

describe('kbCreateOptsArg — 새 지식베이스 옵션', () => {
  it('없으면 빈 옵션이다', () => {
    expect(kbCreateOptsArg(undefined)).toEqual({});
    expect(kbCreateOptsArg(null)).toEqual({});
  });

  it('설명은 앞뒤 공백을 떼어 받는다', () => {
    expect(kbCreateOptsArg({ description: '  메모  ' })).toEqual({ description: '메모' });
  });

  it('연결 폴더(linkedPath)로는 새로 만들 수 없다 (ADR-136)', () => {
    expect(argErrorField(() => kbCreateOptsArg({ linkedPath: '/Users/me/docs' }))).toBe('linkedPath');
    expect(argErrorField(() => kbCreateOptsArg({ linkedPath: undefined, description: 'x' }))).toBeNull();
  });

  it('객체가 아니거나 설명이 2000자를 넘으면 거부한다', () => {
    expect(argErrorField(() => kbCreateOptsArg('name'))).toBe('create');
    expect(argErrorField(() => kbCreateOptsArg([]))).toBe('create');
    expect(argErrorField(() => kbCreateOptsArg({ description: 'a'.repeat(2001) }))).toBe('description');
    expect(kbCreateOptsArg({ description: 'a'.repeat(2000) }).description).toHaveLength(2000);
  });
});

describe('kbIdArg / kbRelPathArg — 기본 인자 검증', () => {
  it('형식이 맞는 id와 상대 경로는 그대로 돌려준다', () => {
    expect(kbIdArg('kbaaaaaa')).toBe('kbaaaaaa');
    expect(kbRelPathArg('docs/a.md')).toBe('docs/a.md');
  });

  it('id가 틀리면 id 오류, 경로가 틀리면 path 오류 (기본 필드명)', () => {
    expect(argErrorField(() => kbIdArg('../etc'))).toBe('id');
    expect(argErrorField(() => kbRelPathArg('../etc/passwd'))).toBe('path');
    expect(argErrorField(() => kbRelPathArg('/abs/path'))).toBe('path');
    expect(argErrorField(() => kbRelPathArg('a\\b'))).toBe('path');
    expect(argErrorField(() => kbRelPathArg(42, 'from'))).toBe('from');
  });
});
