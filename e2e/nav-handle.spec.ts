import { expect, test } from '@playwright/test';

/** 모바일 세션 내비게이션 핸들: 끌어서 좌·우 가장자리에 붙이고, 숨기기/다시 보이기 (ADR-056) */
test('내비게이션 핸들: 가운데에 놓으면 가까운 쪽에 붙고, 숨기면 헤더 버튼으로 복원', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', '핸들은 모바일 전용');
  await page.goto('/#scenario=home');
  const main = page.locator('[data-panel="main"]');
  const toolbar = main.getByRole('toolbar', { name: '질문 이동' });
  const handle = toolbar.locator('[data-nav-handle]');
  await expect(toolbar).toHaveAttribute('data-nav-dock', 'right');

  // 화면 가운데보다 약간 왼쪽, 위쪽에 놓는다 → 왼쪽 가장자리에 붙는다
  const box = (await handle.boundingBox())!;
  const vw = page.viewportSize()!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(vw / 2 - 20, 200, { steps: 8 });
  await page.mouse.up();
  await expect(toolbar).toHaveAttribute('data-nav-dock', 'left');
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await expect.poll(async () => (await toolbar.boundingBox())!.x).toBeLessThan(20);
  expect((await toolbar.boundingBox())!.y).toBeLessThan(300);
  await page.screenshot({ path: `test-results/nav-handle-left.png` });

  // 새로고침 후에도 위치 유지
  await page.reload();
  await expect(toolbar).toHaveAttribute('data-nav-dock', 'left');

  // 핸들을 누르면 숨기기 메뉴 → 숨기면 헤더의 내비게이션 버튼으로 복원
  await handle.click();
  await page.getByRole('menuitem', { name: '숨기기' }).click();
  await expect(toolbar).toHaveCount(0);
  const restore = main.getByRole('button', { name: '내비게이션 보이기' });
  await expect(restore).toBeVisible();
  await page.screenshot({ path: `test-results/nav-handle-hidden.png` });
  await restore.click();
  await expect(toolbar).toBeVisible();
  await expect(restore).toHaveCount(0);
});

/** PC 세션 내비게이션 핸들: 모바일과 같은 끌기·숨기기, 위치는 따로 저장 (ADR-146) */
test('PC 내비게이션 핸들: 왼쪽에 붙이면 목차가 화면 안에서 열리고, 숨겨도 레일은 남는다', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'PC 전용');
  await page.goto('/#scenario=home');
  const main = page.locator('[data-panel="main"]');
  const toolbar = main.getByRole('toolbar', { name: '질문 이동' });
  const handle = toolbar.locator('[data-nav-handle]');
  await expect(toolbar).toHaveAttribute('data-nav-dock', 'right');
  const panelBox = (await main.boundingBox())!;
  // 기본 위치: 오른쪽 아래
  const start = (await toolbar.boundingBox())!;
  expect(start.x + start.width).toBeGreaterThan(panelBox.x + panelBox.width - 80);
  expect(start.y + start.height).toBeGreaterThan(panelBox.y + panelBox.height - 300);

  // 가운데보다 약간 왼쪽·위로 끌어 놓으면 왼쪽 가장자리에 붙는다 (본문 글자는 선택되지 않는다)
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(panelBox.x + panelBox.width / 2 - 40, panelBox.y + 220, { steps: 10 });
  await page.mouse.up();
  await expect(toolbar).toHaveAttribute('data-nav-dock', 'left');
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
  await expect.poll(async () => (await toolbar.boundingBox())!.x - panelBox.x).toBeLessThan(20);
  expect((await toolbar.boundingBox())!.y).toBeLessThan(panelBox.y + 320);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('branch.navDock.desktop') ?? '{}').side)).toBe('left');
  // 모바일 위치는 그대로
  expect(await page.evaluate(() => localStorage.getItem('branch.navDock'))).toBeNull();

  // 목차는 툴바 옆, 화면 안에서 열린다
  await toolbar.getByRole('button', { name: '대화 목차', exact: true }).click();
  const toc = page.getByRole('dialog', { name: '대화 목차' });
  await expect(toc).toBeVisible();
  const tocBox = (await toc.boundingBox())!;
  expect(tocBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(tocBox.x).toBeGreaterThan((await toolbar.boundingBox())!.x + 20);
  await page.screenshot({ path: `test-results/nav-handle-pc-left.png` });
  await page.keyboard.press('Escape');

  // 새로고침 후에도 위치 유지
  await page.reload();
  await expect(toolbar).toHaveAttribute('data-nav-dock', 'left');

  // 핸들 클릭 → 숨기기. 우측 레일은 남고, 헤더 버튼으로 복원
  const railCount = await main.locator('[data-turn-rail]').count();
  await handle.click();
  await page.getByRole('menuitem', { name: '숨기기' }).click();
  await expect(toolbar).toHaveCount(0);
  await expect(main.locator('[data-turn-rail]')).toHaveCount(railCount);
  const restore = main.getByRole('button', { name: '내비게이션 보이기' });
  await expect(restore).toBeVisible();
  await page.screenshot({ path: `test-results/nav-handle-pc-hidden.png` });
  await restore.click();
  await expect(toolbar).toBeVisible();
  await expect(restore).toHaveCount(0);

  // 키보드: 핸들에서 Enter → 메뉴, Esc → 닫힘
  await handle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: '숨기기' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: '숨기기' })).toHaveCount(0);
});
