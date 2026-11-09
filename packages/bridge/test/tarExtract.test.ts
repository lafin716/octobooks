import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseTarGz, TarFormatError, type TarLimits } from '../src/tarExtract';
import { gz, paxRecord, tarBytes } from './helpers/tar';

const LIMITS: TarLimits = { maxEntries: 1000, maxFileBytes: 1 << 20, maxTotalBytes: 1 << 24 };
const enc = new TextEncoder();

describe('parseTarGz — 기본 해제', () => {
  it('최상위 저장소 폴더를 떼고 파일과 폴더를 돌려준다', () => {
    const r = parseTarGz(
      gz([
        { name: 'repo-abc/', type: '5' },
        { name: 'repo-abc/src/', type: '5' },
        { name: 'repo-abc/src/a.ts', body: 'export const a = 1;' },
        { name: 'repo-abc/README.md', body: '# hi' },
      ]),
      LIMITS,
    );
    // 최상위 폴더 항목 자체는 건너뛴 것으로 센다
    expect(r.skipped).toBe(1);
    expect(r.entries.map((e) => [e.path, e.dir])).toEqual([
      ['src', true],
      ['src/a.ts', false],
      ['README.md', false],
    ]);
    const file = r.entries.find((e) => e.path === 'src/a.ts')!;
    expect(new TextDecoder().decode(file.data)).toBe('export const a = 1;');
  });

  it('최상위 폴더 자체(이름만 있는 항목)는 목록에 넣지 않는다', () => {
    const r = parseTarGz(gz([{ name: 'repo-abc/', type: '5' }, { name: 'repo-abc/x.txt', body: 'x' }]), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['x.txt']);
  });

  it('파일 내용이 512바이트 경계를 넘어도 정확히 읽는다', () => {
    const body = 'a'.repeat(1300);
    const r = parseTarGz(gz([{ name: 'r/big.txt', body }]), LIMITS);
    expect(r.entries[0]!.data!.length).toBe(1300);
  });

  it('형식이 깨진 gzip은 format 오류', () => {
    expect(() => parseTarGz(new Uint8Array([1, 2, 3, 4]), LIMITS)).toThrow(TarFormatError);
    try {
      parseTarGz(new Uint8Array([1, 2, 3, 4]), LIMITS);
    } catch (err) {
      expect((err as TarFormatError).reason).toBe('format');
    }
  });

  it('헤더 크기가 파일 끝을 넘으면 format 오류', () => {
    const bad = gz([{ name: 'r/a.txt', body: 'abc', sizeField: 99999 }]);
    expect(() => parseTarGz(bad, LIMITS)).toThrow(TarFormatError);
  });

  it('크기 필드가 8진수가 아니면 format 오류', () => {
    const raw = tarBytes([{ name: 'r/a.txt', body: 'abc' }]);
    raw.set(enc.encode('zzzzzzzzzzz\0'), 124);
    expect(() => parseTarGz(new Uint8Array(gzipSync(raw)), LIMITS)).toThrow(TarFormatError);
  });
});

describe('parseTarGz — 한도', () => {
  it('항목 수가 maxEntries를 넘으면 too_many', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ name: `r/f${i}.txt`, body: 'x' }));
    try {
      parseTarGz(gz(items), { ...LIMITS, maxEntries: 3 });
      expect.unreachable();
    } catch (err) {
      expect((err as TarFormatError).reason).toBe('too_many');
    }
  });

  it('파일 하나가 maxFileBytes를 넘으면 실패하지 않고 건너뛴다', () => {
    const r = parseTarGz(gz([{ name: 'r/small.txt', body: 'ok' }, { name: 'r/big.bin', body: 'x'.repeat(200) }]), {
      ...LIMITS,
      maxFileBytes: 100,
    });
    expect(r.entries.map((e) => e.path)).toEqual(['small.txt']);
    expect(r.skipped).toBe(1);
  });

  it('풀린 전체 크기가 maxTotalBytes를 넘으면 too_large', () => {
    try {
      parseTarGz(gz([{ name: 'r/a.txt', body: 'x'.repeat(600) }, { name: 'r/b.txt', body: 'y'.repeat(600) }]), {
        ...LIMITS,
        maxTotalBytes: 1000,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as TarFormatError).reason).toBe('too_large');
    }
  });

  it('압축 폭탄(풀림 크기가 상한을 넘는 gzip)은 too_large로 막는다', () => {
    const bomb = new Uint8Array(gzipSync(new Uint8Array(4 * 1024 * 1024)));
    try {
      parseTarGz(bomb, { ...LIMITS, maxTotalBytes: 64 * 1024 });
      expect.unreachable();
    } catch (err) {
      expect((err as TarFormatError).reason).toBe('too_large');
    }
  });
});

describe('parseTarGz — 경로 탈출', () => {
  const escapes: [string, string][] = [
    ['상위 폴더 ..', 'r/../../etc/passwd'],
    ['가운데 ..', 'r/a/../../b.txt'],
    ['절대 경로', '/etc/passwd'],
    ['역슬래시', 'r/a\\b.txt'],
    ['윈도 드라이브', 'C:/x.txt'],
  ];
  for (const [label, name] of escapes) {
    it(`${label}은 escape로 거부한다`, () => {
      try {
        parseTarGz(gz([{ name, body: 'x' }]), LIMITS);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(TarFormatError);
        expect((err as TarFormatError).reason).toBe('escape');
      }
    });
  }

  it('ustar 접두어와 이름을 합쳐 경로를 만든다', () => {
    const r = parseTarGz(gz([{ name: 'b.txt', prefix: 'r/a', body: 'x' }]), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['a/b.txt']);
  });

  it('숨김 항목(.git, .github)은 건너뛴다', () => {
    const r = parseTarGz(
      gz([
        { name: 'r/.git/config', body: '[core]' },
        { name: 'r/.github/ci.yml', body: 'x' },
        { name: 'r/src/.env', body: 'SECRET=1' },
        { name: 'r/src/ok.ts', body: 'ok' },
      ]),
      LIMITS,
    );
    expect(r.entries.map((e) => e.path)).toEqual(['src/ok.ts']);
    expect(r.skipped).toBe(3);
  });
});

