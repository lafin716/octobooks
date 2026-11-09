import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KB_TOOLS_GUIDE, KB_TOOL_NAMES } from '@branch/core';
import { KbToolService, loadKbEntries, kbToolsNote, type KbEntry } from '../src';

/** 코드베이스 KB 라우팅: 색인 없이 실제 파일을 읽고, 문서형 KB와 섞이지 않는지 확인한다 */
let root: string;
let codeFiles: string;
let docFiles: string;
let linked: string;
let code: KbEntry;
let doc: KbEntry;

function write(p: string, body: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body);
}

const parsed = (text: string) => JSON.parse(text) as Record<string, unknown>;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cbsvc-'));
  codeFiles = path.join(root, 'kbcode001', 'files');
  docFiles = path.join(root, 'kbdoc0001', 'files');
  linked = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cblinked-')));
  write(path.join(codeFiles, 'src', 'app.ts'), 'export function startServer() {\n  return 1;\n}\n');
  write(path.join(codeFiles, 'src', 'more.ts'), 'return 2;\n');
  write(path.join(codeFiles, 'node_modules', 'x', 'i.js'), 'function startServer() {}\n');
  write(path.join(docFiles, 'note.md'), '# 노트\n서버 설정 메모\n');
  write(path.join(linked, 'lib', 'util.py'), 'def startServer():\n    pass\n');
  code = { kbId: 'kbcode001', kbName: '코드 KB', filesRoot: codeFiles };
  doc = { kbId: 'kbdoc0001', kbName: '문서 KB', filesRoot: docFiles };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(linked, { recursive: true, force: true });
});

describe('KbToolService 코드베이스 라우팅', () => {
  it('grepKnowledge는 코드베이스 KB를 실제 파일에서 찾고 node_modules는 건너뛴다', async () => {
    const svc = new KbToolService({ kbs: [code, doc] });
    const g = parsed((await svc.call('grepKnowledge', { kbId: 'kbcode001', pattern: 'startServer' })).text);
    const paths = (g.hits as { path: string }[]).map((h) => h.path);
    expect(paths).toContain('src/app.ts');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(g.notes).toEqual([]);
  });

  it('다른 KB의 자료는 한 KB 검색에 섞이지 않는다', async () => {
    const svc = new KbToolService({ kbs: [code, doc] });
    const g = parsed((await svc.call('grepKnowledge', { kbId: 'kbdoc0001', pattern: 'startServer' })).text);
    expect(g.hits).toEqual([]);
    const bad = await svc.call('grepKnowledge', { kbId: 'kbnone001', pattern: 'x' });
    expect(bad.isError).toBe(true);
    expect(parsed(bad.text).error).toBe('kb_not_allowed');
  });

  it('listKnowledgeDirectory는 코드베이스 제외 규칙을 적용하고 폴더 메타를 붙이지 않는다', async () => {
    const svc = new KbToolService({ kbs: [code] });
    const r = await svc.call('listKnowledgeDirectory', { kbId: 'kbcode001' });
    const names = (parsed(r.text).entries as { name: string }[]).map((e) => e.name);
    expect(names).toContain('src');
    expect(names).not.toContain('node_modules');
    expect(parsed(r.text).summary).toBeUndefined();
  });

  it('readKnowledgeFile은 코드베이스 파일 줄 범위를 읽는다', async () => {
    const svc = new KbToolService({ kbs: [code] });
    const r = await svc.call('readKnowledgeFile', { kbId: 'kbcode001', path: 'src/app.ts', startLine: 1, endLine: 2 });
    expect(r.isError).toBe(false);
    expect(parsed(r.text)).toMatchObject({ startLine: 1, totalLines: 3, truncated: true });
    const mid = await svc.call('readKnowledgeFile', { kbId: 'kbcode001', path: 'src/app.ts', startLine: 2 });
    expect(parsed(mid.text)).toMatchObject({ path: 'src/app.ts', startLine: 2, endLine: 3, truncated: false });
  });

  it('getKnowledgeOutline은 코드베이스 파일에서 선언을 낸다', async () => {
    const svc = new KbToolService({ kbs: [code] });
    const r = await svc.call('getKnowledgeOutline', { kbId: 'kbcode001', path: 'src/app.ts' });
    expect(r.isError).toBe(false);
    expect(JSON.stringify(parsed(r.text).items)).toContain('startServer');
  });

  it('findFiles·grepKnowledge·findDefinitions는 결과와 잘림 표시를 돌려준다', async () => {
    const svc = new KbToolService({ kbs: [code] });
    const f = parsed((await svc.call('findFiles', { kbId: 'kbcode001', pattern: '*.ts', limit: 5 })).text);
    expect(f.paths).toEqual(['src/app.ts', 'src/more.ts']);
    expect(f.truncated).toBe(false);

    const g = parsed((await svc.call('grepKnowledge', { kbId: 'kbcode001', pattern: 'startserver' })).text);
    expect((g.hits as { path: string }[]).map((h) => h.path)).toEqual(['src/app.ts']);
    expect(g.scannedFiles).toBeGreaterThan(0);
    expect(g.notes).toEqual([]);

    const d = parsed((await svc.call('findDefinitions', { kbId: 'kbcode001', symbol: 'startServer' })).text);
    expect(d.hits).toEqual([expect.objectContaining({ path: 'src/app.ts', line: 1, kind: 'function' })]);
  });

  it('limit을 넘는 결과는 truncated=true로 표시한다', async () => {
    const svc = new KbToolService({ kbs: [code] });
    const r = parsed((await svc.call('findFiles', { kbId: 'kbcode001', pattern: '*.ts', limit: 1 })).text);
    expect(r.paths).toHaveLength(1);
    expect(r.truncated).toBe(true);
    const g = parsed((await svc.call('grepKnowledge', { kbId: 'kbcode001', pattern: 'return', limit: 1 })).text);
    expect((g.hits as unknown[]).length).toBe(1);
    expect(g.truncated).toBe(true);
  });

  it('잘못된 정규식은 bad_input으로 거부한다', async () => {
    const svc = new KbToolService({ kbs: [code] });
    const r = await svc.call('grepKnowledge', { kbId: 'kbcode001', pattern: '(a+)+$', regex: true });
    if (r.isError) expect(parsed(r.text).error).toBe('bad_input');
  });

  it('연결 폴더가 사라진 코드베이스는 not_found로 알리고, 다른 KB는 계속 탐색된다', async () => {
    const gone: KbEntry = { ...code, kbId: 'kbgone001', kbName: '사라짐', missing: true };
    const svc = new KbToolService({ kbs: [gone, doc] });
    const r = await svc.call('findFiles', { kbId: 'kbgone001', pattern: '*' });
    expect(r.isError).toBe(true);
    expect(parsed(r.text).error).toBe('not_found');
    const ok = await svc.call('findFiles', { kbId: 'kbdoc0001', pattern: '*.md' });
    expect(ok.isError).toBe(false);
    expect(parsed(ok.text).paths).toEqual(['note.md']);
  });

  it('도구 이름 목록은 여섯 개이며 검색(searchKnowledge)은 없다', () => {
    expect(KB_TOOL_NAMES).toEqual(['listKnowledgeDirectory', 'readKnowledgeFile', 'getKnowledgeOutline', 'findFiles', 'grepKnowledge', 'findDefinitions']);
    expect(KB_TOOL_NAMES).not.toContain('searchKnowledge' as never);
  });
});

