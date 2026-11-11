import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KB_TOOLS_GUIDE, KB_TOOL_NAMES, type BridgeServerMsg } from '@branch/core';
import { claudeArgs, createBridgeServer, type CliEnv } from '../src';
import { KB_MCP_SERVER_NAME, KB_MCP_TOOL_PREFIX } from '../src/kbTools/config';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(dir, 'fixtures/fake-claude.mjs');
const fakeCodex = path.join(dir, 'fixtures/fake-codex.mjs');

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function cliEnv(mode: string): CliEnv {
  return {
    env: { ...process.env, FAKE_MODE: mode },
    bin: { 'claude-cli': fakeClaude, 'codex-cli': fakeCodex },
  };
}

interface Outcome {
  text: string;
  errors: string[];
}

/** chat.start를 서버에 직접 보내고 결과를 모은다 (knowledgeId를 그대로 넘긴다) */
async function chat(
  server: ReturnType<typeof createBridgeServer>,
  providerId: 'claude-cli' | 'codex-cli',
  knowledgeId: unknown,
  extra: Record<string, unknown> = {},
): Promise<Outcome> {
  const reqId = `rq${Math.random().toString(36).slice(2, 10)}`;
  const out: Outcome = { text: '', errors: [] };
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const conn = server.connect((m: BridgeServerMsg) => {
    if (m.reqId !== reqId) return;
    if (m.type === 'chat.delta') out.text += m.text;
    else if (m.type === 'chat.error') {
      out.errors.push(m.error.message);
      finish();
    } else if (m.type === 'chat.done') finish();
  });
  conn.receive({
    type: 'chat.start',
    reqId,
    providerId,
    system: '튜터 지시',
    messages: [{ role: 'user', content: '질문' }],
    ...(knowledgeId === undefined ? {} : { knowledgeId }),
    ...extra,
  } as never);
  await finished;
  return out;
}

/** echo 모드 결과에서 작업 폴더(cwd)와 임시 폴더 이름만 뺀다 (매번 다르다) */
function normalize(text: string): Record<string, unknown> {
  const { cwd: _cwd, ...rest } = JSON.parse(text.replace(/branch-bridge-[A-Za-z0-9]+/g, 'branch-bridge-X')) as Record<string, unknown>;
  return rest;
}

/** Claude echo 결과의 --mcp-config에서 octobooks 서버 설정을 꺼낸다 */
function mcpServerOf(args: string[]): { command: string; args: string[]; env: Record<string, string> } {
  const cfg = JSON.parse(args[args.indexOf('--mcp-config') + 1]!) as { mcpServers: Record<string, never> };
  return (cfg.mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>)[KB_MCP_SERVER_NAME]!;
}

describe('claudeArgs — 지식베이스 MCP 도구', () => {
  const base = { systemFile: 's.txt' };
  const config = JSON.stringify({ mcpServers: { [KB_MCP_SERVER_NAME]: { type: 'stdio', command: 'node', args: [] } } });
  const tools = KB_TOOL_NAMES.map((n) => `${KB_MCP_TOOL_PREFIX}${n}`);

  it('지식베이스가 없으면 --tools는 빈 값, MCP·허용 도구 인자는 없다 (기존과 같음)', () => {
    const args = claudeArgs(base);
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--add-dir');
  });

  it('웹 검색만 켜면 --tools와 --allowedTools 모두 웹 도구만 (기존과 같음)', () => {
    const args = claudeArgs({ ...base, webSearch: true });
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('WebSearch,WebFetch');
  });

  it('지식베이스가 켜지면 MCP 설정과 엄격 모드를 넣고, 접두어 붙은 KB 도구만 허용한다', () => {
    const args = claudeArgs({ ...base, kbMcp: { config, tools } });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe(config);
    expect(args).toContain('--strict-mcp-config');
    const allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
    expect(allowed).toEqual(tools);
    expect(allowed).not.toContain('Read');
    expect(allowed).not.toContain('Glob');
    expect(allowed).not.toContain('Grep');
    expect(args).not.toContain('--add-dir');
  });

  it('지식베이스가 있으면 웹 검색을 켜도 웹 도구를 끈다 (자료 내용 유출 방지)', () => {
    const args = claudeArgs({ ...base, webSearch: true, kbMcp: { config, tools } });
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--allowedTools') + 1]).not.toContain('WebSearch');
  });

  it('지식베이스 도구 목록에는 옛 검색 도구와 파일 읽기 도구가 없다', () => {
    const args = claudeArgs({ ...base, kbMcp: { config, tools } });
    const allowed = args[args.indexOf('--allowedTools') + 1]!;
    expect(allowed).not.toContain('searchKnowledge');
    expect(allowed).not.toContain('Read');
  });
});

