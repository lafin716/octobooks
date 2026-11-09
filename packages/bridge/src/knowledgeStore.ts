import { spawn, type ChildProcess } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsc } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LinkBlockedError, pinnedGet } from './linkFetch';
import { measureLinked } from './knowledgeFolder';
import { filesRootOf } from './knowledgeMeta';
import { parseTarGz, TarFormatError } from './tarExtract';
import {
  KNOWLEDGE_ID_RE,
  KNOWLEDGE_LIMITS,
  cleanKnowledgeName,
  isGitImportMode,
  isKnowledgeId,
  isKnowledgePath,
  isKnowledgeLinkUrl,
  newId,
  parseGitHubRepo,
  parseGitProgress,
  t,
  type GitImportMode,
  type KnowledgeAddResult,
  type KnowledgeBase,
  type KnowledgeCreateOptions,
  type KnowledgeEntry,
  type KnowledgePreview,
  type KnowledgeProgress,
  type KnowledgeSource,
  type MessageKey,
} from '@branch/core';

/**
 * 학습별 지식베이스 파일 저장소 `<root>/<id>/` (ADR-107, ADR-136).
 * 구조: `<root>/<id>/meta.json`, `<root>/<id>/files/` (사용자가 보는 트리 전체).
 * files/ 안에 links/(웹 페이지 마크다운), repos/<repo>/(GitHub 클론·ZIP)이 놓인다.
 * 지식베이스 유형과 벡터 색인은 없다. 모든 지식베이스는 폴더를 Agentic 도구로 탐색한다.
 * 구버전 연결 폴더(linkedPath)는 읽기 전용으로 탐색만 한다.
 * 렌더러가 보낸 값은 믿지 않는다: id·상대 경로·이름·크기를 여기서 다시 확인하고,
 * 모든 경로 조각을 lstat으로 확인해 심볼릭 링크는 따라가지도, 쓰지도 않는다.
 * 숨김 항목(`.`으로 시작)과 .git은 목록·복사에서 건너뛴다. 파일 내용은 로그에 남기지 않는다.
 */

/** 숨김·.git·심볼릭 링크처럼 건너뛰는 항목 */
const isHidden = (name: string) => name.startsWith('.');

/** Windows 예약 장치 이름·끝의 점/공백, 금지 문자 */
const WIN_BAD_SEGMENT_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$|[. ]$/i;
// eslint-disable-next-line no-control-regex -- 제어 문자 차단이 목적
const WIN_BAD_CHARS_RE = /[<>:"|?*\\/]|[\u0000-\u001f]/;

/** 링크 본문 최대 크기 (바이트) */
const HTML_MAX_BYTES = 5 * 1024 * 1024;
/** 링크·압축 파일 가져오기 제한 시간 */
const FETCH_TIMEOUT_MS = 15_000;
/** ZIP(tar.gz) 내려받기 제한 시간 (큰 저장소를 고려해 길게) */
const ARCHIVE_TIMEOUT_MS = 5 * 60_000;
/** ZIP(tar.gz) 내려받기 최대 크기 (압축된 상태) */
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
/** ZIP을 풀 때 항목 수 상한 (디렉터리 포함) */
const ARCHIVE_MAX_ENTRIES = 50_000;
/** 클론 전체 제한 시간 (진행 중이어도 이 시간을 넘으면 멈춘다) */
const CLONE_TIMEOUT_MS = 10 * 60_000;
/** 클론 중 임시 폴더 크기를 재는 간격 */
const CLONE_WATCH_MS = 2_000;
/** 클론이 이 시간 동안 아무 출력이 없으면 멈춘 것으로 본다 */
const CLONE_IDLE_MS = 60_000;
/** 클론 종료 후 stderr가 닫히길 기다리는 최대 시간 (손자 프로세스가 붙잡고 있을 수 있다) */
const CLONE_CLOSE_GRACE_MS = 500;
/** 한 번에 훑을 항목 수 상한 (큰 폴더에서 멈추지 않게) */
const WALK_MAX_ENTRIES = 20_000;
/** 미리보기로 읽을 최대 바이트 (문자 수 * 4) */
const PREVIEW_READ_BYTES = KNOWLEDGE_LIMITS.previewChars * 4;
/** 추가·클론 전에 남아 있어야 하는 여유 공간 */
const MIN_FREE_FOR_ADD = 100 * 1024 * 1024;
/** 링크 리디렉션 최대 횟수 */
const MAX_REDIRECTS = 5;
/** 설명 최대 길이 */
const DESCRIPTION_MAX = 500;

/** 이 모듈에서 쓰는 오류 (메시지는 한국어로 렌더러에 그대로 보인다) */
function fail(message: string): never {
  throw new Error(message);
}

/** 두 신호 중 하나라도 중단되면 중단되는 신호를 만든다 (AbortSignal.any 대체: 대상 lib에 없음) */
function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const c = new AbortController();
  const abort = (): void => c.abort();
  if (a.aborted || b.aborted) c.abort();
  else {
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
  }
  return c.signal;
}

/** 지식베이스가 없을 때의 오류 (채팅은 이 경우 지식베이스 없이 답한다) */
export class KnowledgeNotFoundError extends Error {}

/** 경로 조각 하나가 안전한지: 빈 값·점·숨김·Windows 예약 이름·금지 문자 금지 */
export function isSafeSegment(s: string): boolean {
  return (
    s.length > 0 &&
    s.length <= 255 &&
    s !== '.' &&
    s !== '..' &&
    !isHidden(s) &&
    !WIN_BAD_SEGMENT_RE.test(s) &&
    !WIN_BAD_CHARS_RE.test(s)
  );
}

/** 제목·호스트명에서 파일 이름을 만든다 (안전한 문자만, 최대 60자) */
export function slugify(raw: string): string {
  const s = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\\/\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return s && isSafeSegment(s) ? s : 'page';
}

/** 지식베이스 id를 확인해 돌려준다. 잘못되면 throw */
export function checkId(id: unknown): string {
  if (!isKnowledgeId(id) || !KNOWLEDGE_ID_RE.test(id)) fail(t('bridge.knowledge.badId'));
  return id;
}

/** files/ 기준 상대 경로를 조각으로 나눈다. 빈 값은 [] (루트). 잘못되면 throw */
function splitRel(rel: string | undefined | null): string[] {
  if (rel === undefined || rel === null || rel === '') return [];
  if (!isKnowledgePath(rel)) fail(t('bridge.knowledge.badPath'));
  const segs = rel.split('/');
  if (!segs.every(isSafeSegment)) fail(t('bridge.knowledge.badPath'));
  return segs;
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

/** 이름이 겹치면 `이름 (2).ext`처럼 바꾼 이름을 고른다 */
async function uniqueName(dir: string, name: string): Promise<string> {
  if (!(await lstatOrNull(path.join(dir, name)))) return name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!(await lstatOrNull(path.join(dir, cand)))) return cand;
  }
  return fail(t('bridge.knowledge.nameTaken', { name }));
}

/** 사설·내부 주소인지 (문자열 검사만: localhost, 루프백, 사설 IPv4, 링크 로컬, 사설 IPv6) */
export function isPrivateHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::' || h === '::1' || h === '0.0.0.0') return true;
  // IPv4 대응 IPv6: URL은 [::ffff:127.0.0.1]을 [::ffff:7f00:1]로 바꿔 쓴다 → 점 표기로 되돌려 다시 본다
  const mapped = /^(?:0{0,4}:){0,5}(?:ffff:)?(?:0{1,4}:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped && h.startsWith('::') && (h.startsWith('::ffff:') || /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(h))) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
  // NAT64(64:ff9b::/96)도 내부 주소로 본다
  if (h.startsWith('64:ff9b:')) return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return h.includes(':');
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&amp;/gi, '&');

