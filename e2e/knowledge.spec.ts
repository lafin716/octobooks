import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 지식베이스 대화상자 (Modal: 목록·상세 두 영역, 추가 영역, 폴더 탐색기).
 * 웹 개발 서버에는 데스크톱 bridge가 없으므로 addInitScript가 메모리 안의 가짜 API(window.__branchKnowledgeFake)를 넣는다.
 * 가짜 API는 list/tree 호출을 window.__kbCalls에 남겨, 폴더 탐색이 현재 단계만 읽는지 확인한다.
 */
const KEY = 'sk-ant-e2e-ok';

type FakeSeed = { legacy?: boolean };

function installFakeKnowledge(seed: FakeSeed) {
  type Src = { id: string; type: 'files' | 'folder' | 'github' | 'web'; location: string; dest: string; mode?: 'clone' | 'zip'; addedAt: number; updatedAt: number };
  type Base = {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
    updatedAt: number;
    files: Map<string, string>;
    sources: Src[];
    linkedPath?: string;
  };
  const w = window as unknown as { __branchKnowledgeFake: unknown; __kbCalls: string[] };
  w.__kbCalls = [];
  const bases = new Map<string, Base>();
  let seq = 0;
  const info = (b: Base) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    fileCount: b.files.size,
    totalBytes: [...b.files.values()].reduce((a, c) => a + c.length, 0),
    linkedPath: b.linkedPath,
  });
  const get = (id: string) => {
    const b = bases.get(id);
    if (!b) throw new Error('no base');
    return b;
  };
  const put = (b: Base, paths: string[]) => {
    for (const p of paths) b.files.set(p, `본문: ${p}`);
    return { added: paths, skipped: 0 };
  };
  const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const listeners = new Set<(p: unknown) => void>();
  const emit = (p: unknown) => listeners.forEach((l) => l(p));
  // 취소 플래그: 'slow' 저장소는 취소될 때까지 기다린다
  let cancelled = false;

  if (seed.legacy) {
    bases.set('kblegacy01', {
      id: 'kblegacy01',
      name: '옛 노트',
      createdAt: 0,
      updatedAt: 0,
      files: new Map([['ch1.md', '옛 본문']]),
      sources: [],
      linkedPath: '/Users/me/old-notes',
    });
  }

  const api = {
    onProgress: (l: (p: unknown) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    cancel: async () => {
      cancelled = true;
    },
    list: async () => {
      w.__kbCalls.push('list');
      return [...bases.values()].map(info);
    },
    create: async (name: string, opts?: { description?: string }) => {
      const id = `kbfake${String(++seq).padStart(4, '0')}`;
      const b: Base = { id, name, description: opts?.description, createdAt: 0, updatedAt: 0, files: new Map(), sources: [] };
      bases.set(id, b);
      return info(b);
    },
    rename: async (id: string, name: string) => {
      const b = get(id);
      b.name = name;
      return info(b);
    },
    setDescription: async (id: string, description: string) => {
      const b = get(id);
      b.description = description || undefined;
      return info(b);
    },
    remove: async (id: string) => {
      bases.delete(id);
    },
    // 실제 브리지처럼 한 단계만 돌려준다
    tree: async (id: string, dir = '') => {
      w.__kbCalls.push(`tree:${id}:${dir}`);
      const b = get(id);
      const out = new Map<string, { path: string; dir: boolean; size?: number; source?: Src }>();
      for (const p of b.files.keys()) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
          const d = parts.slice(0, i).join('/');
          if (parentOf(d) === dir && !out.has(d)) {
            const src = b.sources.find((s) => s.dest === d);
            out.set(d, { path: d, dir: true, ...(src ? { source: src } : {}) });
          }
        }
        if (parentOf(p) === dir) out.set(p, { path: p, dir: false, size: b.files.get(p)!.length });
      }
      return [...out.values()].sort((a, c) => Number(c.dir) - Number(a.dir) || a.path.localeCompare(c.path));
    },
    pathForFile: () => '',
    addPaths: async (id: string, paths: string[]) => put(get(id), paths.map((p) => p.split('/').pop() ?? p)),
    addFiles: async (id: string, files: { name: string }[]) => put(get(id), files.map((f) => f.name)),
    pickFiles: async (id: string) => put(get(id), ['notes/intro.md']),
    addLink: async (id: string, url: string) => put(get(id), [`links/${url.split('/').pop()}.md`]),
    cloneGit: async (id: string, url: string, opts?: { mode?: 'clone' | 'zip' }) => {
      if (url.includes('/broken')) throw new Error("Error invoking remote method 'knowledge:clone-git': Error: 저장소를 받지 못했습니다 (Repository not found.)");
      const mode = opts?.mode ?? 'clone';
      const repo = (url.split("/").pop() ?? "repo").replace(/\.git$/, "");
      if (url.includes('/slow')) {
        cancelled = false;
        emit({ phase: 'clone' });
        for (let i = 0; i < 400 && !cancelled; i++) await new Promise((r) => setTimeout(r, 25));
        if (cancelled) throw new Error('가져오기를 취소했어요');
      }
      const b = get(id);
      const dest = `repos/${repo}`;
      const res = put(b, [`${dest}/README.md`]);
      b.sources.push({ id: `src${++seq}`, type: 'github', location: url, dest, mode, addedAt: 0, updatedAt: 0 });
      return res;
    },
    pullGit: async (id: string, path: string) => {
      w.__kbCalls.push(`pull:${id}:${path}`);
      return { added: [], skipped: 0 };
    },
    removeEntry: async (id: string, path: string) => {
      const b = get(id);
      for (const p of [...b.files.keys()]) if (p === path || p.startsWith(`${path}/`)) b.files.delete(p);
    },
    preview: async (id: string, path: string) => {
      const text = get(id).files.get(path) ?? null;
      return { text, size: text?.length ?? 0, truncated: false };
    },
    open: async () => {},
  };
  w.__branchKnowledgeFake = api;
}

