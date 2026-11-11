import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanLegacyIndexes, createKnowledgeStore, type KnowledgeStore } from '../src/knowledgeStore';
import { gz, type Item } from './helpers/tar';

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const enc = new TextEncoder();

/** GitHub 저장소 압축 파일 모양 (최상위 폴더 아래 파일들) */
function repoArchive(extra: Item[] = []): Uint8Array {
  return gz([
    { name: 'octo-repo-abc123/', type: '5' },
    { name: 'octo-repo-abc123/README.md', body: '# 저장소' },
    { name: 'octo-repo-abc123/src/', type: '5' },
    { name: 'octo-repo-abc123/src/main.ts', body: 'export {};' },
    { name: 'octo-repo-abc123/.git/config', body: '[core]' },
    { name: 'octo-repo-abc123/link', type: '2', linkname: '/etc/passwd' },
    ...extra,
  ]);
}

/**
 * 가짜 fetch: codeload 요청은 압축 파일을, 나머지는 작은 HTML 페이지를 돌려준다.
 * 실제 네트워크는 쓰지 않는다 (lookup도 빈 목록으로 막아 DNS를 안 탄다).
 */
function fakeFetch(archive: Uint8Array): typeof fetch {
  return (async (input: string | URL | Request) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.includes('codeload.github.com')) {
      return new Response(archive, { status: 200, headers: { 'content-type': 'application/gzip' } });
    }
    return new Response('<html><head><title>예제 페이지</title></head><body><p>본문입니다.</p></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }) as unknown as typeof fetch;
}

/**
 * 가짜 git: 인자를 로그에 남기고, clone이면 .git과 파일·심볼릭 링크를 만들고, pull이면 표시 파일을 쓴다.
 * FAKE_GIT_MODE=fail이면 fatal 오류로 끝낸다.
 */
const FAKE_GIT = `#!/bin/sh
echo "$@" >> "$FAKE_GIT_LOG"
if [ "$FAKE_GIT_MODE" = "fail" ]; then
  echo "fatal: repository 'https://github.com/x/y.git' not found" >&2
  exit 128
fi
case " $* " in
  *" clone "*)
    for a; do dest="$a"; done
    mkdir -p "$dest/.git"
    echo "# hello" > "$dest/README.md"
    echo "[core]" > "$dest/.git/config"
    ln -s /etc/hosts "$dest/hosts-link"
    if [ "$FAKE_GIT_MODE" = "big" ]; then
      # 희소 파일로 한도(500MB)를 넘는 크기를 만들고, 감시가 멈출 때까지 버틴다
      dd if=/dev/zero of="$dest/.git/pack.bin" bs=1 count=0 seek=629145600 2>/dev/null
      sleep 10
    fi
    ;;
  *" pull "*)
    echo "pulled" > pulled.txt
    ;;
esac
exit 0
`;

describe('knowledgeStore — 기본 관리', () => {
  let root: string;
  let store: KnowledgeStore;

  beforeAll(async () => {
    root = await tmp('kb-store-basic-');
    store = createKnowledgeStore({ root, fetch: fakeFetch(new Uint8Array()) });
  });

  it('새 지식베이스는 이름과 설명을 가지고, 목록에 나타난다 (파일 없음)', async () => {
    const kb = await store.create('  생물  ', { description: '  세포 이야기  ' });
    expect(kb.name).toBe('생물');
    expect(kb.description).toBe('세포 이야기');
    expect(kb.fileCount).toBe(0);
    const list = await store.list();
    expect(list.map((k) => k.id)).toContain(kb.id);
  });

  it('이름을 바꾸면 목록에 새 이름이 나온다', async () => {
    const kb = await store.create('임시');
    const renamed = await store.rename(kb.id, '이름 변경');
    expect(renamed.name).toBe('이름 변경');
    expect((await store.list()).find((k) => k.id === kb.id)?.name).toBe('이름 변경');
  });

  it('설명은 앞뒤 공백을 떼고 2000자까지 저장하며, 빈 문자열이면 지운다', async () => {
    const kb = await store.create('설명');
    const set = await store.setDescription(kb.id, `  ${'가'.repeat(2100)}  `);
    expect(set.description).toHaveLength(2000);
    const cleared = await store.setDescription(kb.id, '   ');
    expect(cleared.description).toBeUndefined();
  });

  it('파일을 직접 넣으면 하나씩 들어가고, 같은 이름은 겹치지 않게 바뀐다', async () => {
    const kb = await store.create('업로드');
    const first = await store.addFiles(kb.id, [{ name: 'note.txt', data: enc.encode('첫째') }]);
    const second = await store.addFiles(kb.id, [{ name: 'note.txt', data: enc.encode('둘째') }]);
    expect(first.added).toEqual(['note.txt']);
    expect(second.added).toHaveLength(1);
    expect(second.added[0]).not.toBe('note.txt');
    const top = await store.tree(kb.id, '');
    expect(top.map((e) => e.path).sort()).toEqual(['note.txt', second.added[0]].sort());
  });

  it('지식베이스를 지우면 목록과 폴더에서 사라진다', async () => {
    const kb = await store.create('지울 것');
    await store.remove(kb.id);
    expect((await store.list()).map((k) => k.id)).not.toContain(kb.id);
    await expect(store.tree(kb.id, '')).rejects.toThrow();
  });

  it('없는 지식베이스의 목록·폴더 요청은 실패한다', async () => {
    await expect(store.tree('kbzzzzzz', '')).rejects.toThrow();
    await expect(store.setDescription('kbzzzzzz', 'x')).rejects.toThrow();
  });
});

describe('knowledgeStore — 폴더 한 단계 읽기 (tree)', () => {
  let root: string;
  let store: KnowledgeStore;
  let kbId: string;

  beforeAll(async () => {
    root = await tmp('kb-store-tree-');
    store = createKnowledgeStore({ root, fetch: fakeFetch(repoArchive()), gitBin: '/nonexistent/git' });
    kbId = (await store.create('트리')).id;
    await store.addFiles(kbId, [
      { name: 'b.md', data: enc.encode('bb') },
      { name: 'a.md', data: enc.encode('a') },
    ]);
    await store.addFiles(kbId, [{ name: 'deep.md', data: enc.encode('d') }], 'docs/sub');
  });

  it('dir은 필수다: 잘못된 값은 실패한다', async () => {
    await expect(store.tree(kbId, undefined as unknown as string)).rejects.toThrow();
  });

  it('최상위는 폴더가 먼저, 그다음 이름순으로 한 단계만 돌려준다', async () => {
    const top = await store.tree(kbId, '');
    expect(top.map((e) => [e.path, e.dir])).toEqual([
      ['docs', true],
      ['a.md', false],
      ['b.md', false],
    ]);
    // 하위 폴더 내용은 들어 있지 않다
    expect(top.some((e) => e.path === 'docs/sub')).toBe(false);
  });

  it('하위 폴더를 주면 그 아래 한 단계만 돌려준다 (경로는 files/ 기준)', async () => {
    const docs = await store.tree(kbId, 'docs');
    expect(docs.map((e) => e.path)).toEqual(['docs/sub']);
    const sub = await store.tree(kbId, 'docs/sub');
    expect(sub.map((e) => e.path)).toEqual(['docs/sub/deep.md']);
  });

  it('파일 경로를 폴더로 열면 실패한다', async () => {
    await expect(store.tree(kbId, 'a.md')).rejects.toThrow();
  });

  it('없는 폴더는 실패한다', async () => {
    await expect(store.tree(kbId, 'nope')).rejects.toThrow();
  });

  it('출처의 저장 위치와 같은 항목에는 source를 붙이고, 다른 항목에는 붙이지 않는다', async () => {
    const link = await store.addLink(kbId, 'https://example.com/page');
    const linkDir = path.posix.dirname(link.added[0]!);
    const siblings = await store.tree(kbId, linkDir);
    const linkEntry = siblings.find((e) => e.path === link.added[0]);
    expect(linkEntry?.source).toMatchObject({ type: 'web', dest: link.added[0] });
    expect((await store.tree(kbId, '')).find((e) => e.path === 'b.md')?.source?.type).toBe('files');
  });
});

describe('knowledgeStore — 경로 탈출 막기', () => {
  let root: string;
  let store: KnowledgeStore;
  let kbId: string;

  beforeAll(async () => {
    root = await tmp('kb-store-escape-');
    store = createKnowledgeStore({ root, fetch: fakeFetch(new Uint8Array()) });
    kbId = (await store.create('경로')).id;
    await store.addFiles(kbId, [{ name: 'ok.md', data: enc.encode('ok') }]);
    // 지식베이스 바깥(부모 폴더)에 비밀 파일을 둔다
    await writeFile(path.join(root, kbId, 'meta.json.secret'), 'secret');
  });

  const escapes = ['../meta.json', '../../etc/passwd', 'ok.md/../../x', '/etc/passwd', 'a\\b.md', 'ok.md\0'];
  for (const rel of escapes) {
    it(`tree·preview·resolvePath는 "${rel.replace(/\0/g, '\\0')}"를 거부한다`, async () => {
      await expect(store.tree(kbId, rel)).rejects.toThrow();
      await expect(store.preview(kbId, rel)).rejects.toThrow();
      await expect(store.resolvePath(kbId, rel)).rejects.toThrow();
    });
  }

  it('지식베이스 id 자체가 경로면 거부한다', async () => {
    await expect(store.tree('../' + kbId, '')).rejects.toThrow();
    expect(() => store.dirFor('../' + kbId)).toThrow();
  });

  it('심볼릭 링크를 따라 바깥을 읽지 못한다', async () => {
    const outside = await tmp('kb-outside-');
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await symlink(outside, path.join(root, kbId, 'files', 'escape-dir'));
    await expect(store.tree(kbId, 'escape-dir')).rejects.toThrow();
    await expect(store.preview(kbId, 'escape-dir/secret.txt')).rejects.toThrow();
    await expect(store.resolvePath(kbId, 'escape-dir/secret.txt')).rejects.toThrow();
  });

  it('정상 파일은 미리보기와 경로 확인이 된다', async () => {
    const preview = await store.preview(kbId, 'ok.md');
    expect(JSON.stringify(preview)).toContain('ok');
    expect(await store.resolvePath(kbId, 'ok.md')).toBe(path.join(root, kbId, 'files', 'ok.md'));
  });
});

describe('knowledgeStore — GitHub 클론 (가짜 git)', () => {
  let root: string;
  let logPath: string;
  let gitBin: string;
  let store: KnowledgeStore;
  let kbId: string;

  beforeAll(async () => {
    root = await tmp('kb-store-git-');
    const bin = await tmp('kb-fake-git-');
    gitBin = path.join(bin, 'git');
    await writeFile(gitBin, FAKE_GIT);
    await chmod(gitBin, 0o755);
    logPath = path.join(bin, 'git.log');
    store = createKnowledgeStore({
      root,
      gitBin,
      env: { ...process.env, FAKE_GIT_LOG: logPath },
      fetch: fakeFetch(repoArchive()),
    });
    kbId = (await store.create('깃')).id;
  });

  const url = 'https://github.com/octo/repo';

  it('clone은 .git을 남기고 심볼릭 링크는 지운다, 출처는 mode clone으로 기록한다', async () => {
    const res = await store.cloneGit(kbId, url, { mode: 'clone' });
    expect(res.added).toEqual(['repos/repo']);
    const repoDir = path.join(root, kbId, 'files', 'repos', 'repo');
    expect((await stat(path.join(repoDir, '.git'))).isDirectory()).toBe(true);
    expect((await stat(path.join(repoDir, 'README.md'))).isFile()).toBe(true);
    await expect(lstat(path.join(repoDir, 'hosts-link'))).rejects.toThrow();

    const srcs = await store.sources(kbId);
    expect(srcs).toHaveLength(1);
    expect(srcs[0]).toMatchObject({ type: 'github', mode: 'clone', dest: 'repos/repo', location: `${url}.git` });
  });

  it('clone 인자는 git 하드닝 옵션과 얕은 클론 옵션을 모두 가진다', async () => {
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('-c core.symlinks=false');
    expect(log).toContain('-c credential.helper=');
    expect(log).toContain('-c core.hooksPath=/dev/null');
    expect(log).toContain('-c core.fsmonitor=false');
    expect(log).toContain('clone --depth 1 --single-branch --no-tags --progress -- ' + url);
  });

  it('tree는 clone으로 받은 폴더에 github 출처를 붙인다 (pull 버튼용)', async () => {
    const top = await store.tree(kbId, 'repos');
    const repo = top.find((e) => e.path === 'repos/repo');
    expect(repo?.source).toMatchObject({ type: 'github', mode: 'clone' });
  });

  it('pull은 빨리 감기 인자로 실행하고, 출처 갱신 시각을 바꾼다', async () => {
    const before = (await store.sources(kbId))[0]!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const res = await store.pullGit(kbId, 'repos/repo');
    expect(res.added).toEqual(['repos/repo']);
    expect(await readFile(path.join(root, kbId, 'files', 'repos', 'repo', 'pulled.txt'), 'utf8')).toContain('pulled');
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('pull --ff-only --depth 1');
    const after = (await store.sources(kbId))[0]!.updatedAt;
    expect(after).toBeGreaterThan(before);
  });

  it('clone 저장소의 .git이 사라졌으면 pull을 거부한다', async () => {
    await rm(path.join(root, kbId, 'files', 'repos', 'repo', '.git'), { recursive: true, force: true });
    await expect(store.pullGit(kbId, 'repos/repo')).rejects.toThrow();
  });

  it('없는 항목이나 출처가 없는 폴더는 pull을 거부한다', async () => {
    await expect(store.pullGit(kbId, 'repos/none')).rejects.toThrow();
    await expect(store.pullGit(kbId, 'docs')).rejects.toThrow();
  });

  it('git 명령이 실패하면 git의 한 줄 메시지로 실패하고 임시 폴더를 남기지 않는다', async () => {
    const failing = createKnowledgeStore({
      root,
      gitBin,
      env: { ...process.env, FAKE_GIT_LOG: logPath, FAKE_GIT_MODE: 'fail' },
      fetch: fakeFetch(repoArchive()),
    });
    await expect(failing.cloneGit(kbId, 'https://github.com/x/y', { mode: 'clone' })).rejects.toThrow(/저장소를 찾을 수 없습니다/);
    const left = (await readdir(path.join(root, kbId))).filter((n) => n.startsWith('.clone-'));
    expect(left).toEqual([]);
  });

  it('클론 중 크기가 한도를 넘으면(.git 포함) git을 멈추고 임시 폴더를 남기지 않는다', async () => {
    const big = createKnowledgeStore({
      root,
      gitBin,
      env: { ...process.env, FAKE_GIT_LOG: logPath, FAKE_GIT_MODE: 'big' },
      fetch: fakeFetch(repoArchive()),
      cloneWatchMs: 50,
    });
    const started = Date.now();
    await expect(big.cloneGit(kbId, 'https://github.com/x/big', { mode: 'clone' })).rejects.toThrow(/용량 한도/);
    expect(Date.now() - started).toBeLessThan(8000);
    const left = (await readdir(path.join(root, kbId))).filter((n) => n.startsWith('.clone-'));
    expect(left).toEqual([]);
    expect((await store.sources(kbId)).some((s) => s.location.includes('/x/big'))).toBe(false);
  });

  it('git 실행 파일이 없으면 실패한다', async () => {
    const missing = createKnowledgeStore({ root, gitBin: '/nonexistent/path/git', env: process.env, fetch: fakeFetch(repoArchive()) });
    await expect(missing.cloneGit(kbId, url, { mode: 'clone' })).rejects.toThrow();
  });

  it('이미 취소된 요청은 git을 실행하지 않고 실패한다', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(store.cloneGit(kbId, url, { mode: 'clone' }, { signal: ac.signal })).rejects.toThrow();
  });

  it('GitHub 주소가 아니면 실패한다', async () => {
    await expect(store.cloneGit(kbId, 'https://example.com/a/b', { mode: 'clone' })).rejects.toThrow();
    await expect(store.cloneGit(kbId, 'file:///etc', { mode: 'clone' })).rejects.toThrow();
  });
});

