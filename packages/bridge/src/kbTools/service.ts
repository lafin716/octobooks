import {
  KB_TOOL_LIMITS,
  KB_TOOL_NAMES,
  KbToolBudget,
  KbToolError,
  parseFindDefinitionsInput,
  parseFindFilesInput,
  parseGrepInput,
  parseListDirectoryInput,
  parseOutlineInput,
  parseReadFileInput,
  type FindDefinitionsOutput,
  type FindFilesOutput,
  type GetKnowledgeOutlineOutput,
  type GrepKnowledgeOutput,
  type KbOutlineItem,
  type KbToolName,
  type ListKnowledgeDirectoryOutput,
  type ReadKnowledgeFileOutput,
} from '@branch/core';
import {
  CodebaseAbortError,
  entryFilterFor,
  findDefinitions,
  findFiles,
  grep,
  readCodebaseLines,
  readCodebaseRange,
  type CodebaseTarget,
  type ScanStats,
} from '../codebase';
import { listDir, outlineOfLines, resolveInside, isMarkdownPath } from './files';

export interface KbEntry {
  kbId: string;
  kbName: string;
  /** 원본 루트 (<root>/<kbId>/files, 또는 읽기 전용 연결 폴더의 realpath). 이 아래만 읽는다 */
  filesRoot: string;
  /** PDF 추출 텍스트 캐시 폴더 (<root>/<kbId>/cache/text). 연결 폴더 안에는 쓰지 않는다 (ADR-140) */
  cacheDir?: string;
  /** 연결 폴더가 사라졌다. 도구 호출은 not_found로 알린다 */
  missing?: boolean;
}

export interface KbToolResult {
  text: string;
  isError: boolean;
}

export interface KbToolServiceOptions {
  kbs: KbEntry[];
  /** 한 호출 제한 시간 */
  callTimeoutMs?: number;
  budget?: KbToolBudget;
}

/** 시간 제한을 건다 (Promise가 끝나지 않으면 cancelled). 제한 시간이 지나면 신호로 진행 중 스캔을 멈춘다 */
function withTimeout<T>(p: Promise<T>, ms: number, ac: AbortController): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new KbToolError('cancelled', 'knowledge tool call timed out'));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 읽기 전용 KB 도구 (ADR-136·137). 모든 KB를 같은 방식으로 파일 폴더에서 직접 탐색한다. 색인·벡터·사전 검색은 없다.
 * 모든 입력은 core 파서로 검증하고, 파일 접근은 KB 루트 밖으로 나가지 못하게 realpath로 확인한다.
 */
export class KbToolService {
  private readonly byId: Map<string, KbEntry>;
  private readonly callTimeoutMs: number;
  readonly budget: KbToolBudget;

  constructor(opts: KbToolServiceOptions) {
    this.byId = new Map(opts.kbs.map((k) => [k.kbId, k]));
    this.callTimeoutMs = opts.callTimeoutMs ?? 10_000;
    this.budget = opts.budget ?? new KbToolBudget();
  }

  get allowedIds(): string[] {
    return [...this.byId.keys()];
  }

  /** 도구 호출. 실패는 isError 결과로 돌려주고 예외를 던지지 않는다 */
  async call(name: string, args: unknown): Promise<KbToolResult> {
    try {
      if (!(KB_TOOL_NAMES as readonly string[]).includes(name)) {
        throw new KbToolError('bad_input', `unknown tool: ${name}`);
      }
      this.budget.take();
      const ac = new AbortController();
      const out = await withTimeout(this.dispatch(name as KbToolName, args, ac.signal), this.callTimeoutMs, ac);
      const text = JSON.stringify(out, null, 2);
      this.budget.spend(text.length);
      return { text, isError: false };
    } catch (e) {
      if (e instanceof KbToolError) return { text: JSON.stringify({ error: e.code, message: e.message }), isError: true };
      if (e instanceof CodebaseAbortError) return { text: JSON.stringify({ error: 'cancelled', message: 'knowledge tool call timed out' }), isError: true };
      return { text: JSON.stringify({ error: 'internal', message: 'knowledge tool failed' }), isError: true };
    }
  }

  private kb(kbId: string): KbEntry {
    const k = this.byId.get(kbId);
    if (!k) throw new KbToolError('kb_not_allowed', `knowledge base not allowed: ${kbId}`);
    return k;
  }

  /** 탐색 대상 (연결 폴더가 없어졌으면 not_found) */
  private target(k: KbEntry): CodebaseTarget {
    if (k.missing) throw new KbToolError('not_found', `linked folder is missing: ${k.kbId}`);
    return {
      kbId: k.kbId,
      kbName: k.kbName,
      root: k.filesRoot,
      excludes: [],
      ...(k.cacheDir ? { cacheDir: k.cacheDir } : {}),
    };
  }

