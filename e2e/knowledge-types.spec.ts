import { expect, test, type Page } from '@playwright/test';

/**
 * 지식베이스 만들기 폼과 반응형 상세 화면.
 * 웹 개발 서버에는 데스크톱 bridge가 없으므로 addInitScript가 최소한의 가짜 API(window.__branchKnowledgeFake)를 넣는다.
 * 세부 흐름(추가·폴더 탐색·연결)은 knowledge.spec.ts가 다룬다.
 */
const KEY = 'sk-ant-e2e-ok';

function installMiniFake() {
  const w = window as unknown as { __branchKnowledgeFake: unknown };
  type Base = { id: string; name: string; description?: string; createdAt: number; updatedAt: number; files: Map<string, string> };
  const bases = new Map<string, Base>();
  let seq = 0;
  const info = (b: Base) => ({ id: b.id, name: b.name, description: b.description, createdAt: b.createdAt, updatedAt: b.updatedAt, fileCount: b.files.size, totalBytes: 0 });
  w.__branchKnowledgeFake = {
    onProgress: () => () => {},
    cancel: async () => {},
    list: async () => [...bases.values()].map(info),
    create: async (name: string, opts?: { description?: string }) => {
      const id = `kbmini${String(++seq).padStart(4, '0')}`;
      const b: Base = { id, name, description: opts?.description, createdAt: 0, updatedAt: 0, files: new Map() };
      bases.set(id, b);
      return info(b);
    },
    tree: async () => [],
    pathForFile: () => '',
    addPaths: async () => ({ added: [], skipped: 0 }),
    addFiles: async () => ({ added: [], skipped: 0 }),
    pickFiles: async () => ({ added: [], skipped: 0 }),
    addLink: async () => ({ added: [], skipped: 0 }),
    cloneGit: async () => ({ added: [], skipped: 0 }),
    pullGit: async () => ({ added: [], skipped: 0 }),
    preview: async () => ({ text: null, size: 0, truncated: false }),
    open: async () => {},
  };
}

async function start(page: Page) {
  await page.addInitScript(installMiniFake);
  await page.goto('/?platform=desktop');
  const onboarding = page.getByRole('dialog', { name: '시작하기' });
  await onboarding.getByRole('button', { name: /^API 키/ }).click();
  const input = page.getByLabel('Anthropic API 키');
  await input.fill(KEY);
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('연결됨');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '새 학습 시작' }).click();
  const main = page.locator('[data-panel="main"]');
  await main.locator('[data-knowledge-button]').click();
  const dialog = page.getByRole('dialog', { name: '지식베이스', exact: true });
  await expect(dialog).toBeVisible();
  return { dialog };
}

test('만들기 폼: 이름이 비어 있으면 만들기를 누를 수 없다', async ({ page }) => {
  const { dialog } = await start(page);
  await dialog.getByRole('button', { name: '새 지식베이스' }).first().click();
  const form = dialog.getByRole('region', { name: '새 지식베이스' });
  await expect(form).toBeVisible();
  const submit = form.getByRole('button', { name: '만들기', exact: true });
  await expect(submit).toBeDisabled();

  await form.getByRole('textbox', { name: '이름', exact: true }).fill('   ');
  await expect(submit).toBeDisabled();
});

test('만들기 폼: 이름만 적어도 만들어지고 설명은 비어 있다', async ({ page }) => {
  const { dialog } = await start(page);
  await dialog.getByRole('button', { name: '새 지식베이스' }).first().click();
  const form = dialog.getByRole('region', { name: '새 지식베이스' });
  await form.getByRole('textbox', { name: '이름', exact: true }).fill('미생물 노트');
  await form.getByRole('button', { name: '만들기', exact: true }).click();

  await expect(dialog.getByRole('heading', { name: '미생물 노트', level: 3 })).toBeVisible();
  await expect(dialog.getByText('설명이 없어요.')).toBeVisible();
});

test('반응형: 좁은 화면은 목록으로 돌아가는 버튼만, 넓은 화면은 전체 화면 버튼만 보인다', async ({ page }) => {
  const { dialog } = await start(page);
  await dialog.getByRole('button', { name: '새 지식베이스' }).first().click();
  await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('반응형 노트');
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: '반응형 노트', level: 3 })).toBeVisible();

  const narrow = (page.viewportSize()?.width ?? 0) < 768;
  const back = dialog.getByRole('button', { name: '목록으로', exact: true });
  const full = dialog.getByRole('button', { name: '전체 화면', exact: true });
  if (narrow) {
    await expect(back).toBeVisible();
    await expect(full).toBeHidden();
    await back.click();
    await expect(dialog.getByRole('button', { name: '새 지식베이스' }).first()).toBeVisible();
  } else {
    await expect(back).toBeHidden();
    await expect(full).toBeVisible();
  }
});
