import { gunzipSync } from 'node:zlib';

/**
 * GitHub 압축 파일(tar.gz) 읽기 (ADR-138). 외부 라이브러리 없이 zlib와 최소 tar 파서로 푼다.
 * 링크·장치·경로 탈출·숨김 항목은 건너뛰고, 크기·개수 한도를 넘으면 실패한다.
 * 파일 내용은 메모리에 올리므로 한도는 보수적으로 잡는다. 디스크에는 쓰지 않는다(호출자가 쓴다).
 */

export interface TarLimits {
  /** 항목 수 상한 (디렉터리 포함) */
  maxEntries: number;
  /** 파일 하나 최대 크기 (넘으면 건너뛴다) */
  maxFileBytes: number;
  /** 풀린 전체 크기 상한 (넘으면 실패) */
  maxTotalBytes: number;
}

export interface TarFileEntry {
  /** 압축 파일 최상위 폴더(저장소-커밋) 이름을 뗀 POSIX 상대 경로 */
  path: string;
  dir: boolean;
  data?: Uint8Array;
}

export interface TarResult {
  entries: TarFileEntry[];
  /** 링크·특수 파일·숨김 항목·너무 큰 파일 등으로 건너뛴 수 */
  skipped: number;
}

/** 압축 파일 형식이 잘못됐거나 한도를 넘었을 때 */
export class TarFormatError extends Error {
  constructor(readonly reason: 'format' | 'too_many' | 'too_large' | 'escape') {
    super(reason);
    this.name = 'TarFormatError';
  }
}

const BLOCK = 512;

function readString(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  while (end < start + len && buf[end] !== 0) end++;
  return new TextDecoder('utf-8').decode(buf.subarray(start, end));
}

function readOctal(buf: Uint8Array, start: number, len: number): number {
  // GNU base-256 확장: 최상위 비트가 켜지면 이진수로 읽는다
  if (buf[start]! & 0x80) {
    let v = 0;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i]!;
    return v;
  }
  const s = readString(buf, start, len).replace(/[\s\0]+$/g, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarFormatError('format');
  return parseInt(s, 8);
}

/** pax 확장 헤더 레코드 (`<길이> <키>=<값>\n`)를 읽는다 */
function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder('utf-8');
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(dec.decode(data.subarray(pos, sp)), 10);
    if (!Number.isInteger(len) || len <= 0 || pos + len > data.length) break;
    const rec = dec.decode(data.subarray(sp + 1, pos + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** 저장소 폴더 이름을 떼고, 경로 탈출·절대 경로·역슬래시를 막는다. 건너뛸 항목이면 null */
function normalizeName(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) throw new TarFormatError('escape');
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new TarFormatError('escape');
  // 첫 조각은 저장소 최상위 폴더이므로 뗀다
  const rest = parts.slice(1);
  if (rest.length === 0) return null;
  // 숨김 항목(.git, .github 등)은 가져오지 않는다 — 목록·복사 규칙과 같다
  if (rest.some((p) => p.startsWith('.'))) return null;
  return rest.join('/');
}

/**
 * tar.gz 바이트를 풀어 파일·폴더 목록을 돌려준다.
 * 링크(심볼릭·하드)는 만들지 않고 건너뛴다. 전체 크기나 항목 수가 한도를 넘으면 TarFormatError.
 */
export function parseTarGz(gz: Uint8Array, limits: TarLimits): TarResult {
  let tar: Buffer;
  try {
    // 전체 풀림 크기를 상한으로 막아, 압축 폭탄이 메모리를 채우지 못하게 한다
    tar = gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + BLOCK * 4 });
  } catch (err) {
    if (err instanceof RangeError) throw new TarFormatError('too_large');
    throw new TarFormatError('format');
  }

  const entries: TarFileEntry[] = [];
  let skipped = 0;
  let total = 0;
  let pos = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let pendingPax: Record<string, string> | null = null;

  while (pos + BLOCK <= tar.length) {
    const header = tar.subarray(pos, pos + BLOCK);
    if (header.every((b) => b === 0)) break;
    let size = readOctal(tar, pos + 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    // 앞선 pax 레코드의 size는 이 항목의 데이터 길이(=다음 헤더 위치)를 바꾼다
    if (pendingPax && type !== 'x' && type !== 'g') {
      paxPath = pendingPax.path ?? null;
      if (pendingPax.size !== undefined) {
        const n = Number(pendingPax.size);
        if (!Number.isSafeInteger(n) || n < 0) throw new TarFormatError('format');
        size = n;
      }
      pendingPax = null;
    }
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new TarFormatError('format');
    const data = tar.subarray(dataStart, dataEnd);
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // pax 헤더와 GNU 긴 이름은 다음 항목에 적용되는 메타 항목이다
    if (type === 'x') {
      pendingPax = parsePax(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = readString(data, 0, data.length);
      continue;
    }
    if (type === 'K') continue;

    // ustar 접두어(345~500)와 이름(0~100)을 합친다
    const prefix = readString(header, 345, 155);
    const ustar = readString(header, 257, 6) === 'ustar';
    const rawName = paxPath ?? longName ?? (ustar && prefix ? `${prefix}/${readString(header, 0, 100)}` : readString(header, 0, 100));
    paxPath = null;
    longName = null;

    const isDir = type === '5' || (type === '0' && rawName.endsWith('/') && size === 0);
    const isFile = type === '0' || type === '\0' || type === '7';
    if (!isDir && !isFile) {
      // 링크·장치·FIFO 등은 만들지 않는다
      if (type === '1' || type === '2') normalizeName(rawName);
      skipped++;
      continue;
    }
    const rel = normalizeName(rawName);
    if (rel === null) {
      skipped++;
      continue;
    }
    if (entries.length >= limits.maxEntries) throw new TarFormatError('too_many');
    if (isDir) {
      entries.push({ path: rel, dir: true });
      continue;
    }
    if (size > limits.maxFileBytes) {
      skipped++;
      continue;
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new TarFormatError('too_large');
    entries.push({ path: rel, dir: false, data: data.slice(0, size) });
  }
  return { entries, skipped };
}
