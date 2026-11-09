/**
 * PDF 본문 텍스트 추출과 캐시 (ADR-140). pdfjs-dist legacy 빌드를 Node에서 쓰고, 렌더링·폰트 로딩은 하지 않는다.
 * 캐시는 지식베이스 폴더 안 cache/text/<sha1(상대경로)>.txt 에 둔다. 원본 파일의 크기·수정 시각이 바뀌면 다시 만든다.
 * 원본 PDF(연결 폴더 포함)는 절대 쓰지 않는다.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
  cleanup?(): void;
}

interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfJsModule {
  getDocument(src: Record<string, unknown>): PdfLoadingTask;
}

/** 한 PDF에서 읽는 최대 쪽 수 */
export const PDF_MAX_PAGES = 2000;
/** 텍스트 추출을 시도하는 PDF 크기 상한 */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;

const DEFAULT_SPECIFIER = 'pdfjs-dist/legacy/build/pdf.mjs';

let cached: Promise<PdfJsModule> | null = null;

async function loadPdfJs(): Promise<PdfJsModule> {
  if (!cached) {
    cached = import(DEFAULT_SPECIFIER).then((m: unknown) => {
      const mod = m as { getDocument?: unknown; default?: PdfJsModule };
      return typeof mod.getDocument === 'function' ? (mod as PdfJsModule) : (mod.default as PdfJsModule);
    });
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/** 페이지별 텍스트 배열을 돌려준다 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    const n = Math.min(doc.numPages, PDF_MAX_PAGES);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => {
          const item = it as PdfTextItem;
          if (typeof item.str !== 'string') return '';
          return item.str + (item.hasEOL ? '\n' : ' ');
        })
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
      pages.push(text);
      page.cleanup?.();
    }
    return pages;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** 캐시 파일 경로 (상대 경로의 sha1) */
export function pdfCachePath(cacheDir: string, rel: string): string {
  return path.join(cacheDir, `${createHash('sha1').update(rel).digest('hex')}.txt`);
}

/**
 * PDF 본문 텍스트. 캐시가 원본의 크기·수정 시각과 맞으면 그대로 쓰고, 아니면 추출해서 캐시를 갱신한다.
 * 추출에 실패하거나 글자가 없으면 null (호출부는 바이너리로 취급).
 */
export async function pdfTextFor(absPdf: string, rel: string, cacheDir: string, bytes?: Uint8Array): Promise<string | null> {
  const st = await stat(absPdf).catch(() => undefined);
  if (!st || st.size > PDF_MAX_BYTES) return null;
  const header = `#pdf-cache ${st.size} ${Math.floor(st.mtimeMs)}\n`;
  const file = pdfCachePath(cacheDir, rel);
  const prev = await readFile(file, 'utf8').catch(() => undefined);
  if (prev !== undefined && prev.startsWith(header)) return prev.slice(header.length);
  let pages: string[];
  try {
    pages = await extractPdfPages(bytes ?? (await readFile(absPdf)));
  } catch {
    return null;
  }
  const text = pages
    .map((p, i) => (p ? `[${i + 1}쪽]\n${p}` : ''))
    .filter((p) => p !== '')
    .join('\n\n');
  if (!text) return null;
  // 캐시 쓰기는 실패해도 결과에는 영향이 없다 (tmp 후 rename으로 반쯤 쓴 파일을 남기지 않는다)
  try {
    await mkdir(cacheDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, header + text, 'utf8');
    await rename(tmp, file);
  } catch {
    /* 캐시 실패는 무시 */
  }
  return text;
}

