// 테스트용 tar.gz 만들기 (헤더 체크섬·ustar·pax·GNU 확장 형식을 직접 쓴다)
import { gzipSync } from 'node:zlib';

const enc = new TextEncoder();

export interface Item {
  name: string;
  type?: string;
  body?: string | Uint8Array;
  linkname?: string;
  /** 헤더 크기 필드를 직접 넣을 때 (body와 독립) */
  sizeField?: number;
  /** GNU base-256 크기 표기 사용 */
  base256?: boolean;
  magic?: 'ustar' | 'none';
  prefix?: string;
}

function octal(n: number, len: number): Uint8Array {
  return enc.encode(n.toString(8).padStart(len - 1, '0') + '\0');
}

function base256(n: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  out[0] = 0x80;
  let v = n;
  for (let i = len - 1; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function header(it: Item, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (off: number, bytes: Uint8Array) => h.set(bytes.subarray(0, Math.min(bytes.length, 512 - off)), off);
  put(0, enc.encode(it.name));
  put(100, octal(it.type === '5' ? 0o755 : 0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, it.base256 ? base256(size, 12) : octal(size, 12));
  put(136, octal(0, 12));
  put(148, enc.encode('        '));
  put(156, enc.encode(it.type ?? '0'));
  if (it.linkname) put(157, enc.encode(it.linkname));
  if (it.magic !== 'none') {
    put(257, enc.encode('ustar\0'));
    put(263, enc.encode('00'));
  }
  if (it.prefix) put(345, enc.encode(it.prefix));
  let sum = 0;
  for (const b of h) sum += b;
  put(148, enc.encode(sum.toString(8).padStart(6, '0') + '\0 '));
  return h;
}

export function tarBytes(items: Item[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const it of items) {
    const body = typeof it.body === 'string' ? enc.encode(it.body) : (it.body ?? new Uint8Array());
    parts.push(header(it, it.sizeField ?? body.length));
    if (body.length > 0) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const gz = (items: Item[]): Uint8Array => new Uint8Array(gzipSync(tarBytes(items)));

/** pax 레코드 한 줄: `<길이> <키>=<값>\n` (길이는 자기 자신을 포함) */
export function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bytes = enc.encode(body).length;
  let len = bytes + 1;
  while (String(len).length + bytes !== len) len = String(len).length + bytes;
  return `${len}${body}`;
}