async function start(page: Page) {
  await page.goto('/?platform=desktop');
  const onboarding = page.getByRole('dialog', { name: '시작하기' });
  await onboarding.getByRole('button', { name: /^API 키/ }).click();
  const input = page.getByLabel('Anthropic API 키');
  await input.fill(KEY);
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('연결됨');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '새 학습 시작' }).click();
  return page.locator('[data-panel="main"]');
}

async function openDialog(page: Page, seed: FakeSeed = {}) {
  await page.addInitScript(installFakeKnowledge, seed);
  const main = await start(page);
  await main.locator('[data-knowledge-button]').click();
  const dialog = page.getByRole('dialog', { name: '지식베이스', exact: true });
  await expect(dialog).toBeVisible();
  return { main, dialog };
}

/** 새 지식베이스를 만들고 상세 화면이 열린 것을 확인한다 */
async function createBase(dialog: Locator, name: string, description?: string) {
  // 모바일에서는 상세 화면이 목록을 가리므로 먼저 목록으로 돌아간다
  const back = dialog.getByRole('button', { name: '목록으로', exact: true });
  if (await back.isVisible()) await back.click();
  await dialog.getByRole('button', { name: '새 지식베이스' }).first().click();
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill(name);
  if (description) await dialog.getByRole('textbox', { name: /^설명 \(선택\)/ }).fill(description);
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(dialog.getByRole('heading', { name, level: 3 })).toBeVisible();
}

async function kbCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { __kbCalls: string[] }).__kbCalls.slice());
}

test('빈 상태에서 새 지식베이스를 만들고 설명을 고친다', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { dialog } = await openDialog(page);
  await expect(dialog).toContainText('아직 지식베이스가 없어요.');

  await createBase(dialog, '세포생물학', '세포 구조 교재');
  await expect(dialog.getByRole('paragraph').filter({ hasText: '세포 구조 교재' })).toBeVisible();

  await dialog.getByRole('button', { name: '설명 수정', exact: true }).click();
  await dialog.getByRole('textbox', { name: '설명', exact: true }).fill('세포막과 세포소기관');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByRole('paragraph').filter({ hasText: '세포막과 세포소기관' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('지식베이스를 여러 개 학습에 연결하고 한 개만 해제한다', async ({ page }) => {
  const isMobile = (page.viewportSize()?.width ?? 0) < 768;
  const { main, dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '연결 해제', exact: true })).toBeVisible();
  await expect(main.locator('[data-knowledge-button][data-linked]')).toHaveCount(1);

  await createBase(dialog, '생화학');
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '연결 해제', exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '연결', exact: true })).toBeVisible();
  // 첫 번째 지식베이스는 여전히 연결되어 있다
  await expect(main.locator('[data-knowledge-button][data-linked]')).toHaveCount(1);
  if (!isMobile) {
    await expect(dialog.locator('li').filter({ hasText: '세포생물학' }).getByRole('button', { pressed: true })).toHaveCount(1);
  }
});

test('대화상자를 열면 목록과 최상위 폴더만 불러온다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');
  await dialog.getByRole('button', { name: '파일 선택', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'notes', exact: true })).toBeVisible();

  const calls = await kbCalls(page);
  expect(calls).toContain('list');
  expect(calls).toContain('tree:kbfake0001:');
  // 아직 열지 않은 하위 폴더는 읽지 않는다
  expect(calls).not.toContain('tree:kbfake0001:notes');
});

