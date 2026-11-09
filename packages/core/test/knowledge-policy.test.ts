import { describe, expect, it } from 'vitest';
import { cleanExcludes, compileExcludes, DEFAULT_CODEBASE_EXCLUDES } from '../src';

describe('제외 경로', () => {
  it('정리: 상위 경로·절대 드라이브·주석·중복 제거', () => {
    expect(cleanExcludes(['dist/', '../x', 'C:/a', '# c', 'dist/', ' logs ', 5])).toEqual(['dist/', 'logs']);
  });
  it('gitignore 꼴 판정', () => {
    const m = compileExcludes([...DEFAULT_CODEBASE_EXCLUDES, '/secret.txt', 'docs/**/*.tmp', '*.log', '!keep.log']);
    expect(m('node_modules', true)).toBe(true);
    expect(m('packages/a/node_modules', true)).toBe(true);
    expect(m('node_modules', false)).toBe(false);
    expect(m('dist', true)).toBe(true);
    expect(m('src/app.min.js', false)).toBe(true);
    expect(m('secret.txt', false)).toBe(true);
    expect(m('a/secret.txt', false)).toBe(false);
    expect(m('docs/x/y/z.tmp', false)).toBe(true);
    expect(m('err.log', false)).toBe(true);
    expect(m('keep.log', false)).toBe(false);
    expect(m('src/index.ts', false)).toBe(false);
  });
});

describe('grep 정규식 안전성 (역추적 폭주 방지)', () => {
  it('위험한 반복 그룹은 거부한다', async () => {
    const { isSafeRegexSource } = await import('../src/rag/tools');
    for (const bad of ['(a+)+', '(a|a)*c', '((ab)*)+', '(x+x+)+y', '(a|b){2,}', '(\\w+\\s?)*$', '(a)\\1', '(?<n>a)\\k<n>', '(a', 'a)', '.*.*.*.*X', '.*.*X', '\\S+\\S+x', '[^a]*[^b]*c', '\\w+\\w+\\w+X', 'a.{0,500}b.{0,500}c', '\\w+.*X', '\\d+\\d*x']) {
      expect(isSafeRegexSource(bad), bad).toBe(false);
    }
  });
  it('일반 정규식은 허용한다', async () => {
    const { isSafeRegexSource } = await import('../src/rag/tools');
    for (const ok of ['func\\s+\\w+', 'class (Foo|Bar)', '(foo|bar)?baz', 'a{2}', '[(|)]+x', 'export (async )?function', 'v\\d+\\.\\d+', 'import .* from', 'TODO.*fix', '[\\w*]+x', 'a.{0,10}b.{0,10}c', 'foo\\s*\\(', 'def \\w+']) {
      expect(isSafeRegexSource(ok), ok).toBe(true);
    }
  });
});