describe('parseTarGz — 링크와 특수 항목', () => {
  it('심볼릭 링크(2)와 하드 링크(1)는 만들지 않고 건너뛴다', () => {
    const r = parseTarGz(
      gz([
        { name: 'r/real.txt', body: 'x' },
        { name: 'r/sym', type: '2', linkname: '/etc/passwd' },
        { name: 'r/hard', type: '1', linkname: 'real.txt' },
      ]),
      LIMITS,
    );
    expect(r.entries.map((e) => e.path)).toEqual(['real.txt']);
    expect(r.skipped).toBe(2);
  });

  it('링크 항목의 이름도 탈출 경로면 거부한다', () => {
    expect(() => parseTarGz(gz([{ name: 'r/../sym', type: '2', linkname: 'x' }]), LIMITS)).toThrow(TarFormatError);
  });

  it('장치·FIFO 항목은 건너뛴다', () => {
    const r = parseTarGz(gz([{ name: 'r/fifo', type: '6' }, { name: 'r/c', type: '3' }, { name: 'r/ok', body: 'x' }]), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['ok']);
    expect(r.skipped).toBe(2);
  });
});

describe('parseTarGz — pax 확장 헤더', () => {
  it('pax path 레코드가 긴 이름을 대신한다', () => {
    const longPath = `r/${'deep/'.repeat(30)}file.txt`;
    const pax = paxRecord('path', longPath);
    const r = parseTarGz(
      gz([
        { name: 'PaxHeader', type: 'x', body: pax },
        { name: 'short', body: 'hello' },
      ]),
      LIMITS,
    );
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.path).toBe(`${'deep/'.repeat(30)}file.txt`);
    expect(new TextDecoder().decode(r.entries[0]!.data)).toBe('hello');
  });

  it('pax size 레코드가 헤더 크기를 대신한다', () => {
    const pax = paxRecord('size', '5');
    const raw = tarBytes([
      { name: 'PaxHeader', type: 'x', body: pax },
      { name: 'r/s.txt', body: 'abcde' },
    ]);
    const r = parseTarGz(new Uint8Array(gzipSync(raw)), LIMITS);
    expect(new TextDecoder().decode(r.entries[0]!.data)).toBe('abcde');
  });

  it('pax size가 헤더 크기와 다르면 pax 기준으로 다음 헤더를 찾는다', () => {
    const r = parseTarGz(
      gz([
        { name: 'PaxHeader', type: 'x', body: paxRecord('size', '5') },
        { name: 'r/big.txt', body: 'abcde', sizeField: 0 },
        { name: 'r/next.txt', body: 'n' },
      ]),
      LIMITS,
    );
    expect(r.entries.map((e) => e.path)).toEqual(['big.txt', 'next.txt']);
    expect(new TextDecoder().decode(r.entries[0]!.data)).toBe('abcde');
  });

  it('잘못된 pax size는 format 오류', () => {
    const pax = paxRecord('size', '-3');
    expect(() =>
      parseTarGz(gz([{ name: 'PaxHeader', type: 'x', body: pax }, { name: 'r/a', body: 'x' }]), LIMITS),
    ).toThrow(TarFormatError);
  });

  it('전역 pax(g) 헤더는 무시한다', () => {
    const r = parseTarGz(gz([{ name: 'pax_global', type: 'g', body: paxRecord('comment', 'x') }, { name: 'r/a.txt', body: 'a' }]), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['a.txt']);
  });
});

describe('parseTarGz — GNU 확장', () => {
  it('GNU L 항목의 긴 이름을 쓴다', () => {
    const longName = `r/${'longdir/'.repeat(25)}note.md`;
    const r = parseTarGz(
      gz([
        { name: '././@LongLink', type: 'L', body: `${longName}\0` },
        { name: 'truncated', body: '# note' },
      ]),
      LIMITS,
    );
    expect(r.entries[0]!.path).toBe(`${'longdir/'.repeat(25)}note.md`);
  });

  it('GNU K(긴 링크 대상) 항목은 무시한다', () => {
    const r = parseTarGz(gz([{ name: '././@LongLink', type: 'K', body: 'target\0' }, { name: 'r/a.txt', body: 'a' }]), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['a.txt']);
  });

  it('base-256으로 적은 큰 크기 필드를 읽는다', () => {
    const r = parseTarGz(gz([{ name: 'r/b.txt', body: 'base', base256: true }]), LIMITS);
    expect(new TextDecoder().decode(r.entries[0]!.data)).toBe('base');
  });

  it('magic이 없는 옛 tar(v7)도 읽는다', () => {
    const r = parseTarGz(gz([{ name: 'r/old.txt', body: 'v7', magic: 'none' }]), LIMITS);
    expect(r.entries.map((e) => e.path)).toEqual(['old.txt']);
  });
});
