import 'fake-indexeddb/auto';
import { splitUpload, SyncRpcFailure, uploadChunkArgs, type DesktopKnowledgeApi, type SyncRpcMethod } from '@branch/core';
import { describe, expect, it, vi } from 'vitest';

const added: { id: string; name: string; size: number; dest?: string }[] = [];
const removed: string[] = [];
const trees: Array<[string, string]> = [];
const pulled: Array<[string, string]> = [];
const fakeKnowledge = {
  list: async () => [],
  create: async (name: string) => ({ id: 'kbabc123', name }),
  remove: async (id: string) => { removed.push(id); },
  tree: async (id: string, dir: string) => { trees.push([id, dir]); return []; },
  pullGit: async (id: string, path: string) => { pulled.push([id, path]); return { added: [], skipped: 0 }; },
  removeEntry: async () => { throw new Error("Error invoking remote method 'knowledge:removeEntry': Error: 디스크 오류"); },
  addFiles: async (id: string, files: { name: string; data: Uint8Array }[], dest?: string) => {
    for (const f of files) added.push({ id, name: f.name, size: f.data.length, ...(dest ? { dest } : {}) });
    return { added: files.map((f) => f.name) };
  },
} as unknown as DesktopKnowledgeApi;

vi.mock('../src/app/runtime', async (orig) => ({ ...(await orig<object>()), desktop: { knowledge: fakeKnowledge } }));

const { createSyncRpcHandler, scheduleSignature } = await import('../src/app/syncRpc');

const setup = (allow = false) => {
  const events: string[] = [];
  const h = createSyncRpcHandler({ allowDelete: () => allow, emit: (t) => events.push(t) });
  return { h, events };
};
const code = async (p: Promise<unknown>) => {
  try { await p; return 'ok'; } catch (e) { return e instanceof SyncRpcFailure ? e.code : `error:${(e as Error).message}`; }
};

describe('PC 원격 관리 처리기 (ADR-116)', () => {
  it('host.info와 잘못된 인자', async () => {
    const { h } = setup(true);
    const info = await h.handle('p', 'host.info', []) as { knowledge: boolean; allowDelete: boolean; timeZone: string };
    expect(info).toMatchObject({ knowledge: true, allowDelete: true });
    expect(info.timeZone).toBeTruthy();
    expect(await code(h.handle('p', 'knowledge.rename', ['nope', 'x']))).toBe('invalid');
  });

  it('지식베이스 변경은 knowledge 이벤트, 없는 선택 메서드는 unsupported, IPC 접두어 제거', async () => {
    const { h, events } = setup();
    await h.handle('p', 'knowledge.create', ['노트']);
    expect(events).toEqual(['knowledge']);
    // 허용 목록 밖의 메서드(색인·docs 등)는 처리하지 않는다
    expect(await code(h.handle('p', 'knowledge.docs' as unknown as SyncRpcMethod, ['kbabc123']))).toBe('invalid');
    expect(await code(h.handle('p', 'knowledge.preview', ['kbabc123', 'a.md']))).toMatch(/^error:/);
  });

  it('tree는 폴더 경로(dir)가 있어야 하고, 있으면 그 단계만 조회한다', async () => {
    const { h } = setup();
    expect(await code(h.handle('p', 'knowledge.tree', ['kbabc123']))).toBe('invalid');
    await h.handle('p', 'knowledge.tree', ['kbabc123', 'docs']);
    expect(trees).toEqual([['kbabc123', 'docs']]);
  });

  it('cloneGit는 mode가 clone 또는 zip일 때만 받고, pullGit은 경로를 넘긴다', async () => {
    const { h, events } = setup();
    expect(await code(h.handle('p', 'knowledge.cloneGit', ['kbabc123', 'https://github.com/o/r', { mode: 'bogus' }]))).toBe('invalid');
    expect(await code(h.handle('p', 'knowledge.pullGit', ['kbabc123']))).toBe('invalid');
    expect(events).toEqual([]);
    await h.handle('p', 'knowledge.pullGit', ['kbabc123', 'repo-a']);
    expect(pulled).toEqual([['kbabc123', 'repo-a']]);
    expect(events).toEqual(['knowledge']);
  });

  it('원격 삭제가 꺼져 있으면 forbidden, 켜져 있으면 지운다', async () => {
    expect(await code(setup(false).h.handle('p', 'knowledge.remove', ['kbabc123']))).toBe('forbidden');
    expect(await code(setup(false).h.handle('p', 'knowledge.removeEntry', ['kbabc123', 'a.md']))).toBe('forbidden');
    const { h } = setup(true);
    await h.handle('p', 'knowledge.remove', ['kbabc123']);
    expect(removed).toEqual(['kbabc123']);
    expect(await code(h.handle('p', 'knowledge.removeEntry', ['kbabc123', 'a.md']))).toBe('error:디스크 오류');
  });

  it('조각 업로드를 조립해 addFiles로 넣고, 끊긴 피어의 조립은 버린다', async () => {
    const { h, events } = setup();
    const data = new Uint8Array(1024 * 1024 + 7).map((_, i) => i % 251);
    const chunks = splitUpload('kbabc123', 'up1', '사진.png', data, 'inbox');
    expect(chunks).toHaveLength(3);
    expect(await h.handle('p', 'knowledge.upload', uploadChunkArgs(chunks[0]!))).toEqual({ received: 512 * 1024 });
    await h.handle('p', 'knowledge.upload', uploadChunkArgs(chunks[1]!));
    expect(await h.handle('p', 'knowledge.upload', uploadChunkArgs(chunks[2]!))).toEqual({ added: ['사진.png'] });
    expect(added.at(-1)).toEqual({ id: 'kbabc123', name: '사진.png', size: data.length, dest: 'inbox' });
    expect(events).toEqual(['knowledge']);

    await h.handle('p', 'knowledge.upload', uploadChunkArgs(chunks[0]!));
    h.peerGone('p');
    expect(await code(h.handle('p', 'knowledge.upload', uploadChunkArgs(chunks[1]!)))).toBe('invalid');
  });

  it('예약 서명은 실행 상태 변화만 반영한다', () => {
    const row = { id: 's1', updatedAt: 1, nextRunAt: 2, enabled: true } as Parameters<typeof scheduleSignature>[0][number];
    expect(scheduleSignature([row])).toBe(scheduleSignature([{ ...row }]));
    expect(scheduleSignature([row])).not.toBe(scheduleSignature([{ ...row, pendingRunAt: 3 }]));
  });
});
