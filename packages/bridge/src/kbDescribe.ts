import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { UploadKind, UploadProfile } from '@branch/core';

/**
 * 업로드 자동 설명을 위한 파일 훑기 (ADR-143). 결과는 core `describeUpload`가 한 줄로 만든다.
 * 넣은 항목만 본다. 항목 수와 읽는 바이트에 상한을 둬서 큰 저장소에서도 금방 끝난다.
 * 숨김 항목(.git 등)과 node_modules는 건너뛰고, 심볼릭 링크는 따라가지 않는다. 파일 내용은 로그에 남기지 않는다.
 */

/** 확장자를 셀 최대 파일 수 */
const MAX_FILES = 5_000;
/** 제목을 읽을 최대 문서 수 */
const MAX_TITLE_READS = 12;
/** 제목·매니페스트를 찾으려고 읽는 앞부분 크기 */
const HEAD_BYTES = 8 * 1024;

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '__pycache__']);
const TITLE_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc']);

async function readHead(abs: string): Promise<string> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, bytesRead);
    return head.includes(0) ? '' : head.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** 마크다운 첫 제목 (없으면 첫 줄) */
export function markdownTitle(text: string): string {
  const lines = text.split(/\r?\n/);
  for (const l of lines) {
    const m = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(l);
    if (m?.[1]) return m[1];
  }
  const first = lines.find((l) => l.trim());
  return first ? first.trim().slice(0, 80) : '';
}

/** README 첫 문단 (제목·배지·HTML 줄 제외) */
function readmeSummary(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) {
      if (out.length) break;
      continue;
    }
    if (/^(#|!\[|\[!\[|<|```|---|===|\|)/.test(l)) {
      if (out.length) break;
      continue;
    }
    out.push(l);
  }
  return out.join(' ').slice(0, 200);
}

/** 폴더 바로 아래의 매니페스트에서 이름·소개를 읽는다 */
async function readManifest(dir: string): Promise<UploadProfile['manifest']> {
  const tryRead = async (name: string) => {
    const st = await lstat(path.join(dir, name)).catch(() => null);
    return st?.isFile() ? readHead(path.join(dir, name)).catch(() => '') : '';
  };
  const pkg = await tryRead('package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { name?: unknown; description?: unknown };
      const name = typeof j.name === 'string' ? j.name : undefined;
      const description = typeof j.description === 'string' && j.description.trim() ? j.description : undefined;
      if (description || name) return { name, description };
    } catch {
      // 8KB보다 큰 package.json은 잘려서 못 읽을 수 있다. README로 넘어간다
    }
  }
  for (const f of ['pyproject.toml', 'Cargo.toml']) {
    const txt = await tryRead(f);
    const d = /^\s*description\s*=\s*"([^"]+)"/m.exec(txt)?.[1];
    if (d) return { name: /^\s*name\s*=\s*"([^"]+)"/m.exec(txt)?.[1], description: d };
  }
  for (const f of ['README.md', 'readme.md', 'README.markdown', 'README.rst', 'README.txt', 'README']) {
    const txt = await tryRead(f);
    if (!txt) continue;
    const d = readmeSummary(txt);
    const name = markdownTitle(txt);
    if (d || name) return { name: name || undefined, description: d || undefined };
  }
  return undefined;
}

const extOf = (name: string) => {
  const e = path.extname(name).slice(1).toLowerCase();
  return e.length <= 10 ? e : '';
};

/**
 * 넣은 항목들(`base` 기준 상대 경로)을 훑어 업로드 요약을 만든다.
 * names를 주면 최상위 이름 대신 쓴다 (웹 페이지 제목 등).
 */
export async function profileUpload(base: string, rels: string[], kind: UploadKind, names?: string[]): Promise<UploadProfile> {
  const profile: UploadProfile = { kind, names: names ?? rels.map((r) => r.split('/').pop() ?? r), fileCount: 0, exts: {}, titles: [] };
  let titleReads = 0;
  const visitFile = async (abs: string, name: string) => {
    profile.fileCount++;
    const ext = extOf(name);
    profile.exts[ext] = (profile.exts[ext] ?? 0) + 1;
    if (TITLE_EXT.has(ext) && titleReads < MAX_TITLE_READS && !/^readme/i.test(name)) {
      titleReads++;
      const title = markdownTitle(await readHead(abs).catch(() => ''));
      if (title) profile.titles.push(title);
    }
  };
  for (const rel of rels) {
    const abs = path.join(base, ...rel.split('/'));
    const st = await lstat(abs).catch(() => null);
    if (!st) continue;
    if (st.isFile()) {
      await visitFile(abs, path.basename(abs));
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!profile.manifest) profile.manifest = await readManifest(abs);
    // 너비 우선: 위쪽 폴더의 문서 제목이 먼저 잡힌다
    const queue = [abs];
    while (queue.length && profile.fileCount < MAX_FILES) {
      const dir = queue.shift() as string;
      const items = await readdir(dir, { withFileTypes: true }).catch(() => []);
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const it of items) {
        if (it.name.startsWith('.') || it.isSymbolicLink()) continue;
        const p = path.join(dir, it.name);
        if (it.isDirectory()) {
          if (!SKIP_DIRS.has(it.name)) queue.push(p);
        } else if (it.isFile()) {
          await visitFile(p, it.name);
          if (profile.fileCount >= MAX_FILES) break;
        }
      }
    }
  }
  return profile;
}
