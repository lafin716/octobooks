import { describe, expect, it } from 'vitest';
import {
  checkId,
  extractTitle,
  GIT_HARDEN_ARGS,
  gitCloneArgs,
  gitErrorLine,
  gitPullArgs,
  htmlToMarkdown,
  isPrivateHost,
  isSafeSegment,
  slugify,
} from '../src/knowledgeStore';

describe('isPrivateHost — 내부 주소 차단', () => {
  const privateHosts = [
    'localhost',
    'app.localhost',
    'printer.local',
    'db.internal',
    '0.0.0.0',
    '127.0.0.1',
    '127.8.9.10',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '0.1.2.3',
    '::1',
    '[::1]',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.5',
    'fd00::1',
    'fe80::1',
    '64:ff9b::808:808',
  ];
  for (const h of privateHosts) {
    it(`${h} 는 내부 주소다`, () => {
      expect(isPrivateHost(h)).toBe(true);
    });
  }

  const publicHosts = ['example.com', 'github.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.128.0.1', '::ffff:8.8.8.8'];
  for (const h of publicHosts) {
    it(`${h} 는 공개 주소로 본다`, () => {
      expect(isPrivateHost(h)).toBe(false);
    });
  }
});

describe('checkId — 지식베이스 id', () => {
  it('형식이 맞는 id는 그대로 돌려준다', () => {
    expect(checkId('kbaaaaaa')).toBe('kbaaaaaa');
  });

  for (const bad of ['../kbaaaaaa', 'BAD ID', '', 'kb/aaaa', 42, undefined]) {
    it(`${JSON.stringify(bad)} 는 거부한다`, () => {
      expect(() => checkId(bad)).toThrow();
    });
  }
});

describe('isSafeSegment — 경로 조각', () => {
  it('일반 이름은 허용한다', () => {
    expect(isSafeSegment('ok.md')).toBe(true);
    expect(isSafeSegment('강의 노트 1.pdf')).toBe(true);
  });

  const bad = ['', '.', '..', '.git', '.env', 'CON', 'nul.txt', 'com1', 'a:b', 'a*b', 'a?b', 'a|b', 'a\\b', 'a/b', 'trail.', 'x\u0001y', 'a'.repeat(256)];
  for (const s of bad) {
    it(`${JSON.stringify(s.length > 20 ? s.slice(0, 20) + '…' : s)} 는 거부한다`, () => {
      expect(isSafeSegment(s)).toBe(false);
    });
  }
});

describe('slugify — 파일 이름 만들기', () => {
  it('금지 문자는 공백으로 바꾸고 연속 공백은 하나로 줄인다', () => {
    expect(slugify('안녕/세상?  <테스트>')).toBe('안녕 세상 테스트');
  });

  it('앞뒤 점과 공백을 떼고, 남는 게 없으면 page를 쓴다', () => {
    expect(slugify('...   ')).toBe('page');
    expect(slugify('')).toBe('page');
    expect(slugify('.hidden')).toBe('hidden');
  });

  it('최대 60자로 자른다', () => {
    expect(slugify('가'.repeat(100))).toHaveLength(60);
  });
});

describe('git 인자 (ADR-138 하드닝)', () => {
  it('하드닝 옵션은 심볼릭 링크·자격 증명 도우미·훅·fsmonitor를 끈다', () => {
    const joined = GIT_HARDEN_ARGS.join(' ');
    expect(joined).toContain('core.symlinks=false');
    expect(joined).toContain('credential.helper=');
    expect(joined).toContain('core.hooksPath=/dev/null');
    expect(joined).toContain('core.fsmonitor=false');
  });

  it('clone 인자는 하드닝 옵션 뒤에 얕은 클론 옵션과 -- 구분자를 둔다', () => {
    const args = gitCloneArgs('https://github.com/octo/repo', '/tmp/dest');
    expect(args.slice(0, GIT_HARDEN_ARGS.length)).toEqual([...GIT_HARDEN_ARGS]);
    expect(args.slice(GIT_HARDEN_ARGS.length)).toEqual([
      'clone',
      '--depth',
      '1',
      '--single-branch',
      '--no-tags',
      '--progress',
      '--',
      'https://github.com/octo/repo',
      '/tmp/dest',
    ]);
  });

  it('pull 인자는 빨리 감기만 허용한다', () => {
    const args = gitPullArgs();
    expect(args.slice(GIT_HARDEN_ARGS.length)).toEqual(['pull', '--ff-only', '--depth', '1']);
  });
});

describe('gitErrorLine — git 오류 한 줄', () => {
  it('fatal 줄을 고르고 접두어를 뗀다', () => {
    expect(gitErrorLine(['Cloning into x...', 'fatal: repository not found'], 128)).toBe('repository not found');
  });

  it('fatal이 없으면 error 줄을 고른다', () => {
    expect(gitErrorLine(['noise', 'error: pack failed'], 1)).toBe('pack failed');
  });

  it('둘 다 없으면 마지막 줄 (Cloning 줄은 제외)', () => {
    expect(gitErrorLine(['Cloning into x...', 'something odd'], 1)).toBe('something odd');
  });

  it('메시지가 없으면 종료 코드를 쓴다', () => {
    expect(gitErrorLine([], 2)).toBe('exit 2');
    expect(gitErrorLine(['Cloning into x...'], null)).toBe('exit ?');
  });
});

describe('htmlToMarkdown / extractTitle — 웹 페이지 본문', () => {
  it('스크립트·스타일·주석은 버리고 제목·링크·목록은 살린다', () => {
    const md = htmlToMarkdown(`
      <html><head><title>문서</title><style>p{color:red}</style></head>
      <body><!-- 숨김 --><script>alert(1)</script>
      <h1>소개</h1><p>본문 <a href="https://example.com/a">링크</a> 입니다.</p>
      <ul><li>하나</li><li>둘</li></ul>
      <a href="#top">위로</a></body></html>`);
    expect(md).toContain('# 소개');
    expect(md).toContain('[링크](https://example.com/a)');
    expect(md).toContain('- 하나');
    expect(md).toContain('- 둘');
    expect(md).toContain('위로');
    expect(md).not.toContain('(#top)');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('color:red');
    expect(md).not.toContain('숨김');
    expect(md).not.toContain('<');
  });

  it('HTML 엔티티를 풀되 코드 포인트가 잘못되면 버린다', () => {
    const md = htmlToMarkdown('<p>a &amp; b &lt;c&gt; &#x41;&#65; &#xD800; &#99999999;</p>');
    expect(md).toContain('a & b <c> AA');
    expect(md).not.toContain('\uD800');
  });

  it('제목 추출은 엔티티를 풀고 120자로 자른다', () => {
    expect(extractTitle('<title>  안녕 &amp; 반가워  </title>')).toBe('안녕 & 반가워');
    expect(extractTitle('<title>' + '가'.repeat(200) + '</title>')).toHaveLength(120);
    expect(extractTitle('<p>제목 없음</p>')).toBe('');
  });
});