function safeChar(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

/** HTML 문서의 제목 (없으면 빈 문자열) */
export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(stripTags(m[1] ?? '')).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

/**
 * HTML을 읽을 수 있는 마크다운 텍스트로 바꾼다 (외부 라이브러리 없이 간단히).
 * script·style 등 실행·장식 블록은 버리고, 제목·목록·링크만 살린다.
 */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|noscript|svg|template|head|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(script|style|head)\b[^>]*>/gi, '');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n: string, inner: string) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
    return text ? `\n\n${'#'.repeat(Number(n))} ${text}\n\n` : '\n';
  });
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href: string, inner: string) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
    return text ? `[${text}](${decodeEntities(href)})` : '';
  });
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/?(p|div|section|article|tr|ul|ol|pre|blockquote|table|header|footer|main|nav|br|hr|dt|dd|figure|figcaption)\b[^>]*>/gi, '\n');
  s = decodeEntities(stripTags(s));
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 얕은 클론 공통 git 하드닝 (ADR-138): 심볼릭 링크를 만들지 않고, 자격 증명 도우미·훅·fsmonitor를 쓰지 않는다 */
export const GIT_HARDEN_ARGS: readonly string[] = [
  '-c',
  'core.symlinks=false',
  // 자격 증명 도우미(키체인·GCM 창)를 부르지 않는다: 공개 저장소만 받는다
  '-c',
  'credential.helper=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];

/** 얕은 클론 인자 (shell 없이 spawn한다). .git은 남겨 두어 나중에 pull할 수 있게 한다 (ADR-138) */
export function gitCloneArgs(url: string, dest: string): string[] {
  return [...GIT_HARDEN_ARGS, 'clone', '--depth', '1', '--single-branch', '--no-tags', '--progress', '--', url, dest];
}

/** 얕은 클론 갱신 인자: 빨리 감기만 허용한다 (ADR-138) */
export function gitPullArgs(): string[] {
  return [...GIT_HARDEN_ARGS, 'pull', '--ff-only', '--depth', '1'];
}

/** 가져오기 진행 알림·취소 (main이 렌더러 창마다 하나씩 만든다) */
export interface KnowledgeTaskControl {
  onProgress?: (p: KnowledgeProgress) => void;
  signal?: AbortSignal;
}

const cancelledError = () => new Error(t('bridge.knowledge.cancelled'));

/** git stderr 메시지 중 보여줄 한 줄: fatal/error 줄 → 마지막 줄 → 종료 코드 */
export function gitErrorLine(messages: string[], code: number | null): string {
  const pick =
    messages.find((l) => /^fatal:/i.test(l)) ?? messages.find((l) => /^error:/i.test(l)) ?? messages.filter((l) => !/^Cloning into\b/.test(l)).pop();
  return (pick ?? `exit ${code ?? '?'}`).replace(/^(fatal|error):\s*/i, '');
}

export interface KnowledgeStoreOptions {
  /** 지식베이스 루트 폴더 (`<userData>/knowledge`) */
  root: string;
  /** 링크·ZIP 가져오기용 fetch (테스트에서 바꾼다) */
  fetch?: typeof fetch;
  /** git 실행 환경 (PATH 등). 기본은 process.env */
  env?: NodeJS.ProcessEnv;
  /**
   * 호스트 이름의 모든 주소 (링크가 사설 주소로 풀리는지 확인).
   * 기본은 DNS 조회. fetch를 바꾼 테스트에서는 조회하지 않는다.
   */
  lookup?: (hostname: string) => Promise<string[]>;
  /** git 실행 파일 (테스트에서 가짜 git으로 바꾼다). 기본 'git' */
  gitBin?: string;
  /** 클론 무응답·전체 제한 시간 (테스트용) */
  cloneIdleMs?: number;
  cloneTimeoutMs?: number;
  /** 클론 중 임시 폴더 크기를 재는 간격 (테스트용, 기본 2초) */
  cloneWatchMs?: number;
}

/** 링크 응답 한 개 (주입 fetch와 연결 검사 요청을 같은 모양으로 맞춘다) */
interface LinkPage {
  status: number;
  url: string;
  headers: Headers;
  read(maxBytes: number): Promise<Uint8Array | null>;
}

const dnsLookupAll = async (hostname: string): Promise<string[]> =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface KnowledgeStore {
  /** 지식베이스 목록. 파일을 훑지 않는다 — 개수·크기 캐시가 없으면 statsPending으로 돌려주고 뒤에서 잰다 (ADR-126) */
  list(): Promise<KnowledgeBase[]>;
  /** 개수·크기 캐시가 없는 지식베이스를 미리 잰다 (앱 시작 뒤 한가할 때). 하나씩, 끝나면 resolve */
  warmStats(): Promise<void>;
  /** 새 지식베이스 (유형 없음, ADR-136) */
  create(name: string, opts?: KnowledgeCreateOptions): Promise<KnowledgeBase>;
  rename(id: string, name: string): Promise<KnowledgeBase>;
  remove(id: string): Promise<void>;
  /**
   * 폴더 한 단계의 항목 (ADR-139). dir은 필수이며 '' = 최상위.
   * 바로 아래 항목만 읽고(폴더 먼저, 이름순), 출처 기록과 맞는 항목에는 source를 붙인다.
   */
  tree(id: string, dir: string): Promise<KnowledgeEntry[]>;
  addPaths(id: string, paths: string[], dest?: string, ctl?: KnowledgeTaskControl): Promise<KnowledgeAddResult>;
  addFiles(
    id: string,
    files: { name: string; data: Uint8Array }[],
    dest?: string,
    ctl?: KnowledgeTaskControl,
  ): Promise<KnowledgeAddResult>;
  addLink(id: string, url: string, ctl?: KnowledgeTaskControl): Promise<KnowledgeAddResult>;
  /** GitHub 가져오기 (ADR-138). clone = .git 유지(pull 가능), zip = tar.gz 내려받아 풀기 (기본 clone) */
  cloneGit(id: string, url: string, opts?: { mode?: GitImportMode }, ctl?: KnowledgeTaskControl): Promise<KnowledgeAddResult>;
  /** clone으로 가져온 저장소를 빨리 감기로 갱신한다 (ADR-138). 다른 방식이면 throw */
  pullGit(id: string, relPath: string, ctl?: KnowledgeTaskControl): Promise<KnowledgeAddResult>;
  /** 항목(파일·폴더)을 지우고, 그 아래를 가리키던 출처 기록도 지운다 */
  removeEntry(id: string, relPath: string): Promise<void>;
  preview(id: string, relPath: string): Promise<KnowledgePreview>;
  /** 지식베이스 폴더 절대 경로 (연결 폴더면 그 폴더, 아니면 files/). 답변 CLI의 작업 폴더로 쓴다 */
  dirFor(id: string): string;
  /** 경로(files/ 기준)를 절대 경로로 바꾼다. 항목이 없거나 링크면 throw */
  resolvePath(id: string, relPath: string): Promise<string>;
  /** 설명 저장 (빈 문자열이면 지운다) */
  setDescription(id: string, description: string): Promise<KnowledgeBase>;
  /** 출처 목록 (추가할 때 기록된 원본 위치) */
  sources(id: string): Promise<KnowledgeSource[]>;
}

/** 메타 파일(meta.json) 내용. 선택 필드는 없을 수 있다. 구버전 필드(kind 등)는 읽지 않는다 */
interface KbMeta {
  name: string;
  createdAt: number;
  updatedAt: number;
  description?: string;
  sources?: KnowledgeSource[];
  /** 파일 수·크기 합 캐시. 목록을 열 때 전체를 훑지 않게 변경 작업 뒤에 다시 잰다 */
  stats?: KbStats;
  /** 연결 폴더 절대 경로 (구버전 코드베이스 KB, 읽기 전용, ADR-136) */
  linkedPath?: string;
}

interface KbStats {
  fileCount: number;
  totalBytes: number;
}

function isStats(v: unknown): v is KbStats {
  const o = v as Partial<KbStats> | null | undefined;
  return !!o && Number.isFinite(o.fileCount) && Number.isFinite(o.totalBytes);
}

function parseSources(v: unknown): KnowledgeSource[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is KnowledgeSource => {
      const o = s as Partial<KnowledgeSource> | null;
      return (
        !!o &&
        typeof o.id === 'string' &&
        typeof o.type === 'string' &&
        typeof o.location === 'string' &&
        typeof o.dest === 'string' &&
        typeof o.addedAt === 'number' &&
        typeof o.updatedAt === 'number'
      );
    })
    .map((s) => {
      // mode는 github 출처에만 의미가 있다. 없거나 잘못되면 생략한다 (구버전 행)
      const { mode, ...rest } = s;
      return isGitImportMode(mode) ? { ...rest, mode } : rest;
    });
}