  private async dispatch(name: KbToolName, args: unknown, signal: AbortSignal): Promise<unknown> {
    switch (name) {
      case 'listKnowledgeDirectory': {
        const input = parseListDirectoryInput(args, this.allowedIds);
        const k = this.kb(input.kbId);
        const t = this.target(k);
        const page = await listDir(k.filesRoot, input.path, input.offset, entryFilterFor(t));
        const out: ListKnowledgeDirectoryOutput = {
          kbId: k.kbId,
          path: input.path,
          entries: page.entries,
          ...(page.nextOffset !== undefined ? { nextCursor: String(page.nextOffset) } : {}),
        };
        return out;
      }
      case 'readKnowledgeFile': {
        const input = parseReadFileInput(args, this.allowedIds);
        const k = this.kb(input.kbId);
        const r = await readCodebaseRange(this.target(k), input.path, { startLine: input.startLine, endLine: input.endLine, signal });
        const out: ReadKnowledgeFileOutput = {
          kbId: k.kbId,
          path: input.path,
          startLine: r.startLine,
          endLine: r.endLine,
          totalLines: r.totalLines,
          content: r.content,
          truncated: r.truncated,
        };
        return out;
      }
      case 'getKnowledgeOutline': {
        const input = parseOutlineInput(args, this.allowedIds);
        const k = this.kb(input.kbId);
        const t = this.target(k);
        const target = await resolveInside(k.filesRoot, input.path);
        if (target.isDir) {
          const page = await listDir(k.filesRoot, input.path, 0, entryFilterFor(t));
          const items: KbOutlineItem[] = page.entries.map((e) => ({
            kind: e.type === 'directory' ? ('directory' as const) : ('file' as const),
            name: e.name,
            path: e.path,
          }));
          const cap = KB_TOOL_LIMITS.outlineMaxItems;
          const out: GetKnowledgeOutlineOutput = {
            kbId: k.kbId,
            path: input.path,
            type: 'directory',
            items: items.slice(0, cap),
            truncated: items.length > cap || page.nextOffset !== undefined,
          };
          return out;
        }
        const lines = await readCodebaseLines(t, input.path, signal);
        const o = outlineOfLines(lines, isMarkdownPath(input.path));
        const out: GetKnowledgeOutlineOutput = { kbId: k.kbId, path: input.path, type: 'file', items: o.items, truncated: o.truncated };
        return out;
      }
      case 'findFiles': {
        const input = parseFindFilesInput(args, this.allowedIds);
        const k = this.kb(input.kbId);
        const found = await findFiles(this.target(k), input.pattern, { limit: input.limit + 1, signal });
        const out: FindFilesOutput = {
          kbId: k.kbId,
          pattern: input.pattern,
          paths: found.slice(0, input.limit),
          truncated: found.length > input.limit,
        };
        return out;
      }
      case 'grepKnowledge': {
        const input = parseGrepInput(args, this.allowedIds);
        const k = this.kb(input.kbId);
        const stats: ScanStats = { scannedFiles: 0, timedOutFiles: 0, byteBudgetHit: false };
        const found = await grep(this.target(k), input.pattern, {
          regex: input.regex,
          limit: input.limit + 1,
          signal,
          stats,
          ...(input.pathPrefix ? { pathPrefix: input.pathPrefix } : {}),
        });
        const notes: string[] = [];
        if (stats.timedOutFiles > 0) notes.push(`${stats.timedOutFiles} file(s) were only partly scanned (time budget per file).`);
        if (stats.byteBudgetHit) notes.push('Scan stopped at the total byte budget. Narrow with pathPrefix to cover the rest.');
        const out: GrepKnowledgeOutput = {
          kbId: k.kbId,
          pattern: input.pattern,
          regex: input.regex,
          hits: found.slice(0, input.limit),
          truncated: found.length > input.limit,
          scannedFiles: stats.scannedFiles,
          notes,
        };
        return out;
      }
      case 'findDefinitions': {
        const input = parseFindDefinitionsInput(args, this.allowedIds);
        const k = this.kb(input.kbId);
        const found = await findDefinitions(this.target(k), input.symbol, { limit: input.limit + 1, signal });
        const out: FindDefinitionsOutput = {
          kbId: k.kbId,
          symbol: input.symbol,
          hits: found.slice(0, input.limit),
          truncated: found.length > input.limit,
        };
        return out;
      }
    }
  }
}