describe('knowledgeStore — GitHub ZIP 가져오기 (tar.gz)', () => {
  let root: string;
  let store: KnowledgeStore;
  let kbId: string;

  beforeAll(async () => {
    root = await tmp('kb-store-zip-');
    store = createKnowledgeStore({ root, fetch: fakeFetch(repoArchive()), gitBin: '/nonexistent/git' });
    kbId = (await store.create('압축')).id;
  });

  it('압축 파일을 풀어 repos/<저장소>에 넣고, .git 없이 mode zip으로 기록한다', async () => {
    const res = await store.cloneGit(kbId, 'https://github.com/octo/repo', { mode: 'zip' });
    expect(res.added).toEqual(['repos/repo']);
    const base = path.join(root, kbId, 'files', 'repos', 'repo');
    expect(await readFile(path.join(base, 'README.md'), 'utf8')).toBe('# 저장소');
    expect(await readFile(path.join(base, 'src', 'main.ts'), 'utf8')).toBe('export {};');
    await expect(lstat(path.join(base, '.git'))).rejects.toThrow();
    await expect(lstat(path.join(base, 'link'))).rejects.toThrow();
    const srcs = await store.sources(kbId);
    expect(srcs.find((s) => s.dest === 'repos/repo')).toMatchObject({ type: 'github', mode: 'zip' });
  });

  it('zip으로 받은 저장소는 pull을 거부한다', async () => {
    await expect(store.pullGit(kbId, 'repos/repo')).rejects.toThrow();
  });

  it('두 번째 zip은 같은 이름을 피해 따로 넣는다', async () => {
    const res = await store.cloneGit(kbId, 'https://github.com/octo/repo', { mode: 'zip' });
    expect(res.added[0]).not.toBe('repos/repo');
    expect(res.added[0]!.startsWith('repos/')).toBe(true);
  });

  it('압축 파일이 깨졌으면 실패하고 임시 폴더를 남기지 않는다', async () => {
    const broken = createKnowledgeStore({ root, fetch: fakeFetch(new Uint8Array([1, 2, 3])), gitBin: '/nonexistent/git' });
    await expect(broken.cloneGit(kbId, 'https://github.com/octo/broke', { mode: 'zip' })).rejects.toThrow();
    const left = (await readdir(path.join(root, kbId))).filter((n) => n.startsWith('.zip-'));
    expect(left).toEqual([]);
  });

  it('잘못된 방식 값은 실패한다', async () => {
    await expect(store.cloneGit(kbId, 'https://github.com/octo/repo', { mode: 'svn' as never })).rejects.toThrow();
  });
});

