import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// pdfjs 대신 가짜 문서를 준다: 쪽별 텍스트와 호출 횟수, 실패 여부를 테스트가 정한다
const pdf = vi.hoisted(() => ({
  pages: [] as string[],
  fail: false,
  calls: 0,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => {
    pdf.calls++;
    const promise = pdf.fail
      ? Promise.reject(new Error('invalid pdf'))
      : Promise.resolve({
          numPages: pdf.pages.length,
          getPage: async (n: number) => ({
            getTextContent: async () => ({ items: [{ str: pdf.pages[n - 1], hasEOL: false }] }),
          }),
        });
    return { promise, destroy: async () => undefined };
  },
}));

import { pdfCachePath, pdfTextFor } from '../src/kbTools/text';

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** 캐시 머리말: 원본 크기와 수정 시각 (text.ts와 같은 형식) */
function headerOf(st: { size: number; mtimeMs: number }): string {
  return `#pdf-cache ${st.size} ${Math.floor(st.mtimeMs)}\n`;
}

describe('pdfCachePath — 캐시 위치', () => {
  it('같은 상대 경로는 같은 파일, 다른 경로는 다른 파일이다', () => {
    const a = pdfCachePath('/kb/cache/text', 'docs/a.pdf');
    expect(pdfCachePath('/kb/cache/text', 'docs/a.pdf')).toBe(a);
    expect(pdfCachePath('/kb/cache/text', 'docs/b.pdf')).not.toBe(a);
  });

  it('cache/text 아래 sha1 이름의 .txt 파일이다 (원래 파일 이름은 드러나지 않는다)', () => {
    const p = pdfCachePath('/kb/cache/text', 'secret/plan.pdf');
    expect(path.dirname(p)).toBe('/kb/cache/text');
    expect(path.basename(p)).toMatch(/^[0-9a-f]{40}\.txt$/);
    expect(p).not.toContain('plan');
  });
});

describe('pdfTextFor — PDF 본문과 캐시', () => {
  let dir: string;
  let pdfPath: string;
  let cacheDir: string;
  const rel = 'docs/lecture.pdf';

  beforeEach(async () => {
    dir = await tmp('kb-pdf-');
    pdfPath = path.join(dir, 'lecture.pdf');
    cacheDir = path.join(dir, 'cache', 'text');
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 fake body'));
    // 수정 시각을 고정해 캐시 머리말을 예측 가능하게 한다
    await utimes(pdfPath, 1_700_000_000, 1_700_000_000);
    pdf.pages = ['첫 쪽 본문', '둘째 쪽 본문'];
    pdf.fail = false;
    pdf.calls = 0;
  });

  it('처음 읽으면 쪽 표시와 함께 텍스트를 돌려주고 캐시를 만든다', async () => {
    const text = await pdfTextFor(pdfPath, rel, cacheDir);
    expect(text).toBe('[1쪽]\n첫 쪽 본문\n\n[2쪽]\n둘째 쪽 본문');
    expect(pdf.calls).toBe(1);
    const cached = await readFile(pdfCachePath(cacheDir, rel), 'utf8');
    expect(cached.startsWith(headerOf(await stat(pdfPath)))).toBe(true);
  });

  it('원본이 그대로면 캐시를 쓰고 추출하지 않는다', async () => {
    await pdfTextFor(pdfPath, rel, cacheDir);
    pdf.pages = ['바뀐 내용은 무시된다'];
    const again = await pdfTextFor(pdfPath, rel, cacheDir);
    expect(again).toBe('[1쪽]\n첫 쪽 본문\n\n[2쪽]\n둘째 쪽 본문');
    expect(pdf.calls).toBe(1);
  });

  it('수정 시각이 바뀌면 캐시를 버리고 다시 추출해 캐시를 갱신한다', async () => {
    await pdfTextFor(pdfPath, rel, cacheDir);
    await utimes(pdfPath, 1_800_000_000, 1_800_000_000);
    pdf.pages = ['새 본문'];
    const text = await pdfTextFor(pdfPath, rel, cacheDir);
    expect(text).toBe('[1쪽]\n새 본문');
    expect(pdf.calls).toBe(2);
    const cached = await readFile(pdfCachePath(cacheDir, rel), 'utf8');
    expect(cached.startsWith(headerOf(await stat(pdfPath)))).toBe(true);
  });

  it('크기가 바뀌면 캐시를 버린다', async () => {
    await pdfTextFor(pdfPath, rel, cacheDir);
    await writeFile(pdfPath, Buffer.from('%PDF-1.4 longer fake body than before'));
    await utimes(pdfPath, 1_700_000_000, 1_700_000_000);
    pdf.pages = ['길어진 파일'];
    expect(await pdfTextFor(pdfPath, rel, cacheDir)).toBe('[1쪽]\n길어진 파일');
  });

  it('직접 쓴 캐시 머리말이 맞으면 그 본문을 그대로 쓴다', async () => {
    await mkdir(cacheDir, { recursive: true });
    const st = await stat(pdfPath);
    await writeFile(pdfCachePath(cacheDir, rel), headerOf(st) + '캐시에서 온 본문');
    expect(await pdfTextFor(pdfPath, rel, cacheDir)).toBe('캐시에서 온 본문');
    expect(pdf.calls).toBe(0);
  });

  it('추출이 실패하면 null을 돌려주고 캐시를 만들지 않는다', async () => {
    pdf.fail = true;
    expect(await pdfTextFor(pdfPath, rel, cacheDir)).toBeNull();
    await expect(readFile(pdfCachePath(cacheDir, rel), 'utf8')).rejects.toThrow();
  });

  it('글자가 하나도 없으면 null이다 (바이너리로 취급)', async () => {
    pdf.pages = ['', ''];
    expect(await pdfTextFor(pdfPath, rel, cacheDir)).toBeNull();
  });

  it('없는 파일은 null이다', async () => {
    expect(await pdfTextFor(path.join(dir, 'none.pdf'), 'none.pdf', cacheDir)).toBeNull();
  });

  it('미리 읽은 바이트를 넘기면 파일을 다시 읽지 않고 그 바이트로 추출한다', async () => {
    const text = await pdfTextFor(pdfPath, rel, cacheDir, new Uint8Array([1, 2, 3]));
    expect(text).toContain('첫 쪽 본문');
  });
});