describe('bridge server — 지식베이스 연결 (MCP)', () => {
  let root: string;
  const KB_ID = 'kbaaaaaa';

  beforeAll(async () => {
    root = await tmp('kb-cli-');
    await mkdir(path.join(root, KB_ID, 'files'), { recursive: true });
    await writeFile(path.join(root, KB_ID, 'meta.json'), JSON.stringify({ name: '생물' }));
    await writeFile(path.join(root, KB_ID, 'files', 'a.txt'), '내용');
  });

  const launcher = () => ({ command: '/app/electron', args: ['/app/kbMcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' }, root });

  it('지식베이스가 있으면 Claude는 KB MCP 서버와 안내 문구를 받고, Codex는 같은 안내를 stdin으로 받는다', async () => {
    const claude = createBridgeServer({ cliEnv: cliEnv('echo'), knowledgeTools: launcher() });
    const c = await chat(claude, 'claude-cli', KB_ID);
    const echo = normalize(c.text) as { args: string[]; system: string };

    const srv = mcpServerOf(echo.args);
    expect(srv.command).toBe('/app/electron');
    expect(srv.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(srv.args).toEqual(['/app/kbMcp.cjs', '--root', root, '--kb', KB_ID]);
    expect(echo.args).toContain('--strict-mcp-config');
    expect(echo.args).not.toContain('--add-dir');
    expect(echo.args[echo.args.indexOf('--tools') + 1]).toBe('');

    expect(echo.system).toContain('튜터 지시');
    expect(echo.system).toContain('Knowledge bases available to this answer');
    expect(echo.system).toContain(`- 생물 (kbId: ${KB_ID})`);
    expect(echo.system).toContain(KB_TOOLS_GUIDE);
    expect(echo.system).toContain(`tool names are prefixed with ${KB_MCP_TOOL_PREFIX}`);

    const codex = createBridgeServer({ cliEnv: cliEnv('echo'), knowledgeTools: launcher() });
    const x = await chat(codex, 'codex-cli', KB_ID);
    const payload = JSON.parse(x.text) as { args: string[]; stdin: string };
    expect(payload.stdin).toContain('Knowledge bases available to this answer');
    expect(payload.stdin).toContain(`- 생물 (kbId: ${KB_ID})`);
    expect(payload.stdin).toContain(KB_TOOLS_GUIDE);
    expect(payload.stdin).not.toContain('prefixed with');
    expect(payload.args.join(' ')).toContain(`mcp_servers.${KB_MCP_SERVER_NAME}.args=["/app/kbMcp.cjs","--root","${root}","--kb","${KB_ID}"]`);
    // 샌드박스·셸 차단은 지식베이스가 있어도 그대로 (ADR-070)
    expect(payload.args[payload.args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(payload.args.join(' ')).toContain('features.shell_tool=false');
  });

  it('지식베이스 실행 정보가 없는 서버는 KB를 연결해도 MCP를 붙이지 않는다', async () => {
    const plain = createBridgeServer({ cliEnv: cliEnv('echo') });
    const out = normalize((await chat(plain, 'claude-cli', KB_ID)).text) as { args: string[]; system: string };
    expect(out.args).not.toContain('--mcp-config');
    expect(out.system).not.toContain('Knowledge bases available to this answer');
  });

  it('없는 지식베이스·형식이 틀린 id는 지식베이스가 없을 때와 똑같이 답한다', async () => {
    const plain = await chat(createBridgeServer({ cliEnv: cliEnv('echo') }), 'claude-cli', undefined);
    const unknown = await chat(createBridgeServer({ cliEnv: cliEnv('echo'), knowledgeTools: launcher() }), 'claude-cli', 'kbzzzzzzzz');
    const invalid = await chat(createBridgeServer({ cliEnv: cliEnv('echo'), knowledgeTools: launcher() }), 'claude-cli', '../../etc');

    expect(unknown.errors).toEqual([]);
    expect(invalid.errors).toEqual([]);
    expect(normalize(unknown.text)).toEqual(normalize(plain.text));
    expect(normalize(invalid.text)).toEqual(normalize(plain.text));
  });

  it('knowledgeAll이면 PC의 지식베이스 전체를 이름·설명과 함께 쓴다 (ADR-141, ADR-142)', async () => {
    const all = await tmp('kb-all-');
    for (const [id, name, description] of [
      ['kbaaaaaa', '생물', '세포·유전 정리'],
      ['kbbbbbbb', '화학', ''],
    ] as const) {
      await mkdir(path.join(all, id, 'files'), { recursive: true });
      await writeFile(path.join(all, id, 'meta.json'), JSON.stringify({ name, description }));
    }
    await mkdir(path.join(all, 'kbcccccc')); // files 폴더가 없으면 뺀다
    await mkdir(path.join(all, 'not-a-kb', 'files'), { recursive: true });
    const server = createBridgeServer({ cliEnv: cliEnv('echo'), knowledgeTools: { ...launcher(), root: all } });
    const echo = normalize((await chat(server, 'claude-cli', undefined, { knowledgeAll: true })).text) as { args: string[]; system: string };
    const kbArgs = mcpServerOf(echo.args).args.filter((_, i, a) => a[i - 1] === '--kb').sort();
    expect(kbArgs).toEqual(['kbaaaaaa', 'kbbbbbbb']);
    expect(echo.system).toContain('- 생물 (kbId: kbaaaaaa) — description: 세포·유전 정리');
    expect(echo.system).toContain('- 화학 (kbId: kbbbbbbb)');

    // 목록을 정했으면(빈 목록 포함) 전체를 쓰지 않는다
    const off = normalize((await chat(server, 'claude-cli', undefined, { knowledgeAll: true, knowledgeIds: [] })).text) as { args: string[] };
    expect(off.args).not.toContain('--mcp-config');
    const one = normalize((await chat(server, 'claude-cli', undefined, { knowledgeIds: ['kbbbbbbb'], knowledgeAll: true })).text) as { args: string[] };
    expect(mcpServerOf(one.args).args.filter((_, i, a) => a[i - 1] === '--kb')).toEqual(['kbbbbbbb']);
  });
});