describe('knowledgeStore — 항목 삭제 (removeEntry)', () => {
  let root: string;
  let store: KnowledgeStore;
  let kbId: string;
  let linkDest: string;

  beforeAll(async () => {
    root = await tmp('kb-store-remove-');
    store = createKnowledgeStore({ root, fetch: fakeFetch(repoArchive()), gitBin: '/nonexistent/git' });
    kbId = (await store.create('삭제')).id;
    await store.cloneGit(kbId, 'https://github.com/octo/repo', { mode: 'zip' });
    await store.addFiles(kbId, [{ name: 'keep.md', data: enc.encode('keep') }], 'docs');
    linkDest = (await store.addLink(kbId, 'https://example.com/page')).added[0]!;
  });

  it('폴더를 지우면 그 아래 파일과 그 폴더를 가리키던 출처 기록도 지운다', async () => {
    await store.removeEntry(kbId, 'repos/repo');
    const base = path.join(root, kbId, 'files', 'repos', 'repo');
    await expect(lstat(base)).rejects.toThrow();
    const srcs = await store.sources(kbId);
    expect(srcs.some((s) => s.dest === 'repos/repo')).toBe(false);
    // 관계없는 출처(링크)는 그대로 남는다
    expect(srcs.some((s) => s.dest === linkDest)).toBe(true);
  });

  it('파일을 지우면 그 파일의 출처 기록만 지운다', async () => {
    await store.removeEntry(kbId, linkDest);
    expect((await store.sources(kbId)).some((s) => s.dest === linkDest)).toBe(false);
    await expect(lstat(path.join(root, kbId, 'files', linkDest))).rejects.toThrow();
  });

  it('하위 항목을 지우면 같은 폴더의 다른 파일은 남는다', async () => {
    await store.removeEntry(kbId, 'docs/keep.md');
    const top = await store.tree(kbId, '');
    expect(top.find((e) => e.path === 'docs')?.dir).toBe(true);
    expect(await store.tree(kbId, 'docs')).toEqual([]);
  });

  it('없는 항목이나 빈 경로는 실패한다', async () => {
    await expect(store.removeEntry(kbId, 'nope')).rejects.toThrow();
    await expect(store.removeEntry(kbId, '')).rejects.toThrow();
  });
});

