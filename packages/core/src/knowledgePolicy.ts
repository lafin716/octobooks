/**
 * 지식베이스 공통 순수 헬퍼 (플랫폼 무관). 코드베이스 탐색 도구의 제외 규칙·파일 확장자 판별을 담는다.
 * 유형별 검색 정책(벡터·색인 허용 여부)과 구버전 유형 판별은 ADR-137 이후 제거되었다.
 */

// ── 코드베이스 제외 경로 ────────────────────────────────

/**
 * 코드베이스 기본 제외 (빌드 산출물·의존성·VCS·캐시). 사용자 excludes와 .gitignore가 여기에 더해진다.
 * 끝의 '/'는 폴더만, 그 밖은 이름 꼴(glob).
 */
export const DEFAULT_CODEBASE_EXCLUDES: readonly string[] = [
  '.git/',
  'node_modules/',
  'bower_components/',
  'vendor/bundle/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  'coverage/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  'Pods/',
  'DerivedData/',
  '*.min.js',
  '*.map',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
];

/** 바이너리로 보고 내용 검색에서 빼는 확장자 (내용 확인 전에 거른다) */
export const BINARY_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tif', 'tiff', 'psd', 'heic',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm', 'm4a',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'jar', 'war', 'whl', 'dmg', 'iso', 'pkg', 'deb', 'rpm',
  'exe', 'dll', 'so', 'dylib', 'a', 'o', 'obj', 'lib', 'class', 'pyc', 'pyo', 'wasm', 'node', 'bin', 'dat',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'sqlite', 'db', 'sqlite3', 'pack', 'idx',
]);

export const EXCLUDES_MAX = 100;
const EXCLUDE_PATTERN_MAX = 200;

/** 사용자 제외 패턴 정리: 공백·주석·중복 제거, `..`·절대 경로·제어 문자 금지, 최대 EXCLUDES_MAX개 */
export function cleanExcludes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\\/g, '/');
    if (!s || s.startsWith('#') || s.length > EXCLUDE_PATTERN_MAX) continue;
    if (s.split('/').includes('..') || /^[A-Za-z]:/.test(s)) continue;
    const norm = s.replace(/^\.\//, '').replace(/^\/+/, '/');
    if (!norm || norm === '/' || out.includes(norm)) continue;
    out.push(norm);
    if (out.length >= EXCLUDES_MAX) break;
  }
  return out;
}

/** glob 한 조각을 정규식으로 (`*` = 경로 구분자 제외 아무거나, `?` = 한 글자, `**` = 여러 단계) */
function globToRegex(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return re;
}

export interface ExcludeMatcher {
  /** rel: 루트 기준 POSIX 경로, dir: 폴더인가 */
  (rel: string, dir: boolean): boolean;
}

/**
 * gitignore 꼴 패턴 묶음을 판정 함수로. 지원: `name`(어느 깊이든 이름 일치), `dir/`(폴더만),
 * `/root-only`, `a/b/*.ts`(경로 패턴, 루트 기준), `**`, `!negation`(뒤 규칙이 앞 규칙을 뒤집음).
 * 완전한 gitignore 구현은 아니지만 흔한 꼴은 맞춘다. 판정이 틀려도 결과에서 빠지거나 더 들어올 뿐 범위 밖으로 나가지는 않는다.
 */
export function compileExcludes(patterns: readonly string[]): ExcludeMatcher {
  const rules: { re: RegExp; dirOnly: boolean; negate: boolean }[] = [];
  for (const raw of patterns) {
    let p = raw.trim();
    if (!p || p.startsWith('#')) continue;
    let negate = false;
    if (p.startsWith('!')) {
      negate = true;
      p = p.slice(1);
    }
    let dirOnly = false;
    if (p.endsWith('/')) {
      dirOnly = true;
      p = p.replace(/\/+$/, '');
    }
    if (!p) continue;
    const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
    p = p.replace(/^\/+/, '');
    const body = globToRegex(p);
    const re = anchored ? new RegExp(`^${body}$`) : new RegExp(`(^|/)${body}$`);
    rules.push({ re, dirOnly, negate });
  }
  return (rel: string, dir: boolean): boolean => {
    let excluded = false;
    for (const r of rules) {
      if (r.dirOnly && !dir) continue;
      if (r.re.test(rel)) excluded = !r.negate;
    }
    return excluded;
  };
}

/** 파일 확장자 (소문자, 점 없이). 없으면 '' */
export function extOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}
