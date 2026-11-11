import { t } from './i18n';

/**
 * 업로드 자동 설명 (ADR-143). 지식베이스에 자료를 넣을 때마다 "무엇을 넣었는지" 한 줄을 만들어
 * 설명 끝에 붙인다. 답변 모델은 이 설명을 보고 질문과 관련 있는 지식베이스인지 판단한다 (ADR-142).
 * 순수 함수만 둔다. 파일을 훑는 일(확장자 세기, 제목 읽기)은 bridge가 하고 결과(UploadProfile)만 넘긴다.
 */

/** 업로드 방식 */
export type UploadKind = 'files' | 'folder' | 'github' | 'web';

/** bridge가 훑어서 넘기는 업로드 요약 */
export interface UploadProfile {
  kind: UploadKind;
  /** 넣은 최상위 항목 이름 (파일 이름, 폴더 이름, 저장소 이름, 페이지 제목) */
  names: string[];
  /** 넣은 파일 수 (폴더 안 파일 포함) */
  fileCount: number;
  /** 소문자 확장자(점 없음) → 파일 수. 확장자가 없으면 '' */
  exts: Record<string, number>;
  /** 문서 제목 (마크다운 첫 제목, 웹 페이지 제목 등) */
  titles: string[];
  /** package.json·pyproject·Cargo·README에서 읽은 프로젝트 이름과 소개 */
  manifest?: { name?: string; description?: string };
}

/** 자동 설명 한 줄의 표시 (사용자가 쓴 설명과 구분해 오래된 자동 줄부터 줄인다) */
export const AUTO_DESCRIPTION_RE = /^- \d{4}-\d{2}-\d{2} /;
/** 지식베이스 설명 최대 길이 (사용자 설명 + 자동 줄) */
export const KNOWLEDGE_DESCRIPTION_MAX = 2000;

const CODE_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  swift: 'Swift', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++',
  cs: 'C#', rb: 'Ruby', php: 'PHP', scala: 'Scala', dart: 'Dart', lua: 'Lua',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', sql: 'SQL',
  vue: 'Vue', svelte: 'Svelte', ex: 'Elixir', exs: 'Elixir', hs: 'Haskell',
  clj: 'Clojure', r: 'R', m: 'Objective-C', mm: 'Objective-C', zig: 'Zig',
  html: 'HTML', css: 'CSS', scss: 'CSS', less: 'CSS',
};

type Category = 'code' | 'doc' | 'pdf' | 'office' | 'data' | 'image' | 'other';

const DOC_EXT = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'org', 'tex']);
const OFFICE_EXT = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'hwp', 'hwpx', 'odt', 'odp', 'ods', 'key', 'pages', 'numbers', 'rtf']);
const DATA_EXT = new Set(['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'ini', 'ipynb']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic']);

function categoryOf(ext: string): Category {
  if (CODE_LANG[ext]) return 'code';
  if (DOC_EXT.has(ext)) return 'doc';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (DATA_EXT.has(ext)) return 'data';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

/** 제어 문자·줄바꿈을 지우고 길이를 줄인다 (설명은 한 줄씩 쌓인다) */
export function clipLine(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- 제어 문자 제거가 목적
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…` : one;
}

const quote = (s: string) => `'${clipLine(s, 60)}'`;

/** 언어별 코드 파일 수 (많은 순, 상위 3개) */
function topLanguages(exts: Record<string, number>): string[] {
  const byLang = new Map<string, number>();
  for (const [ext, n] of Object.entries(exts)) {
    const lang = CODE_LANG[ext];
    if (lang) byLang.set(lang, (byLang.get(lang) ?? 0) + n);
  }
  return [...byLang.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([l]) => l);
}

/** 업로드 하나를 설명하는 한 줄. 예: "- 2026-11-11 GitHub repo: TypeScript 코드 120개, 문서 8개 — 'CLI 도구'" */
export function describeUpload(p: UploadProfile, date: string): string {
  const counts: Record<Category, number> = { code: 0, doc: 0, pdf: 0, office: 0, data: 0, image: 0, other: 0 };
  for (const [ext, n] of Object.entries(p.exts)) counts[categoryOf(ext.toLowerCase())] += n;

  const parts: string[] = [];
  if (counts.code) {
    const langs = topLanguages(p.exts);
    parts.push(t('bridge.knowledge.auto.code', { langs: langs.join('·'), n: counts.code }));
  }
  if (counts.doc) parts.push(t('bridge.knowledge.auto.doc', { n: counts.doc }));
  if (counts.pdf) parts.push(t('bridge.knowledge.auto.pdf', { n: counts.pdf }));
  if (counts.office) parts.push(t('bridge.knowledge.auto.office', { n: counts.office }));
  if (counts.data) parts.push(t('bridge.knowledge.auto.data', { n: counts.data }));
  if (counts.image) parts.push(t('bridge.knowledge.auto.image', { n: counts.image }));
  if (counts.other) parts.push(t('bridge.knowledge.auto.other', { n: counts.other }));

  const names = p.names.filter(Boolean);
  const shown = names.slice(0, 3).map((n) => clipLine(n, 60)).join(', ');
  const more = names.length > 3 ? t('bridge.knowledge.auto.more', { n: names.length - 3 }) : '';
  const label = t(`bridge.knowledge.auto.kind.${p.kind}`);
  let line = `- ${date} ${label} ${shown}${more}`;
  // 파일 하나·웹 페이지 하나는 종류만 보여도 충분하다. 여러 개면 종류별 개수를 붙인다
  if (parts.length && (p.fileCount > 1 || p.kind === 'folder' || p.kind === 'github')) line += `: ${parts.join(', ')}`;
  else if (parts.length && p.kind === 'files') line += ` (${parts.join(', ')})`;

  const about: string[] = [];
  const m = p.manifest;
  if (m?.description) about.push(quote(m.description));
  else if (m?.name && m.name !== names[0]) about.push(quote(m.name));
  const titles = [...new Set(p.titles.map((x) => clipLine(x, 60)).filter(Boolean))]
    .filter((x) => !names.includes(x))
    .slice(0, 3);
  if (titles.length) about.push(t('bridge.knowledge.auto.topics', { list: titles.join(', ') }));
  if (about.length) line += ` — ${about.join(' ')}`;
  return clipLine(line, 300);
}

/**
 * 설명 끝에 자동 줄을 붙인다. 최대 길이를 넘으면 가장 오래된 자동 줄부터 지운다.
 * 사용자가 쓴 줄은 지우지 않는다. 그래도 넘으면 새 줄을 붙이지 않는다.
 */
export function appendAutoDescription(current: string | undefined, line: string, max = KNOWLEDGE_DESCRIPTION_MAX): string {
  const base = (current ?? '').trim();
  const add = line.trim();
  if (!add) return base;
  const lines = base ? base.split('\n') : [];
  const join = (ls: string[]) => [...ls, add].join('\n').trim();
  let next = join(lines);
  while (next.length > max) {
    const i = lines.findIndex((l) => AUTO_DESCRIPTION_RE.test(l));
    if (i < 0) return base;
    lines.splice(i, 1);
    next = join(lines);
  }
  return next;
}