describe('knowledgeStore — 연결 폴더(구버전 linkedPath)는 읽기 전용', () => {
  let root: string;
  let external: string;
  let store: KnowledgeStore;
  const kbId = 'kblink01';

  beforeAll(async () => {
    root = await tmp('kb-store-linked-');
    external = await tmp('kb-external-');
    await mkdir(path.join(external, 'docs'), { recursive: true });
    await writeFile(path.join(external, 'docs', 'a.md'), '# 외부');
    await mkdir(path.join(root, kbId), { recursive: true });
    await writeFile(
      path.join(root, kbId, 'meta.json'),
      JSON.stringify({ name: '외부 폴더', createdAt: 1, updatedAt: 1, linkedPath: external }),
    );
    store = createKnowledgeStore({ root, fetch: fakeFetch(repoArchive()), gitBin: '/nonexistent/git' });
  });

  it('목록과 폴더 탐색, 미리보기, 경로 확인은 그대로 된다', async () => {
    expect((await store.list()).map((k) => k.id)).toContain(kbId);
    const top = await store.tree(kbId, '');
    expect(top.map((e) => e.path)).toEqual(['docs']);
    expect((await store.tree(kbId, 'docs')).map((e) => e.path)).toEqual(['docs/a.md']);
    const preview = await store.preview(kbId, 'docs/a.md');
    expect(JSON.stringify(preview)).toContain('외부');
    expect(await realpath(await store.resolvePath(kbId, 'docs/a.md'))).toBe(
      await realpath(path.join(external, 'docs', 'a.md')),
    );
  });

  it('dirFor는 연결 폴더의 실제 경로를 돌려준다', () => {
    return realpath(external).then((real) => expect(store.dirFor(kbId)).toBe(real));
  });

  it('파일을 바꾸는 작업(추가·링크·클론·삭제)은 모두 막는다', async () => {
    await expect(store.addFiles(kbId, [{ name: 'x.md', data: enc.encode('x') }])).rejects.toThrow();
    await expect(store.addLink(kbId, 'https://example.com/page')).rejects.toThrow();
    await expect(store.cloneGit(kbId, 'https://github.com/octo/repo', { mode: 'clone' })).rejects.toThrow();
    await expect(store.removeEntry(kbId, 'docs/a.md')).rejects.toThrow();
    await expect(store.pullGit(kbId, 'docs')).rejects.toThrow();
    // 외부 파일은 그대로다
    expect(await readFile(path.join(external, 'docs', 'a.md'), 'utf8')).toBe('# 외부');
  });

  it('설명 변경은 연결 폴더와 무관하게 된다', async () => {
    const kb = await store.setDescription(kbId, '메모');
    expect(kb.description).toBe('메모');
  });
});