test('파일 선택으로 넣은 파일은 폴더 단계별로 찾아 보고 미리 본다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');
  await dialog.getByRole('button', { name: '파일 선택', exact: true }).click();

  // 최상위에는 폴더 notes만 보인다
  await expect(dialog.getByRole('button', { name: 'notes', exact: true })).toBeVisible();
  await expect(dialog.locator('[data-entry="notes/intro.md"]')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'notes', exact: true }).click();
  const crumbs = dialog.getByRole('navigation', { name: '폴더 경로' });
  await expect(crumbs.getByRole('button', { name: 'notes', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.locator('[data-entry="notes/intro.md"]')).toBeVisible();

  await dialog.locator('[data-entry="notes/intro.md"] button').first().click();
  await expect(dialog.locator('pre')).toContainText('본문: notes/intro.md');

  await crumbs.getByRole('button', { name: '최상위', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'notes', exact: true })).toBeVisible();
});

test('웹 주소는 http(s)만 받고, 받은 페이지는 links 폴더에 들어간다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');

  const linkInput = dialog.getByRole('textbox', { name: '웹 페이지 주소', exact: true });
  await linkInput.fill('ftp://example.com/cell');
  await dialog.getByRole('button', { name: '가져오기', exact: true }).first().click();
  await expect(dialog.getByRole('alert')).toContainText('http(s) 주소만 쓸 수 있어요.');

  await linkInput.fill('https://example.com/cell');
  await dialog.getByRole('button', { name: '가져오기', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'links', exact: true }).click();
  await expect(dialog.locator('[data-entry="links/cell.md"]')).toBeVisible();
});

test('GitHub는 Clone은 Pull이 있고, ZIP은 출처 배지만 붙는다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');

  const gitInput = dialog.getByRole('textbox', { name: 'GitHub 저장소', exact: true });
  await gitInput.fill('https://github.com/octo/cell');
  await dialog.getByRole('radio', { name: 'Clone (나중에 Pull로 업데이트)', exact: true }).click();
  await dialog.getByRole('button', { name: '가져오기', exact: true }).last().click();

  await dialog.getByRole('button', { name: 'repos', exact: true }).click();
  const cloned = dialog.locator('[data-entry="repos/cell"]');
  await expect(cloned).toContainText('GitHub · Clone');
  await expect(cloned.getByRole('button', { name: 'Pull', exact: true })).toBeVisible();

  await gitInput.fill('https://github.com/octo/zipped');
  await dialog.getByRole('radio', { name: 'ZIP 다운로드 (이력 없음)', exact: true }).click();
  await dialog.getByRole('button', { name: '가져오기', exact: true }).last().click();
  const zipped = dialog.locator('[data-entry="repos/zipped"]');
  await expect(zipped).toContainText('GitHub · ZIP');
  await expect(zipped.getByRole('button', { name: 'Pull', exact: true })).toHaveCount(0);
});

test('저장소를 받지 못하면 오류 안내가 보인다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');
  await dialog.getByRole('textbox', { name: 'GitHub 저장소', exact: true }).fill('https://github.com/octo/broken');
  await dialog.getByRole('button', { name: '가져오기', exact: true }).last().click();
  await expect(dialog.getByRole('alert')).toContainText('저장소를 받지 못했습니다');
});

test('가져오기 진행 중에는 진행률이 보이고 취소하면 사라진다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');
  await dialog.getByRole('textbox', { name: 'GitHub 저장소', exact: true }).fill('https://github.com/octo/slow');
  await dialog.getByRole('button', { name: '가져오기', exact: true }).last().click();

  const progress = dialog.locator('[data-knowledge-progress]');
  await expect(progress.getByRole('progressbar', { name: '가져오기 진행률' })).toBeVisible();
  await progress.getByRole('button', { name: '취소', exact: true }).click();
  await expect(progress).toHaveCount(0);
});

test('폴더 항목은 확인 뒤에 지울 수 있다', async ({ page }) => {
  const { dialog } = await openDialog(page);
  await createBase(dialog, '세포생물학');
  await dialog.getByRole('button', { name: '파일 선택', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'notes', exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: '지우기: notes', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /지울까요/ });
  await confirm.getByRole('button', { name: '지우기', exact: true }).click();
  await expect(dialog.locator('[data-entry="notes"]')).toHaveCount(0);
  await expect(dialog.getByText('이 폴더는 비어 있어요.')).toBeVisible();
});

test('예전 방식으로 연결된 폴더는 읽기 전용이다', async ({ page }) => {
  const { dialog } = await openDialog(page, { legacy: true });
  await dialog.getByRole('button', { name: '상세 보기: 옛 노트', exact: true }).click();
  await expect(dialog.locator('[data-legacy-readonly]')).toContainText('연결 폴더(읽기 전용)');
  await expect(dialog.getByRole('button', { name: '파일 선택', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '지식베이스 지우기', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Pull', exact: true })).toHaveCount(0);
});

test('API가 없는 웹에서는 지식베이스 버튼이 보이지 않는다', async ({ page }) => {
  const main = await start(page);
  await expect(main).toBeVisible();
  await expect(main.locator('[data-knowledge-button]')).toHaveCount(0);
});