interface Budget {
  files: number;
  bytes: number;
  visited: number;
  skipped: number;
  /** 이번 호출에서 복사한 파일 수·바이트 (진행 알림용) */
  copied: number;
  copiedBytes: number;
  ctl?: KnowledgeTaskControl;
}

/** 디렉터리를 재귀로 훑어 항목을 모은다 (숨김·링크 제외). 크기 재기 전용 */
async function walk(dirAbs: string, prefix: string, out: KnowledgeEntry[], budget: { n: number }): Promise<void> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of names) {
    if (isHidden(d.name) || budget.n >= WALK_MAX_ENTRIES) continue;
    budget.n++;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    const abs = path.join(dirAbs, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      out.push({ path: rel, dir: true });
      await walk(abs, rel, out, budget);
    } else if (d.isFile()) {
      const st = await lstatOrNull(abs);
      out.push({ path: rel, dir: false, size: st?.size ?? 0 });
    }
  }
}

/** 폴더 하나의 바로 아래 항목 (숨김·링크 제외, 폴더 먼저, 이름순). 폴더를 펼칠 때 하나씩 읽는다 */
async function listLevel(dirAbs: string, prefix: string): Promise<KnowledgeEntry[]> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const dirs = names.filter((d) => d.isDirectory() && !isHidden(d.name)).sort(byName);
  const files = names.filter((d) => d.isFile() && !isHidden(d.name)).sort(byName);
  const out: KnowledgeEntry[] = [];
  for (const d of dirs) {
    if (out.length >= WALK_MAX_ENTRIES) break;
    out.push({ path: prefix ? `${prefix}/${d.name}` : d.name, dir: true });
  }
  for (const d of files) {
    if (out.length >= WALK_MAX_ENTRIES) break;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    out.push({ path: rel, dir: false, size: (await lstatOrNull(path.join(dirAbs, d.name)))?.size ?? 0 });
  }
  return out;
}

/** 크기·개수 합계 (files/ 기준) */
async function measure(dirAbs: string): Promise<{ fileCount: number; totalBytes: number }> {
  const entries: KnowledgeEntry[] = [];
  await walk(dirAbs, '', entries, { n: 0 });
  let fileCount = 0;
  let totalBytes = 0;
  for (const e of entries) {
    if (!e.dir) {
      fileCount++;
      totalBytes += e.size ?? 0;
    }
  }
  return { fileCount, totalBytes };
}

/**
 * 폴더의 실제 디스크 사용량(숨김·.git 포함, 항목 수 제한 없음). cap을 넘으면 그 즉시 멈추고 cap+1 이상을 돌려준다.
 * 가져오기 한도 확인 전용이다 (measure는 표시용이라 숨김을 빼고 20k에서 멈춘다).
 */
async function diskUsage(dirAbs: string, cap: number): Promise<number> {
  let total = 0;
  const stack = [dirAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) stack.push(abs);
      else if (d.isFile()) {
        total += (await lstatOrNull(abs))?.size ?? 0;
        if (total > cap) return total;
      }
    }
  }
  return total;
}

/**
 * 구버전 색인 파일(`index*.sqlite*`)과 백업 폴더(`backup/`)를 각 지식베이스 폴더 바로 아래에서 지운다 (ADR-136).
 * 파생 데이터이므로 원본인 files/는 건드리지 않는다. 여러 번 실행해도 안전하다(멱등). 앱 시작 때 부른다.
 * 반환값은 지운 항목 수.
 */
export async function cleanLegacyIndexes(root: string): Promise<number> {
  let removed = 0;
  let ids: string[];
  try {
    ids = (await readdir(path.resolve(root))).filter((n) => KNOWLEDGE_ID_RE.test(n));
  } catch {
    return 0;
  }
  for (const id of ids) {
    const dir = path.join(path.resolve(root), id);
    if (!(await lstatOrNull(dir))?.isDirectory()) continue;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      // 꺼지면서 남은 클론·압축 임시 폴더도 지운다 (앱 시작 때만 불리므로 진행 중인 작업이 없다)
      if (name === 'backup' || /^index.*\.sqlite/.test(name) || /^\.(clone|zip)-[0-9a-f]{12}$/.test(name)) {
        await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => undefined);
        removed++;
      }
    }
  }
  return removed;
}