describe('loadKbEntries (메타 기반)', () => {
  it('연결 폴더 코드베이스는 원본 폴더를 루트로 쓰고, 유형과 제외 규칙을 싣는다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cbload-'));
    try {
      write(path.join(dir, 'kblinked1', 'meta.json'), JSON.stringify({ name: '연결', linkedPath: linked }));
      const { entries, problems } = await loadKbEntries(dir, ['kblinked1']);
      expect(problems).toEqual([]);
      expect(entries[0]).toMatchObject({ kbId: 'kblinked1', kbName: '연결', filesRoot: linked });
      expect(entries[0]?.missing).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('연결 폴더가 없으면 항목은 남기고 missing으로 표시하며 문제로 알린다', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cbload-'));
    try {
      write(path.join(dir, 'kbgone002', 'meta.json'), JSON.stringify({ name: '없음', linkedPath: path.join(dir, 'nope') }));
      const { entries, problems } = await loadKbEntries(dir, ['kbgone002']);
      expect(entries[0]?.missing).toBe(true);
      expect(problems).toEqual(['linked folder missing: kbgone002']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('kbToolsNote 안내 문구', () => {
  it('선택한 KB 이름과 id를 나열하고, 사용 여부 규칙(조건부)을 포함한다', () => {
    const note = kbToolsNote([{ kbId: 'kbcode001', kbName: '코드\n  KB' }, { kbId: 'kbdoc0001', kbName: '문서' }], 'codex-cli');
    expect(note).toContain('- 코드 KB (kbId: kbcode001)');
    expect(note).toContain('- 문서 (kbId: kbdoc0001)');
    expect(note).toContain(KB_TOOLS_GUIDE);
    // 일정·퀴즈·잡담에는 쓰지 않는다는 조건이 안내에 있어야 한다 (ADR-137)
    expect(KB_TOOLS_GUIDE).toContain('Do NOT use them for scheduling');
    expect(KB_TOOLS_GUIDE).toContain('quiz');
    expect(note).not.toContain('prefixed with');
  });

  it('Claude 안내에는 도구 접두어 설명이 붙고 Codex 안내에는 붙지 않는다', () => {
    const entries = [{ kbId: 'kbdoc0001', kbName: '문서' }];
    expect(kbToolsNote(entries, 'claude-cli')).toContain('prefixed with mcp__octobooks__');
    expect(kbToolsNote(entries, 'codex-cli')).not.toContain('prefixed with');
  });
});
