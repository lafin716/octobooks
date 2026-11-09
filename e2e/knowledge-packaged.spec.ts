import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * 패키지 앱 지식베이스 Smoke. 실제 IPC·파일 저장소를 쓰고, 네이티브 파일 대화상자와 모델 목록 응답만 대체한다.
 * 패키징 후 실행: `RHYMEBOOK_PACKAGED=1 pnpm exec playwright test e2e/knowledge-packaged.spec.ts --project=desktop`
 * macOS 기본 경로: apps/desktop/release/mac-arm64/OctoBooks.app (RHYMEBOOK_EXE로 바꿀 수 있다).
 */

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const KB_NAME = '쿠버네티스 문서';
const KB_DESC = '클러스터 네트워킹 정리';

async function mockModels(page: Page) {
  await page.route('**/v1/models**', (route) => route.fulfill({ contentType: 'application/json', body: '{"data":[]}', headers: CORS }));
}

async function launch(userData: string) {
  const exe = process.env.RHYMEBOOK_EXE ?? 'apps/desktop/release/mac-arm64/OctoBooks.app/Contents/MacOS/OctoBooks';
  const app = await _electron.launch({ executablePath: path.resolve(exe), env: { ...process.env, BRANCH_USER_DATA: userData } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { app, page, errors };
}

/** 네이티브 파일 대화상자만 대체한다. 다음 호출부터 지정한 경로를 고른 것처럼 돌려준다. */
async function stubPicker(app: ElectronApplication, files: string[]) {
  await app.evaluate(({ dialog }, list) => {
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: list });
  }, files);
}

async function useApiProvider(page: Page) {
  const onboarding = page.getByRole('dialog', { name: '시작하기' });
  if (await onboarding.isVisible().catch(() => false)) {
    await onboarding.getByRole('button', { name: /^API 키/ }).click();
  } else {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '설정', exact: true }).click();
  }
  await page.getByLabel('Anthropic API 키').fill('sk-ant-e2e-ok');
  await page.getByLabel('Anthropic API 키').press('Enter');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  if (await settings.isVisible().catch(() => false)) {
    await settings.getByRole('tab', { name: '일반' }).click();
    await settings.locator('select:has(option[value="anthropic-api"])').selectOption('anthropic-api');
  }
  await page.keyboard.press('Escape');
}

test('패키지 앱: 지식베이스 생성·파일/폴더 추가·재시작 후 유지', async ({ browserName }, testInfo) => {
  test.skip(process.env.RHYMEBOOK_PACKAGED !== '1' || testInfo.project.name !== 'desktop' || browserName !== 'chromium', '패키징 후 RHYMEBOOK_PACKAGED=1로 실행');
  test.setTimeout(180_000);

  const root = await mkdtemp(path.join(os.tmpdir(), 'octobooks-kb-smoke-'));
  const userData = path.join(root, 'userData');
  const src = path.join(root, 'src');
  const folder = path.join(src, 'guides');
  await mkdir(folder, { recursive: true });
  const note = path.join(src, 'networking.md');
  await writeFile(note, '# Cluster Networking\n\nEvery Pod gets its own IP address.\n');
  await writeFile(path.join(folder, 'ipam.md'), '# IPAM\n\nThe CNI plugin assigns Pod IPs.\n');

  // ── 1회차: 생성 · 파일 추가 · 폴더 추가 ──
  let { app, page, errors } = await launch(userData);
  try {
    await mockModels(page);
    await page.reload();
    await expect(page.locator('#root')).not.toBeEmpty();
    await useApiProvider(page);
    await page.getByRole('button', { name: '새 학습 시작' }).click();
    const main = page.locator('[data-panel="main"]');

    await main.locator('[data-knowledge-button]').click();
    const dialog = page.getByRole('dialog', { name: '지식베이스', exact: true });
    await dialog.getByRole('button', { name: '새 지식베이스' }).first().click();
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill(KB_NAME);
    await dialog.getByRole('textbox', { name: /^설명 \(선택\)/ }).fill(KB_DESC);
    await dialog.getByRole('button', { name: '만들기', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: KB_NAME, level: 3 })).toBeVisible();
    await expect(dialog.getByRole('paragraph').filter({ hasText: KB_DESC })).toBeVisible();

    await stubPicker(app, [note]);
    await dialog.getByRole('button', { name: '파일 선택', exact: true }).click();
    await expect(dialog.locator('[data-entry="networking.md"]')).toBeVisible({ timeout: 20_000 });

    await stubPicker(app, [folder]);
    await dialog.getByRole('button', { name: '파일 선택', exact: true }).click();
    await expect(dialog.locator('[data-entry="guides"]')).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'guides', exact: true }).click();
    await expect(dialog.locator('[data-entry="guides/ipam.md"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('kb-added.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }

  // ── 2회차: 재시작 후 지식베이스와 폴더 구조가 남아 있다 ──
  ({ app, page, errors } = await launch(userData));
  try {
    await mockModels(page);
    await page.reload();
    await expect(page.locator('#root')).not.toBeEmpty();
    if (await page.getByRole('dialog', { name: '시작하기' }).isVisible().catch(() => false)) await page.keyboard.press('Escape');
    // 재시작하면 마지막 학습이 복원된다. 복원되지 않았을 때만 새 학습을 연다.
    const main = page.locator('[data-panel="main"]');
    const start = page.getByRole('button', { name: '새 학습 시작' });
    await expect(main.or(start).first()).toBeVisible();
    if (!(await main.isVisible().catch(() => false))) await start.click();

    await main.locator('[data-knowledge-button]').click();
    const dialog = page.getByRole('dialog', { name: '지식베이스', exact: true });
    const back = dialog.getByRole('button', { name: '목록으로', exact: true });
    if (await back.isVisible().catch(() => false)) await back.click();
    await dialog.getByRole('button', { name: `상세 보기: ${KB_NAME}`, exact: true }).click();
    await expect(dialog.getByRole('paragraph').filter({ hasText: KB_DESC })).toBeVisible();
    await expect(dialog.locator('[data-entry="networking.md"]')).toBeVisible();
    await dialog.getByRole('button', { name: 'guides', exact: true }).click();
    await expect(dialog.locator('[data-entry="guides/ipam.md"]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('kb-restarted.png') });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