export function createKnowledgeStore(opts: KnowledgeStoreOptions): KnowledgeStore {
  const root = path.resolve(opts.root);
  /** 지식베이스 폴더를 품거나 그 안에 있는 경로 (자기 자신으로 복사해 끝없이 커지는 것을 막는다) */
  const overlapsRoot = (p: string): boolean => {
    const src = path.resolve(p);
    const base = path.resolve(root);
    return src === base || base.startsWith(src + path.sep) || src.startsWith(base + path.sep);
  };
  const lookupAll = opts.lookup ?? (opts.fetch ? async () => [] : dnsLookupAll);
  const gitEnv = opts.env ?? process.env;
  const gitBin = opts.gitBin ?? 'git';
  const cloneIdleMs = opts.cloneIdleMs ?? CLONE_IDLE_MS;
  const cloneTimeoutMs = opts.cloneTimeoutMs ?? CLONE_TIMEOUT_MS;
  const cloneWatchMs = opts.cloneWatchMs ?? CLONE_WATCH_MS;

  // 변경 작업은 하나씩 (같은 지식베이스에 동시에 쓰지 않게)
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  }

  const kbDir = (id: string) => path.join(root, checkId(id));
  const filesDir = (id: string) => path.join(kbDir(id), 'files');
  const metaPath = (id: string) => path.join(kbDir(id), 'meta.json');

  /** 메타를 읽는다. 필수 필드가 없거나 깨졌으면 null (fail closed) */
  async function readMeta(id: string): Promise<KbMeta | null> {
    try {
      const raw = JSON.parse(await readFile(metaPath(id), 'utf8')) as Record<string, unknown>;
      if (typeof raw.name !== 'string' || typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number') return null;
      const meta: KbMeta = { name: raw.name, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
      if (typeof raw.description === 'string' && raw.description) meta.description = raw.description;
      if (raw.sources !== undefined) meta.sources = parseSources(raw.sources);
      if (isStats(raw.stats)) meta.stats = { fileCount: raw.stats.fileCount, totalBytes: raw.stats.totalBytes };
      if (typeof raw.linkedPath === 'string' && path.isAbsolute(raw.linkedPath)) meta.linkedPath = raw.linkedPath;
      return meta;
    } catch {
      return null;
    }
  }

  async function existingKb(id: string): Promise<KbMeta> {
    const st = await lstatOrNull(kbDir(id));
    if (!st?.isDirectory()) throw new KnowledgeNotFoundError(t('bridge.knowledge.notFound'));
    const meta = await readMeta(id);
    if (!meta) throw new KnowledgeNotFoundError(t('bridge.knowledge.notFound'));
    return meta;
  }

  /** 파일을 바꾸는 작업 전 확인: 연결 폴더(구버전)는 읽기 전용이다 (ADR-136) */
  async function writableKb(id: string): Promise<KbMeta> {
    const meta = await existingKb(id);
    if (meta.linkedPath) fail(t('bridge.knowledge.linkedReadOnly'));
    return meta;
  }

  /**
   * 개수·크기 캐시가 없는 지식베이스(이전 버전에서 만든 것)를 뒤에서 하나씩 재서 저장한다 (ADR-126).
   * 목록·이름 바꾸기 등은 이 결과를 기다리지 않는다. 같은 지식베이스를 두 번 재지 않고, 동시에 하나만 잰다.
   * 저장은 변경 작업 순서(serial) 안에서 최신 메타에 덧붙여, 동시에 바뀐 내용을 덮어쓰지 않는다.
   */
  const measuring = new Set<string>();
  let measureQueue: Promise<unknown> = Promise.resolve();
  function measureLater(id: string): Promise<void> {
    if (measuring.has(id)) return measureQueue.then(() => undefined);
    measuring.add(id);
    const p = measureQueue.then(async () => {
      try {
        const cur = await readMeta(id);
        if (!cur || cur.stats) return;
        const m = await measureKb(id, cur);
        await serial(async () => {
          const latest = await readMeta(id);
          if (latest && !latest.stats) await saveMeta(id, { ...latest, stats: m });
        });
      } finally {
        measuring.delete(id);
      }
    });
    measureQueue = p.catch(() => undefined);
    return p.catch(() => undefined);
  }

  /** 원본 루트: 연결 폴더(구버전)면 그 폴더, 아니면 files/ */
  const baseOf = (id: string, meta: KbMeta): string => (meta.linkedPath ? meta.linkedPath : filesDir(id));

  /** 개수·크기: 연결 폴더는 세고, 아니면 files/ 전체 */
  async function measureKb(id: string, meta: KbMeta): Promise<{ fileCount: number; totalBytes: number }> {
    if (meta.linkedPath) return measureLinked(meta.linkedPath, []);
    return measure(filesDir(id));
  }

  /** 메타만으로 만든다 — 파일을 훑지 않는다. 캐시가 없으면 statsPending으로 돌려주고 뒤에서 잰다 */
  function toBase(id: string, meta: KbMeta): KnowledgeBase {
    const m = meta.stats;
    if (!m) void measureLater(id);
    return {
      id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      fileCount: m?.fileCount ?? 0,
      totalBytes: m?.totalBytes ?? 0,
      ...(m ? {} : { statsPending: true }),
      ...(meta.linkedPath ? { linkedPath: meta.linkedPath } : {}),
    };
  }

  /** 추가 전 여유 공간 확인. 조회 자체가 실패하면 막지 않는다 */
  async function checkDiskRoom(): Promise<void> {
    let free: number;
    try {
      const s = await statfs(root);
      free = Number(s.bavail) * Number(s.bsize);
    } catch {
      return;
    }
    if (free < MIN_FREE_FOR_ADD) fail(t('bridge.knowledge.diskLow'));
  }

  /** 새로 추가된 항목을 출처 목록에 기록한다 */
  async function recordSources(
    id: string,
    rows: { type: KnowledgeSource['type']; location: string; dest: string; mode?: GitImportMode }[],
  ) {
    if (rows.length === 0) return;
    const meta = await readMeta(id);
    if (!meta) return;
    const now = Date.now();
    const added: KnowledgeSource[] = rows.map((r) => ({
      id: `src${randomBytes(6).toString('hex')}`,
      type: r.type,
      location: r.location,
      dest: r.dest,
      addedAt: now,
      updatedAt: now,
      ...(r.mode ? { mode: r.mode } : {}),
    }));
    await saveMeta(id, { ...meta, sources: [...(meta.sources ?? []), ...added] });
  }

  async function saveMeta(id: string, meta: KbMeta) {
    // 임시 파일에 쓰고 바꿔 끼워, 중간에 꺼져도 meta.json이 깨지지 않게 한다
    const tmp = `${metaPath(id)}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(meta), 'utf8');
    await rename(tmp, metaPath(id));
  }

  /**
   * files/ 아래 상대 경로의 실제 위치를 찾는다. 중간 조각이 링크이거나 파일이면 throw.
   * mustExist=false면 없는 조각을 허용한다(쓰기 전 확인용).
   */
  async function locate(
    id: string,
    rel: string | undefined,
    mustExist: boolean,
    base: string = filesDir(id),
  ): Promise<{ abs: string; exists: boolean }> {
    const segs = splitRel(rel);
    let cur = base;
    for (const [i, seg] of segs.entries()) {
      cur = path.join(cur, seg);
      const st = await lstatOrNull(cur);
      if (!st) {
        if (mustExist) fail(t('bridge.knowledge.entryNotFound'));
        return { abs: path.join(base, ...segs), exists: false };
      }
      if (st.isSymbolicLink()) fail(t('bridge.knowledge.badPath'));
      if (i < segs.length - 1 && !st.isDirectory()) fail(t('bridge.knowledge.badPath'));
    }
    return { abs: cur, exists: true };
  }

  /** dest 폴더를 찾아 없으면 만든다 (쓰기 전용) */
  async function ensureDir(id: string, rel: string | undefined): Promise<string> {
    const segs = splitRel(rel);
    let cur = filesDir(id);
    await mkdir(cur, { recursive: true });
    for (const s of segs) {
      cur = path.join(cur, s);
      const st = await lstatOrNull(cur);
      if (!st) await mkdir(cur);
      else if (st.isSymbolicLink() || !st.isDirectory()) fail(t('bridge.knowledge.badPath'));
    }
    return cur;
  }

  const relOf = (id: string, abs: string) => path.relative(filesDir(id), abs).split(path.sep).join('/');

  /** 두 경로가 모두 일반 파일이고 크기와 SHA-256이 같은가 (링크는 비교하지 않는다) */
  async function sameFileContent(a: string, b: string): Promise<boolean> {
    const [sa, sb] = await Promise.all([lstatOrNull(a), lstatOrNull(b)]);
    if (!sa?.isFile() || !sb?.isFile() || sa.size !== sb.size || sa.size > KNOWLEDGE_LIMITS.fileBytes) return false;
    const digest = async (f: string) => createHash('sha256').update(await readFile(f)).digest('hex');
    try {
      return (await digest(a)) === (await digest(b));
    } catch {
      return false;
    }
  }

  /** 디스크 항목 하나를 dstDir로 복사한다. 제한을 넘으면 건너뛰고 skipped를 센다 */
  async function importEntry(
    src: string,
    name: string,
    dstDir: string,
    budget: Budget,
    onCreate?: (abs: string) => void,
  ): Promise<string | null> {
    if (budget.ctl?.signal?.aborted) throw cancelledError();
    if (budget.visited++ > WALK_MAX_ENTRIES) {
      budget.skipped++;
      return null;
    }
    if (isHidden(name) || !isSafeSegment(name)) {
      budget.skipped++;
      return null;
    }
    const st = await lstatOrNull(src);
    if (!st || st.isSymbolicLink()) {
      budget.skipped++;
      return null;
    }
    if (st.isDirectory()) {
      const target = path.join(dstDir, await uniqueName(dstDir, name));
      await mkdir(target);
      onCreate?.(target);
      let kids: import('node:fs').Dirent[];
      try {
        kids = await readdir(src, { withFileTypes: true });
      } catch {
        kids = [];
      }
      kids.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const k of kids) {
        await importEntry(path.join(src, k.name), k.name, target, budget);
      }
      return target;
    }
    if (!st.isFile()) {
      budget.skipped++;
      return null;
    }
    if (st.size > KNOWLEDGE_LIMITS.fileBytes || budget.bytes + st.size > KNOWLEDGE_LIMITS.totalBytes) {
      budget.skipped++;
      return null;
    }
    const target = path.join(dstDir, await uniqueName(dstDir, name));
    onCreate?.(target);
    await copyFile(src, target, fsc.COPYFILE_EXCL);
    budget.files++;
    budget.bytes += st.size;
    reportCopy(budget, st.size);
    return target;
  }

  async function budgetOf(id: string, ctl?: KnowledgeTaskControl): Promise<Budget> {
    const m = await measure(filesDir(id));
    return { files: m.fileCount, bytes: m.totalBytes, visited: 0, skipped: 0, copied: 0, copiedBytes: 0, ctl };
  }

  function reportCopy(budget: Budget, size: number) {
    budget.copied++;
    budget.copiedBytes += size;
    budget.ctl?.onProgress?.({ phase: 'copy', files: budget.copied, bytes: budget.copiedBytes });
  }

  /** 취소되면 이번 호출에서 만든 최상위 항목을 지운다 (반쯤 복사된 폴더를 남기지 않게) */
  async function rollback(created: string[]) {
    for (const abs of created.reverse()) await rm(abs, { recursive: true, force: true }).catch(() => undefined);
  }

  function checkBudget(b: { files: number; bytes: number }, adding: { files: number; bytes: number }) {
    if (b.bytes + adding.bytes > KNOWLEDGE_LIMITS.totalBytes) fail(t('bridge.knowledge.tooManyBytes'));
  }

  /** 디스크에서 가져온 임시 폴더가 지식베이스 한도 안인지 */
  async function assertCloneFits(id: string, dirAbs: string) {
    // 표시용 measure와 달리 .git·숨김 파일까지 모두 센다 (실제 디스크 사용량 기준)
    const cap = KNOWLEDGE_LIMITS.totalBytes;
    const added = await diskUsage(dirAbs, cap);
    const cur = added > cap ? 0 : await diskUsage(filesDir(id), cap);
    checkBudget({ files: 0, bytes: cur }, { files: 0, bytes: added });
  }

  /** 지식베이스에 남은 용량 (클론 중 감시용) */
  async function roomLeft(id: string): Promise<number> {
    const cap = KNOWLEDGE_LIMITS.totalBytes;
    return Math.max(0, cap - (await diskUsage(filesDir(id), cap)));
  }

  /** 가져온 폴더를 제자리로 옮기고 출처를 기록한다. 기록이 실패하면 옮긴 폴더를 지워 고아 폴더를 남기지 않는다 */
  async function placeImported(
    id: string,
    tmp: string,
    name: string,
    source: { location: string; mode: GitImportMode },
  ): Promise<string> {
    const reposDir = await ensureDir(id, 'repos');
    const target = path.join(reposDir, await uniqueName(reposDir, name));
    await rename(tmp, target);
    const rel = relOf(id, target);
    try {
      await recordSources(id, [{ type: 'github', location: source.location, dest: rel, mode: source.mode }]);
    } catch (err) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    return rel;
  }

  async function removeSymlinks(dirAbs: string) {
    const names = await readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const d of names) {
      const abs = path.join(dirAbs, d.name);
      if (d.isSymbolicLink()) await rm(abs, { force: true });
      else if (d.isDirectory()) await removeSymlinks(abs);
    }
  }

  /** git 프로세스와 그 자식(git-remote-https 등)을 모두 끝낸다 */
  function killTree(child: ChildProcess) {
    const pid = child.pid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // 이미 끝났다
      }
    }
  }

  /**
   * git을 실행한다. stderr의 진행 줄을 진행률로 알리고, 무응답·전체 시간 초과·취소 시 프로세스 트리를 끝낸다.
   * 'close'(stdio 닫힘)만 기다리면 손자 프로세스가 파이프를 붙잡아 영원히 끝나지 않을 수 있어 'exit'로 끝낸다.
   */
  function runGit(args: string[], cwd: string, ctl: KnowledgeTaskControl | undefined, phase: KnowledgeProgress['phase']): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = ctl?.signal;
      if (signal?.aborted) return reject(cancelledError());
      const win = process.platform === 'win32';
      let child: ChildProcess;
      try {
        child = spawn(gitBin, args, {
          cwd,
          shell: false,
          // posix: 새 프로세스 그룹으로 띄워 그룹째 끝낼 수 있게 한다
          detached: !win,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...gitEnv,
            // 시스템 전역 git 설정을 읽지 않는다 (사용자 설정 파일은 그대로 둔다)
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_ASKPASS: '',
            SSH_ASKPASS: '',
            GIT_LFS_SKIP_SMUDGE: '1',
          },
        });
      } catch {
        return reject(new Error(t('bridge.knowledge.gitMissing')));
      }
      let done = false;
      let tail = '';
      const messages: string[] = [];
      const handleLine = (raw: string) => {
        const line = raw.trim();
        if (!line) return;
        const ratio = parseGitProgress(line);
        if (ratio === null) {
          if (messages.length < 20) messages.push(line);
        } else {
          ctl?.onProgress?.({ phase, ratio });
        }
      };
      const settle = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(idle);
        clearTimeout(hard);
        clearTimeout(grace);
        signal?.removeEventListener('abort', onAbort);
        if (tail) handleLine(tail);
        tail = '';
        child.stderr?.destroy();
        if (err) reject(err);
        else resolve();
      };
      const stop = (err: Error) => {
        killTree(child);
        settle(err);
      };
      const onAbort = () => stop(cancelledError());
      const idle = setTimeout(() => stop(new Error(t('bridge.knowledge.cloneStalled'))), cloneIdleMs);
      const hard = setTimeout(() => stop(new Error(t('bridge.knowledge.cloneTimeout'))), cloneTimeoutMs);
      let grace: ReturnType<typeof setTimeout> | undefined;
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (c: string) => {
        idle.refresh();
        tail += c;
        const parts = tail.split(/[\r\n]+/);
        tail = parts.pop() ?? '';
        if (tail.length > 4000) tail = tail.slice(-4000);
        for (const line of parts) handleLine(line);
      });
      child.stderr?.on('error', () => undefined);
      child.on('error', (err: NodeJS.ErrnoException) => {
        settle(
          new Error(err.code === 'ENOENT' ? t('bridge.knowledge.gitMissing') : t('bridge.knowledge.cloneFailed', { error: err.code ?? 'error' })),
        );
      });
      const finish = (code: number | null) => {
        if (done) return;
        if (tail) handleLine(tail);
        tail = '';
        if (code === 0) return settle();
        // 남은 자식이 있으면 함께 끝낸다
        killTree(child);
        // 없는/비공개 저장소는 git이 인증을 요구하며 실패한다 (인증 프롬프트는 끈다)
        const notFound = messages.some((m) => /could not read Username|Authentication failed|repository .*not found|terminal prompts disabled/i.test(m));
        settle(new Error(notFound ? t('bridge.knowledge.repoNotFound') : t('bridge.knowledge.cloneFailed', { error: gitErrorLine(messages, code).slice(0, 200) })));
      };
      child.on('exit', (code) => {
        // stderr 마지막 줄을 읽을 시간을 잠깐 준다
        grace = setTimeout(() => finish(code), CLONE_CLOSE_GRACE_MS);
      });
      child.on('close', (code) => finish(code));
    });
  }

  /**
   * 공개 주소 하나를 받는다 (SSRF 방지). 리디렉션은 직접 따라가며 매 단계 주소를 확인한다.
   * 주입된 fetch가 있으면 그것을 쓰고, 없으면 연결 직전에도 주소를 다시 검사한다 (DNS 리바인딩 방지).
   * 응답 본문은 maxBytes를 넘으면 tooLarge 메시지로 실패한다.
   */
  async function httpGet(
    start: URL,
    outer: AbortSignal | undefined,
    headers: Record<string, string>,
    maxBytes: number,
    timeoutMs: number,
    tooLarge: MessageKey,
  ): Promise<{ status: number; headers: Headers; url: string; body: Uint8Array }> {
    const hostAddrs = (hostname: string) => lookupAll(hostname.replace(/^\[|\]$/g, ''));
    /** 호스트가 사설 주소이거나 사설 주소로 풀리면 막는다 (요청 전 검사) */
    const assertPublic = async (u: URL) => {
      if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(t('bridge.knowledge.badUrl'));
      if (u.username || u.password) fail(t('bridge.knowledge.badUrl'));
      if (isPrivateHost(u.hostname)) fail(t('bridge.knowledge.privateHost'));
      let addrs: string[];
      try {
        addrs = await hostAddrs(u.hostname);
      } catch {
        return fail(t('bridge.knowledge.fetchFailed'));
      }
      if (addrs.some((a) => isPrivateHost(a))) fail(t('bridge.knowledge.privateHost'));
    };
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outer ? combineSignals(outer, timeout) : timeout;
    const request = async (u: URL): Promise<LinkPage> => {
      if (opts.fetch) {
        const r = await opts.fetch(u.href, { redirect: 'manual', signal, headers });
        return {
          status: r.status,
          url: r.url,
          headers: r.headers,
          read: async (max) => {
            const b = new Uint8Array(await r.arrayBuffer());
            return b.byteLength > max ? null : b;
          },
        };
      }
      const p = await pinnedGet(u, { signal, headers, resolve: hostAddrs, isBlocked: isPrivateHost });
      return { status: p.status, url: '', headers: p.headers, read: p.read };
    };
    let current = start;
    let res: LinkPage | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublic(current);
      let r: LinkPage;
      try {
        r = await request(current);
      } catch (err) {
        if (outer?.aborted) throw cancelledError();
        if (err instanceof LinkBlockedError) fail(t('bridge.knowledge.privateHost'));
        return fail(t('bridge.knowledge.fetchFailed'));
      }
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!loc) {
        res = r;
        break;
      }
      try {
        current = new URL(loc, current);
      } catch {
        return fail(t('bridge.knowledge.fetchFailed'));
      }
    }
    if (!res) return fail(t('bridge.knowledge.fetchFailed'));
    // 주입된 fetch가 스스로 따라간 경우도 최종 주소를 다시 본다
    const finalUrl = res.url || current.href;
    if (isPrivateHost(new URL(finalUrl).hostname)) fail(t('bridge.knowledge.privateHost'));
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > maxBytes) fail(t(tooLarge));
    let buf: Uint8Array | null;
    try {
      buf = await res.read(maxBytes);
    } catch {
      if (outer?.aborted) throw cancelledError();
      return fail(t('bridge.knowledge.fetchFailed'));
    }
    if (!buf) fail(t(tooLarge));
    return { status: res.status, headers: res.headers, url: finalUrl, body: buf };
  }

  /** 링크 한 개를 가져온다 (네트워크, 큐 밖에서 실행). 마크다운 본문을 돌려준다 */
  async function fetchPage(url: string, outer?: AbortSignal): Promise<{ title: string; markdown: string; finalUrl: string }> {
    if (!isKnowledgeLinkUrl(url)) fail(t('bridge.knowledge.badUrl'));
    const r = await httpGet(
      new URL(url.trim()),
      outer,
      { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8' },
      HTML_MAX_BYTES,
      FETCH_TIMEOUT_MS,
      'bridge.knowledge.htmlTooLarge',
    );
    if (r.status < 200 || r.status >= 300) fail(t('bridge.knowledge.fetchFailed'));
    const type = r.headers.get('content-type') ?? '';
    if (type && !/text\/|html|xml/i.test(type)) fail(t('bridge.knowledge.notHtml'));
    const html = new TextDecoder('utf-8').decode(r.body);
    return { title: extractTitle(html), markdown: htmlToMarkdown(html), finalUrl: r.url };
  }

  async function addDocument(id: string, dir: string, name: string, body: string | Uint8Array, budget: Budget): Promise<string> {
    const size = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
    if (size > KNOWLEDGE_LIMITS.fileBytes) fail(t('bridge.knowledge.tooLarge'));
    checkBudget(budget, { files: 1, bytes: size });
    const target = path.join(dir, await uniqueName(dir, name));
    await writeFile(target, body, { flag: 'wx' });
    budget.files++;
    budget.bytes += size;
    return relOf(id, target);
  }

  /**
   * ZIP(tar.gz) 가져오기 (ADR-138): codeload에서 받아 임시 폴더에 풀고, 확인 후 repos/로 옮긴다.
   * 숨김 항목(.git 등)은 풀지 않으므로 pull은 할 수 없다 (mode는 zip으로 기록).
   */
  async function zipImport(id: string, repo: { owner: string; repo: string }, ctl?: KnowledgeTaskControl): Promise<KnowledgeAddResult> {
    ctl?.onProgress?.({ phase: 'download' });
    const archiveUrl = new URL(`https://codeload.github.com/${repo.owner}/${repo.repo}/tar.gz/HEAD`);
    const res = await httpGet(
      archiveUrl,
      ctl?.signal,
      { accept: 'application/gzip, application/octet-stream;q=0.9, */*;q=0.5' },
      ARCHIVE_MAX_BYTES,
      ARCHIVE_TIMEOUT_MS,
      'bridge.knowledge.archiveTooLarge',
    );
    if (res.status < 200 || res.status >= 300) fail(t('bridge.knowledge.repoNotFound'));
    ctl?.onProgress?.({ phase: 'extract' });
    const tmp = path.join(kbDir(id), `.zip-${randomBytes(6).toString('hex')}`);
    try {
      let parsed;
      try {
        parsed = parseTarGz(res.body, {
          maxEntries: ARCHIVE_MAX_ENTRIES,
          maxFileBytes: KNOWLEDGE_LIMITS.fileBytes,
          maxTotalBytes: KNOWLEDGE_LIMITS.totalBytes,
        });
      } catch (err) {
        if (err instanceof TarFormatError) {
          const key: Record<TarFormatError['reason'], MessageKey> = {
            format: 'bridge.knowledge.archiveFormat',
            too_many: 'bridge.knowledge.archiveTooMany',
            too_large: 'bridge.knowledge.archiveTooLarge',
            escape: 'bridge.knowledge.archiveEscape',
          };
          fail(t(key[err.reason]));
        }
        throw err;
      }
      await mkdir(tmp, { recursive: true });
      let written = 0;
      let skipped = parsed.skipped;
      for (const e of parsed.entries) {
        // 조각마다 안전한 이름인지 본다 (Windows 금지 문자 등)
        const segs = e.path.split('/');
        if (!segs.every(isSafeSegment)) {
          skipped++;
          continue;
        }
        const abs = path.join(tmp, ...segs);
        if (e.dir) {
          await mkdir(abs, { recursive: true });
          continue;
        }
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, e.data ?? new Uint8Array(0), { flag: 'wx' });
        written++;
        ctl?.onProgress?.({ phase: 'extract', files: written });
      }
      ctl?.onProgress?.({ phase: 'save' });
      return await serial(async () => {
        if (ctl?.signal?.aborted) throw cancelledError();
        await existingKb(id);
        await assertCloneFits(id, tmp);
        const rel = await placeImported(id, tmp, repo.repo, { location: `https://github.com/${repo.owner}/${repo.repo}.git`, mode: 'zip' });
        await touch(id);
        return { added: [rel], skipped };
      });
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * 클론하는 동안 임시 폴더 크기를 주기적으로 재서, 남은 용량을 넘으면 git을 멈춘다.
   * 다 받은 뒤에야 한도를 확인하면 큰 저장소가 디스크를 먼저 채울 수 있다.
   */
  async function cloneWithinBudget(id: string, url: string, tmp: string, ctl?: KnowledgeTaskControl): Promise<void> {
    const room = await roomLeft(id);
    if (room <= 0) fail(t('bridge.knowledge.tooManyBytes'));
    const inner = new AbortController();
    const outer = ctl?.signal;
    const relay = () => inner.abort();
    if (outer?.aborted) inner.abort();
    outer?.addEventListener('abort', relay);
    let over = false;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void diskUsage(tmp, room)
        .then((n) => {
          if (n > room) {
            over = true;
            inner.abort();
          }
        })
        .finally(() => {
          checking = false;
        });
    }, cloneWatchMs);
    try {
      await runGit(gitCloneArgs(url, tmp), kbDir(id), { ...ctl, signal: inner.signal }, 'clone');
    } catch (err) {
      if (over && !outer?.aborted) fail(t('bridge.knowledge.tooManyBytes'));
      throw err;
    } finally {
      clearInterval(timer);
      outer?.removeEventListener('abort', relay);
    }
  }

  /** git 클론 가져오기 (ADR-138): .git을 남겨 두고, 심볼릭 링크만 지운다 */
  async function gitImport(id: string, repo: { repo: string; url: string }, ctl?: KnowledgeTaskControl): Promise<KnowledgeAddResult> {
    // 임시 클론은 지식베이스 폴더 안(files/ 밖)에 두고, 확인 후 files/repos/로 옮긴다
    const tmp = path.join(kbDir(id), `.clone-${randomBytes(6).toString('hex')}`);
    try {
      ctl?.onProgress?.({ phase: 'clone' });
      await cloneWithinBudget(id, repo.url, tmp, ctl);
      ctl?.onProgress?.({ phase: 'save' });
      await removeSymlinks(tmp);
      return await serial(async () => {
        if (ctl?.signal?.aborted) throw cancelledError();
        await existingKb(id);
        await assertCloneFits(id, tmp);
        const rel = await placeImported(id, tmp, repo.repo, { location: repo.url, mode: 'clone' });
        await touch(id);
        return { added: [rel], skipped: 0 };
      });
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const store: KnowledgeStore = {
    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return [];
      }
      // 지식베이스마다 meta.json 하나만 읽는다(동시에). 파일 수·크기와 무관하게 바로 돌려준다 (ADR-126)
      const ids = names.filter((n) => KNOWLEDGE_ID_RE.test(n)).sort();
      const bases = await Promise.all(
        ids.map(async (n) => {
          const st = await lstatOrNull(path.join(root, n));
          if (!st?.isDirectory()) return null;
          const meta = await readMeta(n);
          return meta ? toBase(n, meta) : null;
        }),
      );
      return bases.filter((b): b is KnowledgeBase => b !== null);
    },

    async warmStats() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return;
      }
      for (const n of names.filter((x) => KNOWLEDGE_ID_RE.test(x)).sort()) {
        const meta = await readMeta(n);
        if (meta && !meta.stats) await measureLater(n);
      }
    },

    create(name, opts) {
      return serial(async () => {
        const clean = cleanKnowledgeName(name);
        if (!clean) fail(t('bridge.knowledge.badName'));
        await mkdir(root, { recursive: true });
        const id = newId('kb');
        checkId(id);
        await mkdir(filesDir(id), { recursive: true });
        const now = Date.now();
        const description = typeof opts?.description === 'string' ? opts.description.trim().slice(0, DESCRIPTION_MAX) : '';
        const meta: KbMeta = {
          name: clean,
          createdAt: now,
          updatedAt: now,
          ...(description ? { description } : {}),
          stats: { fileCount: 0, totalBytes: 0 },
        };
        await saveMeta(id, meta);
        return toBase(id, meta);
      });
    },

    rename(id, name) {
      return serial(async () => {
        const clean = cleanKnowledgeName(name);
        if (!clean) fail(t('bridge.knowledge.badName'));
        const meta = await existingKb(id);
        const next = { ...meta, name: clean, updatedAt: Date.now() };
        await saveMeta(id, next);
        return toBase(id, next);
      });
    },

    remove(id) {
      return serial(async () => {
        await existingKb(id);
        await rm(kbDir(id), { recursive: true, force: false });
      });
    },

    async tree(id, dir) {
      const meta = await existingKb(id);
      if (typeof dir !== 'string') fail(t('bridge.knowledge.badPath'));
      const base = baseOf(id, meta);
      const { abs, exists } = await locate(id, dir || undefined, true, base);
      if (!exists) fail(t('bridge.knowledge.entryNotFound'));
      if (dir && !(await lstatOrNull(abs))?.isDirectory()) fail(t('bridge.knowledge.badPath'));
      const entries = await listLevel(abs, dir);
      const sources = meta.sources ?? [];
      if (sources.length === 0) return entries;
      // 출처 저장 위치와 같은 항목에 출처를 붙인다 (팝업이 GitHub 표시와 pull 버튼에 쓴다)
      const byDest = new Map(sources.map((s) => [s.dest, s]));
      for (const e of entries) {
        const s = byDest.get(e.path);
        if (s) e.source = s;
      }
      return entries;
    },

    addPaths(id, paths, dest, ctl) {
      return serial(async () => {
        if (ctl?.signal?.aborted) throw cancelledError();
        await writableKb(id);
        await checkDiskRoom();
        if (!Array.isArray(paths) || paths.length > 500) fail(t('bridge.knowledge.badPath'));
        const dstDir = await ensureDir(id, dest);
        const budget = await budgetOf(id, ctl);
        ctl?.onProgress?.({ phase: 'copy', files: 0, bytes: 0 });
        const added: string[] = [];
        const created: string[] = [];
        const sourceRows: { type: KnowledgeSource['type']; location: string; dest: string }[] = [];
        try {
          for (const p of paths) {
            if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0') || overlapsRoot(p)) {
              budget.skipped++;
              continue;
            }
            const kind: KnowledgeSource['type'] = (await lstatOrNull(p))?.isDirectory() ? 'folder' : 'files';
            // 같은 이름에 내용(SHA-256)까지 같은 파일이 이미 있으면 복사하지 않는다 (파일 선택기 중복 감지)
            if (kind === 'files' && (await sameFileContent(p, path.join(dstDir, path.basename(p))))) {
              budget.skipped++;
              continue;
            }
            let top = true;
            const target = await importEntry(p, path.basename(p), dstDir, budget, (abs) => {
              if (top) created.push(abs);
              top = false;
            });
            if (target) {
              const rel = relOf(id, target);
              added.push(rel);
              sourceRows.push({ type: kind, location: p, dest: rel });
            }
          }
        } catch (e) {
          await rollback(created);
          throw e;
        }
        await recordSources(id, sourceRows);
        await touch(id);
        return { added, skipped: budget.skipped };
      });
    },

    addFiles(id, files, dest, ctl) {
      return serial(async () => {
        if (ctl?.signal?.aborted) throw cancelledError();
        await writableKb(id);
        await checkDiskRoom();
        if (!Array.isArray(files) || files.length > 500) fail(t('bridge.knowledge.badPath'));
        const dstDir = await ensureDir(id, dest);
        const budget = await budgetOf(id, ctl);
        const added: string[] = [];
        const sourceRows: { type: KnowledgeSource['type']; location: string; dest: string }[] = [];
        for (const f of files) {
          if (ctl?.signal?.aborted) {
            await rollback(added.map((r) => path.join(filesDir(id), ...r.split('/'))));
            throw cancelledError();
          }
          const name = typeof f?.name === 'string' ? f.name.trim() : '';
          if (!isSafeSegment(name) || !(f.data instanceof Uint8Array) || f.data.byteLength > KNOWLEDGE_LIMITS.fileBytes) {
            budget.skipped++;
            continue;
          }
          if (budget.bytes + f.data.byteLength > KNOWLEDGE_LIMITS.totalBytes) {
            budget.skipped++;
            continue;
          }
          const rel = await addDocument(id, dstDir, name, f.data, budget);
          added.push(rel);
          sourceRows.push({ type: 'files', location: name, dest: rel });
          reportCopy(budget, f.data.byteLength);
        }
        await recordSources(id, sourceRows);
        await touch(id);
        return { added, skipped: budget.skipped };
      });
    },

    async addLink(id, url, ctl) {
      await writableKb(id);
      await checkDiskRoom();
      ctl?.onProgress?.({ phase: 'download' });
      const page = await fetchPage(url, ctl?.signal);
      return serial(async () => {
        if (ctl?.signal?.aborted) throw cancelledError();
        await existingKb(id);
        ctl?.onProgress?.({ phase: 'save' });
        const dstDir = await ensureDir(id, 'links');
        const budget = await budgetOf(id);
        const title = page.title || new URL(page.finalUrl).hostname;
        const body = `# ${page.title || title}\n\n${page.finalUrl}\n\n${page.markdown}\n`;
        const name = `${slugify(title)}.md`;
        const rel = await addDocument(id, dstDir, name, body, budget);
        await recordSources(id, [{ type: 'web', location: url, dest: rel }]);
        await touch(id);
        return { added: [rel], skipped: 0 };
      });
    },

    async cloneGit(id, url, opts2, ctl) {
      await writableKb(id);
      await checkDiskRoom();
      const mode: GitImportMode = opts2?.mode ?? 'clone';
      if (!isGitImportMode(mode)) fail(t('bridge.knowledge.badMode'));
      const repo = parseGitHubRepo(url);
      if (!repo) fail(t('bridge.knowledge.badRepo'));
      return mode === 'zip' ? zipImport(id, repo, ctl) : gitImport(id, repo, ctl);
    },

    pullGit(id, relPath, ctl) {
      return serial(async () => {
        if (ctl?.signal?.aborted) throw cancelledError();
        const meta = await writableKb(id);
        const src = (meta.sources ?? []).find((s) => s.type === 'github' && s.dest === relPath);
        // clone으로 받은 저장소만 갱신한다 (zip에는 이력이 없다)
        if (!src || src.mode !== 'clone') fail(t('bridge.knowledge.pullNotClone'));
        const { abs, exists } = await locate(id, relPath, true);
        if (!exists || !(await lstatOrNull(path.join(abs, '.git')))?.isDirectory()) fail(t('bridge.knowledge.pullNotClone'));
        ctl?.onProgress?.({ phase: 'pull' });
        await runGit(gitPullArgs(), abs, ctl, 'pull');
        await removeSymlinks(abs);
        const now = Date.now();
        const cur = await readMeta(id);
        if (cur) {
          const rows = (cur.sources ?? []).map((s) => (s.id === src.id ? { ...s, updatedAt: now } : s));
          await saveMeta(id, { ...cur, sources: rows });
        }
        await touch(id);
        return { added: [relPath], skipped: 0 };
      });
    },

    removeEntry(id, relPath) {
      return serial(async () => {
        const meta = await writableKb(id);
        if (!relPath) fail(t('bridge.knowledge.badPath'));
        const { abs, exists } = await locate(id, relPath, false);
        if (!exists) fail(t('bridge.knowledge.entryNotFound'));
        // 출처 기록을 먼저 지운다: 삭제 도중 실패해도 사라진 폴더를 가리키는 기록이 남지 않는다
        const remain = (meta.sources ?? []).filter((s) => s.dest !== relPath && !s.dest.startsWith(`${relPath}/`));
        if (remain.length !== (meta.sources ?? []).length) await saveMeta(id, { ...meta, sources: remain });
        await rm(abs, { recursive: true, force: false });
        await touch(id);
      });
    },

    async preview(id, relPath) {
      const meta = await existingKb(id);
      if (!relPath) fail(t('bridge.knowledge.badPath'));
      const { abs } = await locate(id, relPath, true, baseOf(id, meta));
      const st = await lstatOrNull(abs);
      if (!st?.isFile()) fail(t('bridge.knowledge.badPath'));
      const fh = await open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, PREVIEW_READ_BYTES));
        // read는 요청보다 적게 읽을 수 있으므로 끝까지 채운다
        let bytesRead = 0;
        while (bytesRead < buf.length) {
          const r = await fh.read(buf, bytesRead, buf.length - bytesRead, bytesRead);
          if (r.bytesRead === 0) break;
          bytesRead += r.bytesRead;
        }
        const head = buf.subarray(0, bytesRead);
        if (head.includes(0)) return { text: null, size: st.size, truncated: false };
        const full = head.toString('utf8');
        const text = full.slice(0, KNOWLEDGE_LIMITS.previewChars);
        return { text, size: st.size, truncated: st.size > bytesRead || full.length > text.length };
      } finally {
        await fh.close();
      }
    },

    async setDescription(id, description) {
      return serial(async () => {
        const meta = await existingKb(id);
        const clean = typeof description === 'string' ? description.trim().slice(0, DESCRIPTION_MAX) : '';
        const next: KbMeta = { ...meta, updatedAt: Date.now() };
        delete next.description;
        if (clean) next.description = clean;
        await saveMeta(id, next);
        return toBase(id, next);
      });
    },

    async sources(id) {
      const meta = await existingKb(id);
      return meta.sources ?? [];
    },

    async resolvePath(id, relPath) {
      const meta = await existingKb(id);
      const { abs, exists } = await locate(id, relPath, true, baseOf(id, meta));
      if (!exists) fail(t('bridge.knowledge.entryNotFound'));
      return abs;
    },

    dirFor(id) {
      // 연결 폴더(구버전)는 그 폴더, 아니면 files/ (답변 CLI 작업 폴더)
      return filesRootOf(root, checkId(id)) ?? filesDir(id);
    },
  };

  /** 파일이 바뀐 뒤: 수정 시각과 크기·개수 캐시를 갱신한다 (메타 파일이 있을 때만) */
  async function touch(id: string) {
    const meta = await readMeta(id);
    if (!meta) return;
    const stats = await measureKb(id, meta);
    await saveMeta(id, { ...meta, stats, updatedAt: Date.now() });
  }

  return store;
}