describe('cleanLegacyIndexes — 옛 색인 파일 정리', () => {
  let root: string;

  beforeAll(async () => {
    root = await tmp('kb-store-clean-');
    const a = path.join(root, 'kbaaaaaa');
    await mkdir(path.join(a, 'files', 'docs'), { recursive: true });
    await writeFile(path.join(a, 'files', 'docs', 'keep.md'), '원본');
    await writeFile(path.join(a, 'files', 'index.sqlite'), '사용자 파일은 건드리지 않는다');
    await writeFile(path.join(a, 'index.sqlite'), 'db');
    await writeFile(path.join(a, 'index.sqlite-wal'), 'wal');
    await writeFile(path.join(a, 'index.sqlite-shm'), 'shm');
    await mkdir(path.join(a, 'backup'), { recursive: true });
    await writeFile(path.join(a, 'backup', 'old.sqlite'), 'old');
    // 꺼지면서 남은 클론 임시 폴더
    await mkdir(path.join(a, '.clone-0123456789ab', '.git'), { recursive: true });
    await writeFile(path.join(a, 'meta.json'), '{"name":"a","createdAt":1,"updatedAt":1}');

    const b = path.join(root, 'kbbbbbbb');
    await mkdir(path.join(b, 'files'), { recursive: true });
    await writeFile(path.join(b, 'files', 'x.md'), 'x');
    // 지식베이스 형식이 아닌 폴더는 건드리지 않는다
    await mkdir(path.join(root, 'other', 'backup'), { recursive: true });
    await writeFile(path.join(root, 'other', 'index.sqlite'), 'keep');
  });

  it('색인 파일과 backup 폴더를 지우고, 지운 개수를 돌려준다', async () => {
    const removed = await cleanLegacyIndexes(root);
    expect(removed).toBe(5);
    const a = path.join(root, 'kbaaaaaa');
    await expect(lstat(path.join(a, 'index.sqlite'))).rejects.toThrow();
    await expect(lstat(path.join(a, 'index.sqlite-wal'))).rejects.toThrow();
    await expect(lstat(path.join(a, 'index.sqlite-shm'))).rejects.toThrow();
    await expect(lstat(path.join(a, 'backup'))).rejects.toThrow();
    await expect(lstat(path.join(a, '.clone-0123456789ab'))).rejects.toThrow();
  });

  it('원본 파일(files/ 아래)과 meta.json은 그대로 둔다', async () => {
    const a = path.join(root, 'kbaaaaaa');
    expect(await readFile(path.join(a, 'files', 'docs', 'keep.md'), 'utf8')).toBe('원본');
    expect(await readFile(path.join(a, 'files', 'index.sqlite'), 'utf8')).toBe('사용자 파일은 건드리지 않는다');
    expect(await readFile(path.join(a, 'meta.json'), 'utf8')).toContain('"name":"a"');
  });

  it('두 번째 실행은 아무것도 지우지 않는다 (멱등)', async () => {
    expect(await cleanLegacyIndexes(root)).toBe(0);
    expect(await readFile(path.join(root, 'kbaaaaaa', 'files', 'docs', 'keep.md'), 'utf8')).toBe('원본');
  });

  it('지식베이스 형식이 아닌 폴더의 색인 파일은 건드리지 않는다', async () => {
    expect(await readFile(path.join(root, 'other', 'index.sqlite'), 'utf8')).toBe('keep');
  });

  it('없는 루트 폴더는 0을 돌려준다', async () => {
    expect(await cleanLegacyIndexes(path.join(root, 'nope'))).toBe(0);
  });
});

describe('knowledgeStore — 일반 규칙', () => {
  it('지식베이스 id는 형식이 맞아야 하고, 아니면 실패한다', async () => {
    const root = await tmp('kb-store-id-');
    const store = createKnowledgeStore({ root, fetch: fakeFetch(new Uint8Array()) });
    await expect(store.tree('BAD ID', '')).rejects.toThrow();
    await expect(store.tree(undefined as unknown as string, '')).rejects.toThrow();
  });

  it('빈 목록은 빈 배열이다 (루트가 없어도 오류가 아니다)', async () => {
    const store = createKnowledgeStore({ root: path.join(await tmp('kb-store-empty-'), 'missing'), fetch: fakeFetch(new Uint8Array()) });
    expect(await store.list()).toEqual([]);
  });
});

describe('knowledgeStore — 업로드 자동 설명 (ADR-143)', () => {
  it('파일·폴더를 넣을 때마다 설명 끝에 한 줄씩 붙고, 사용자 설명은 남는다', async () => {
    const root = await tmp('kb-store-auto-');
    const store = createKnowledgeStore({ root, fetch: fakeFetch(new Uint8Array()) });
    const kb = await store.create('자동', { description: '내가 쓴 설명' });
    await store.addFiles(kb.id, [{ name: 'net.md', data: enc.encode('# 클러스터 네트워킹\n\n본문') }]);

    const src = await tmp('kb-store-auto-src-');
    const proj = path.join(src, 'proj');
    await mkdir(path.join(proj, 'src'), { recursive: true });
    await writeFile(path.join(proj, 'package.json'), JSON.stringify({ name: 'proj', description: '작은 CLI' }));
    await writeFile(path.join(proj, 'src', 'main.ts'), 'export {};');
    await writeFile(path.join(proj, 'src', 'util.ts'), 'export {};');
    await mkdir(path.join(proj, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(proj, 'node_modules', 'x', 'i.js'), '');
    await store.addPaths(kb.id, [proj]);

    const desc = (await store.list()).find((k) => k.id === kb.id)?.description ?? '';
    const lines = desc.split('\n');
    expect(lines[0]).toBe('내가 쓴 설명');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^- \d{4}-\d{2}-\d{2} .*net\.md/);
    expect(lines[2]).toContain('proj');
    expect(lines[2]).toContain('TypeScript');
    expect(lines[2]).toContain("'작은 CLI'");
    expect(lines[2]).not.toContain('JavaScript');
  });
});
