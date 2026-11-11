import { intlLocale, t } from '../i18n';
import {
  KNOWLEDGE_DESCRIPTION_MAX,
  cleanKnowledgeName,
  isKnowledgeLinkUrl,
  parseGitHubRepo,
  type GitImportMode,
  type ID,
  type KnowledgeAddResult,
  type KnowledgeBase,
  type KnowledgeEntry,
  type KnowledgePreview,
  type KnowledgeProgress,
  type KnowledgeSource,
} from '@branch/core';
import { ArrowLeft, ChevronRight, File, FileText, Folder, FolderOpen, GitBranch, Link2, Loader2, Maximize2, Minimize2, Pencil, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { remoteMode } from '../app/capabilities';
import { actions, useApp } from '../app/store';
import { Button, IconButton } from '../components/Button';
import { confirm } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/time';
import { ipcErrorMessage } from './api';
import { kbErrorGuide } from './kbErrors';
import { KnowledgeCreate } from './KnowledgeCreate';
import { filterBases, findDuplicates, formatSize, middleEllipsis, sortBases, validTime, type KbSort } from './kbModel';
import { fetchAllowDelete, onRemoteKnowledgeChanged, useKnowledgeApi, useRemoteState } from './remoteApi';
import { isRemoteForbidden } from './remoteKnowledge';
import { resetSessionKnowledge, toggleSessionKnowledge, useSessionKnowledge } from './sessionKnowledge';

const SORTS: KbSort[] = ['recent', 'name', 'size'];
const GIT_MODES: GitImportMode[] = ['clone', 'zip'];

export interface KnowledgeDialogProps {
  open: boolean;
  onClose(): void;
  sessionId: ID;
}

/** 안내 문구. 오류는 role=alert로 바로 읽히고 붉게 보인다 */
interface NoticeState {
  text: string;
  tone: 'info' | 'error';
}

/** 진행 중인 가져오기 (진행 막대에 보인다) */
type ImportKind = 'files' | 'link' | 'git';
interface ImportTask {
  kind: ImportKind;
  startedAt: number;
}

interface PreviewState {
  path: string;
  data: KnowledgePreview;
}

/** 실패 문구 뒤에 원인을 덧붙인다 (가드 오류는 원인·해결, 그 밖에는 IPC 메시지) */
function withDetail(message: string, e: unknown): string {
  const guide = kbErrorGuide(e, t);
  if (guide) return `${message} ${guide}`;
  const detail = ipcErrorMessage(e);
  return detail ? `${message} (${detail})` : message;
}

/** 출처 배지 문구. 로컬 파일·폴더는 따로 표시하지 않는다 */
function sourceBadge(src: KnowledgeSource): string | null {
  if (src.type === 'github') return src.mode === 'clone' ? t('knowledge.source.githubClone') : t('knowledge.source.githubZip');
  if (src.type === 'web') return t('knowledge.source.link');
  return null;
}

/** GitHub clone으로 가져온 저장소만 Pull로 갱신할 수 있다 */
function isPullable(entry: KnowledgeEntry): boolean {
  return entry.source?.type === 'github' && entry.source.mode === 'clone';
}

/**
 * 지식베이스 대화상자. 데스크톱은 목록·상세 두 칸, 모바일은 목록 → 상세 한 칸씩 보인다.
 * 연결은 학습(루트 세션)에 저장되므로 같은 학습의 가지도 같은 지식베이스를 쓴다.
 * 폴더 트리는 한 단계씩 읽는다: 열 때는 최상위만, 하위 폴더는 눌렀을 때 읽는다.
 */
export function KnowledgeDialog({ open, onClose, sessionId }: KnowledgeDialogProps) {
  const api = useKnowledgeApi();
  const remote = remoteMode;
  const remoteState = useRemoteState();
  /** 원격 삭제 허용. PC가 허용하지 않거나 확인 전이면 삭제 버튼을 숨긴다 (PC 로컬은 항상 허용) */
  const [allowDelete, setAllowDelete] = useState(!remote);
  const canDelete = !remote || allowDelete;
  const { ids: explicitIds, inherited, overridden, all: usesAll } = useSessionKnowledge(sessionId);
  const isRoot = useApp((s) => !s.sessions[sessionId]?.parentId);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** 현재 보고 있는 폴더 경로 ('' = 최상위) */
  const [dir, setDir] = useState('');
  /** 현재 폴더의 한 단계 항목만 */
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [listing, setListing] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [notice, setNoticeState] = useState<NoticeState | null>(null);
  const [task, setTask] = useState<ImportTask | null>(null);
  const [progress, setProgress] = useState<KnowledgeProgress | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cancelledRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [draftDesc, setDraftDesc] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitMode, setGitMode] = useState<GitImportMode>('clone');
  const [dragOver, setDragOver] = useState(false);
  const [full, setFull] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<KbSort>('recent');
  /** 오른쪽 칸을 보여 줄지: 등록 화면이거나 고른 지식베이스가 있을 때 (모바일에서는 한 칸만 보인다) */
  const showDetail = !!selected || creating;
  const selectedRef = useRef<string | null>(null);
  const dirRef = useRef('');

  const setNotice = useCallback((text: string | null, tone: NoticeState['tone'] = 'info') => setNoticeState(text ? { text, tone } : null), []);
  const setError = useCallback((text: string) => setNotice(text, 'error'), [setNotice]);

  const current = bases.find((b) => b.id === selected);
  /** 예전 방식(연결 폴더)으로 만든 지식베이스: 파일을 넣거나 지울 수 없는 읽기 전용이다 */
  const isLegacy = !!current?.linkedPath;
  /** 파일 추가·제거·Pull이 가능한 지식베이스 */
  const canEditFiles = !!current && !isLegacy;
  const canRemoveEntries = canEditFiles && canDelete;
  const visibleBases = sortBases(filterBases(bases, { query }), sort);
  const crumbs = dir ? dir.split('/') : [];

  // 진행률 구독 (main이 가져오기 동안 보낸다)
  useEffect(() => {
    if (!open || !api?.onProgress) return;
    return api.onProgress((p) => setProgress(p));
  }, [open, api]);

  // 가져오는 동안 경과 시간을 1초마다 갱신한다
  useEffect(() => {
    if (!task) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [task]);

  const reload = useCallback(async () => {
    if (!api) return;
    setBases(await api.list());
  }, [api]);

  /**
   * 폴더 한 단계를 읽는다. 요청마다 번호를 매겨 가장 마지막 요청의 결과만 반영한다
   * (빠르게 여러 폴더를 열거나 같은 폴더를 다시 읽을 때 늦게 온 옛 응답이 덮어쓰지 않게, 스피너도 마지막 요청이 끈다).
   */
  const levelSeq = useRef(0);
  const loadLevel = useCallback(
    async (id: string, path: string) => {
      if (!api) return;
      const seq = ++levelSeq.current;
      setListing(true);
      try {
        const list = await api.tree(id, path);
        if (seq !== levelSeq.current || selectedRef.current !== id || dirRef.current !== path) return;
        setEntries(list);
      } catch (e) {
        if (seq === levelSeq.current && selectedRef.current === id && dirRef.current === path) setError(withDetail(t('knowledge.error.generic'), e));
      } finally {
        if (seq === levelSeq.current) setListing(false);
      }
    },
    [api, setError],
  );

  // 대화상자를 열 때: 목록과 (고른 지식베이스가 있으면) 최상위 한 단계만 읽는다
  useEffect(() => {
    if (!open || !api) return;
    setNotice(null);
    api
      .list()
      .then((list) => setBases(list))
      .catch((e: unknown) => setError(withDetail(t('knowledge.error.generic'), e)))
      .finally(() => setLoaded(true));
    if (selectedRef.current) {
      dirRef.current = '';
      setDir('');
      void loadLevel(selectedRef.current, '');
    }
    // setState 함수는 안정적이다. api 변화(원격 연결 준비)에만 다시 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, api]);

  // 개수·크기를 아직 세는 지식베이스가 있으면 끝날 때까지 목록만 다시 읽는다 (목록은 파일을 훑지 않아 가볍다)
  const pending = open && bases.some((b) => b.statsPending);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void reload().catch(() => undefined), 1000);
    return () => clearTimeout(timer);
  }, [pending, bases, reload]);

  // 원격: 원격 삭제 허용 여부를 PC에 확인한다
  useEffect(() => {
    if (!open || !remote || remoteState.manage !== true) return;
    let alive = true;
    void fetchAllowDelete().then((v) => {
      if (alive) setAllowDelete(v);
    });
    return () => {
      alive = false;
    };
  }, [open, remote, remoteState.manage]);

  // 원격: PC에서 지식베이스가 바뀌면 목록과 지금 보는 폴더를 다시 읽는다
  useEffect(() => {
    if (!open || !remote || !api) return;
    return onRemoteKnowledgeChanged(() => {
      void reload().catch(() => undefined);
      if (selectedRef.current) void loadLevel(selectedRef.current, dirRef.current);
    });
  }, [open, remote, api, reload, loadLevel]);

  /** 작업을 실행한다. 바쁜 동안 버튼을 막고, 실패하면 안내 문구를 보인다 */
  const run = async <T,>(fn: () => Promise<T>, failure = t('knowledge.error.generic')): Promise<T | undefined> => {
    setBusy(true);
    setNotice(null);
    try {
      return await fn();
    } catch (e) {
      // 원격에서 PC가 삭제를 거절하면 삭제 버튼을 숨기고 이유를 알린다
      if (remote && isRemoteForbidden(e)) {
        setAllowDelete(false);
        setError(t('knowledge.remote.deleteOff'));
      } else {
        setError(withDetail(failure, e));
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  // void를 돌려주는 API는 run()의 undefined가 실패로 읽히지 않도록 성공 여부를 따로 본다
  const runVoid = async (fn: () => Promise<void>, failure?: string): Promise<boolean> =>
    (await run(async () => {
      await fn();
      return true;
    }, failure)) === true;

  /** 가져오기: 진행 막대를 보이고, 사용자가 취소했으면 오류 대신 취소 안내를 보인다 */
  const runImport = async <T,>(kind: ImportKind, fn: () => Promise<T>): Promise<T | undefined> => {
    cancelledRef.current = false;
    setProgress(null);
    setTask({ kind, startedAt: Date.now() });
    setBusy(true);
    setNotice(null);
    try {
      return await fn();
    } catch (e) {
      if (cancelledRef.current) setNotice(t('knowledge.progress.cancelled'));
      else setError(withDetail(t('knowledge.add.failed'), e));
      return undefined;
    } finally {
      setBusy(false);
      setTask(null);
      setProgress(null);
    }
  };

  const cancelImport = () => {
    if (!api?.cancel) return;
    cancelledRef.current = true;
    void api.cancel().catch(() => undefined);
  };

  /** 지식베이스를 고르면 최상위 폴더부터 보인다 */
  const select = (id: string | null) => {
    selectedRef.current = id;
    setSelected(id);
    dirRef.current = '';
    setDir('');
    setEntries([]);
    setPreview(null);
    setRenaming(false);
    setEditingDesc(false);
    setCreating(false);
    setNotice(null);
    if (id) void loadLevel(id, '');
    else setListing(false);
  };

  /** 폴더로 들어간다. 눌렀을 때만 그 폴더를 읽는다 */
  const enterDir = (path: string) => {
    if (!current) return;
    dirRef.current = path;
    setDir(path);
    setEntries([]);
    setPreview(null);
    void loadLevel(current.id, path);
  };

  /** 지금 보는 폴더를 다시 읽고 목록도 갱신한다 */
  const refresh = async (id: string) => {
    await loadLevel(id, dirRef.current);
    await reload();
  };

  const report = (r: KnowledgeAddResult | undefined) => {
    if (!r) return;
    const parts = [r.added.length ? t('knowledge.add.done', { count: r.added.length }) : '', r.skipped ? t('knowledge.add.skipped', { count: r.skipped }) : ''];
    const text = parts.filter(Boolean).join(' ');
    // 하나도 못 넣었으면 그대로 넘어가지 않고 알린다
    setNotice(text || t('knowledge.add.nothing'), r.added.length ? 'info' : 'error');
  };

  /** 새 지식베이스를 만들면 바로 상세 화면으로 간다 */
  const onCreated = async (kb: KnowledgeBase, notice?: string) => {
    await reload();
    select(kb.id);
    if (notice) setNotice(notice);
  };

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    const name = cleanKnowledgeName(draftName);
    if (!name || !current || !api) return;
    const done = await run(() => api.rename(current.id, name));
    if (!done) return;
    setRenaming(false);
    await reload();
  };

  const startRename = () => {
    if (!current) return;
    setDraftName(current.name);
    setRenaming(true);
  };

  const startEditDesc = () => {
    if (!current) return;
    setDraftDesc(current.description ?? '');
    setEditingDesc(true);
  };

  const saveDescription = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !api) return;
    const id = current.id;
    const ok = await runVoid(async () => {
      await api.setDescription(id, draftDesc.trim());
    });
    if (!ok) return;
    setEditingDesc(false);
    await reload();
  };

  /** 전체 사용(기본)이면 지금 있는 지식베이스가 모두 연결된 것으로 보인다 (ADR-141) */
  const linkedIds = usesAll ? bases.map((b) => b.id) : explicitIds;
  const isLinked = !!current && linkedIds.includes(current.id);

  const toggleLink = (id: string) => toggleSessionKnowledge(sessionId, linkedIds, id);

  const removeBase = async () => {
    if (!current || !api) return;
    const ok = await confirm({
      title: t('knowledge.delete.title', { name: current.name }),
      message: current.statsPending ? t('knowledge.delete.messageUnknown') : t('knowledge.delete.message', { count: current.fileCount }),
      confirmLabel: t('knowledge.delete.confirm'),
      tone: 'danger',
    });
    if (!ok) return;
    if (!(await runVoid(() => api.remove(current.id)))) return;
    // 삭제된 KB를 모든 세션의 연결 목록에서 뺀다 (빈 목록은 끔으로 남아 부모 상속으로 바뀌지 않는다)
    actions().forgetKnowledgeBase(current.id);
    select(null);
    await reload();
  };

  const removeEntry = async (entry: KnowledgeEntry) => {
    if (!current || !api) return;
    const name = entry.path.split('/').pop() ?? entry.path;
    const ok = await confirm({
      title: t('knowledge.tree.removeTitle', { name }),
      message: t('knowledge.tree.removeMessage'),
      confirmLabel: t('knowledge.tree.remove'),
      tone: 'danger',
    });
    if (!ok) return;
    if (preview?.path === entry.path) setPreview(null);
    if (await runVoid(() => api.removeEntry(current.id, entry.path))) await refresh(current.id);
  };

  const showPreview = async (entry: KnowledgeEntry) => {
    if (!current || !api) return;
    const data = await run(() => api.preview(current.id, entry.path));
    if (data) setPreview({ path: entry.path, data });
  };

  /** 끌어다 놓은 항목은 지금 보는 폴더에 넣는다. 경로를 얻으면 디스크에서 복사하고, 못 얻으면 내용으로 넣는다 */
  const addDropped = async (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (!current || !api || !canEditFiles) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return setError(t('knowledge.add.dropEmpty'));
    // 처리 중에 또 놓으면 넣지 않고 알린다 (같은 파일이 겹쳐 들어가지 않게)
    if (busy) return setError(t('knowledge.add.busyDrop'));
    const id = current.id;
    const folder = dirRef.current;
    // 같은 이름·크기의 파일이 이 폴더에 이미 있으면 다시 넣지 않는다 (끌어온 목록 안의 중복도 함께 본다)
    const existing = entries.filter((x) => !x.dir && x.size !== undefined).map((x) => ({ name: x.path.split('/').pop() ?? x.path, size: x.size ?? 0 }));
    const { duplicates, unique } = findDuplicates(
      files.map((f) => ({ name: f.name, size: f.size, file: f })),
      existing,
    );
    if (!unique.length) return setError(t('knowledge.add.allDuplicates', { count: duplicates.length }));
    const results = await runImport('files', async () => {
      const paths: string[] = [];
      const blobs: { name: string; data: Uint8Array }[] = [];
      for (const { file: f } of unique) {
        const p = api.pathForFile(f);
        if (p) paths.push(p);
        else blobs.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
      const out: KnowledgeAddResult[] = [];
      const dest = folder || undefined;
      if (paths.length) out.push(await api.addPaths(id, paths, dest));
      if (blobs.length) out.push(await api.addFiles(id, blobs, dest));
      return out;
    });
    if (results) {
      const r = merge(results);
      report({ ...r, skipped: r.skipped + duplicates.length });
      await refresh(id);
    }
  };

  /** 파일 또는 폴더를 OS 선택 창에서 고른다 (지금 보는 폴더에 넣는다) */
  const pickFiles = async () => {
    if (!current || !api) return;
    const id = current.id;
    const folder = dirRef.current;
    const r = await runImport('files', () => api.pickFiles(id, folder || undefined));
    if (r) {
      report(r);
      await refresh(id);
    }
  };

  const addLink = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !api) return;
    const url = linkUrl.trim();
    if (!isKnowledgeLinkUrl(url)) return setError(t('knowledge.add.invalidUrl'));
    const id = current.id;
    const r = await runImport('link', () => api.addLink(id, url));
    if (r) {
      setLinkUrl('');
      report(r);
      await refresh(id);
    }
  };

  const addGit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !api) return;
    const repo = parseGitHubRepo(gitUrl);
    if (!repo) return setError(t('knowledge.add.invalidGit'));
    const id = current.id;
    const r = await runImport('git', () => api.cloneGit(id, repo.url, { mode: gitMode }));
    if (r) {
      setGitUrl('');
      report(r);
      await refresh(id);
    }
  };

  /** GitHub clone으로 가져온 저장소를 git pull로 갱신한다 */
  const pullRepo = async (entry: KnowledgeEntry) => {
    if (!current || !api) return;
    const id = current.id;
    const r = await runImport('git', () => api.pullGit(id, entry.path));
    if (r) {
      report(r);
      await refresh(id);
    }
  };

  const openFolder = (path?: string) => {
    if (!current || !api) return;
    void run(() => api.open(current.id, path));
  };

  const dropZone = canEditFiles && !isLegacy;

  const body = (() => {
    if (remote && !api) {
      // PC가 구버전이면 관리 기능이 없으니 업데이트를 안내한다
      if (remoteState.status === 'online' && remoteState.manage === false) return <Notice text={t('knowledge.remote.outdated')} hint={t('knowledge.remote.outdatedHint')} />;
      if (remoteState.status === 'offline' || remoteState.status === 'unpaired') return <Notice text={t('knowledge.remote.offline')} />;
      return <Notice text={t('knowledge.remote.connecting')} />;
    }
    if (!api) return <Notice text={t('knowledge.unavailable.notice')} />;
    return (
      <div className="flex min-h-0 flex-1">
        <aside className={cn('w-full shrink-0 flex-col border-line md:flex md:w-72 md:border-r', showDetail ? 'hidden' : 'flex')}>
          <div className="flex items-center gap-2 px-4 pt-4 pb-2">
            <h3 className="flex-1 text-[13px] font-semibold text-fg-2">{t('knowledge.list.heading')}</h3>
            <Button size="sm" variant="soft" icon={<Plus size={14} />} disabled={busy} onClick={() => setCreating(true)}>
              {t('knowledge.list.create')}
            </Button>
          </div>
          <div className="flex flex-col gap-2 px-4 pb-2">
            <div className="relative">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-2" />
              <input
                type="search"
                aria-label={t('knowledge.list.search')}
                value={query}
                placeholder={t('knowledge.list.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-full rounded-lg border border-line bg-surface pr-2 pl-8 text-[13px] outline-none focus:border-accent"
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] text-muted">{t('knowledge.list.toggleHint')}</p>
              <label className="sr-only" htmlFor="kb-sort">
                {t('knowledge.list.sort')}
              </label>
              <select
                id="kb-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as KbSort)}
                className="h-7 shrink-0 rounded-lg border border-line bg-surface px-1.5 text-[12px] outline-none focus:border-accent"
              >
                {SORTS.map((s) => (
                  <option key={s} value={s}>
                    {t(sortKey(s))}
                  </option>
                ))}
              </select>
            </div>
              {usesAll ? (
                <p className="text-[12px] text-fg-2" data-link-scope="all">
                  {t('knowledge.link.all')}
                </p>
              ) : (
                isRoot && (
                  <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2" data-link-scope="custom">
                    <span>{t('knowledge.link.custom')}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => resetSessionKnowledge(sessionId)}>
                      {t('knowledge.link.useAll')}
                    </Button>
                  </div>
                )
              )}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {loaded && bases.length === 0 && (
              <div className="px-2 py-6 text-center">
                <p className="text-[14px] font-medium text-fg">{t('knowledge.list.empty')}</p>
                <p className="mt-1 text-[13px] text-fg-2">{t('knowledge.list.emptyHint')}</p>
                <Button className="mt-4" variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                  {t('knowledge.list.create')}
                </Button>
              </div>
            )}
            {loaded && bases.length > 0 && visibleBases.length === 0 && <p className="px-3 py-4 text-[13px] text-fg-2">{t('knowledge.list.noMatch')}</p>}
            <ul className="flex flex-col gap-1">
              {visibleBases.map((b) => {
                const linked = linkedIds.includes(b.id);
                return (
                  <li key={b.id} className={cn('flex items-stretch gap-1 rounded-lg', b.id === selected ? 'bg-accent-soft' : 'hover:bg-surface-2')}>
                    <button
                      type="button"
                      aria-pressed={linked}
                      disabled={busy}
                      onClick={() => toggleLink(b.id)}
                      className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left disabled:opacity-60"
                    >
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span className={cn('min-w-0 flex-1 truncate text-[14px] font-medium', b.id === selected ? 'text-accent' : 'text-fg')}>{b.name}</span>
                        {linked && <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[11px] font-medium text-accent-fg">{t('knowledge.list.linkedBadge')}</span>}
                      </span>
                      {b.description && <span className="block w-full min-w-0 truncate text-[12px] text-fg-2">{b.description}</span>}
                      <span className="flex w-full min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-fg-2">
                        <span className="min-w-0 truncate">{b.statsPending ? t('knowledge.list.counting') : t('knowledge.list.count', { count: b.fileCount, size: formatSize(b.totalBytes) })}</span>
                        {b.linkedPath && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[11px] text-fg-2">{t('knowledge.source.legacy')}</span>}
                        {validTime(b.updatedAt) !== null && (
                          <time dateTime={new Date(b.updatedAt).toISOString()} title={new Date(b.updatedAt).toLocaleString(intlLocale())} className="ml-auto shrink-0 text-muted">
                            {relativeTime(b.updatedAt)}
                          </time>
                        )}
                      </span>
                    </button>
                    <IconButton size="sm" label={`${t('knowledge.list.open')}: ${b.name}`} onClick={() => select(b.id)} className="my-1.5 mr-1.5 self-center">
                      <ChevronRight size={15} />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>

        <section className={cn('min-h-0 min-w-0 flex-1 flex-col', showDetail ? 'flex' : 'hidden md:flex')}>
          {creating ? (
            <KnowledgeCreate api={api} onCreated={onCreated} onCancel={() => setCreating(false)} />
          ) : !current ? (
            <div className="flex flex-1 items-center justify-center p-6 text-[14px] text-fg-2">{loaded && bases.length ? t('knowledge.tree.previewEmpty') : null}</div>
          ) : (
            <div
              className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
              onDragOver={
                dropZone
                  ? (e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
                      setDragOver(true);
                    }
                  : undefined
              }
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
              }}
              onDrop={dropZone ? (e) => void addDropped(e) : undefined}
            >
              {/* 머리: 뒤로(모바일) · 이름 · 동작 */}
              <div className="flex flex-wrap items-center gap-2">
                <IconButton size="sm" label={t('knowledge.dialog.back')} className="md:hidden" onClick={() => select(null)}>
                  <ArrowLeft size={16} />
                </IconButton>
                {renaming ? (
                  <form onSubmit={submitRename} className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      autoFocus
                      aria-label={t('knowledge.rename.action')}
                      value={draftName}
                      maxLength={80}
                      onChange={(e) => setDraftName(e.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[14px] outline-none focus:border-accent"
                    />
                    <Button size="sm" variant="primary" type="submit" disabled={busy || !cleanKnowledgeName(draftName)}>
                      {t('knowledge.rename.submit')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
                      {t('knowledge.rename.cancel')}
                    </Button>
                  </form>
                ) : (
                  <h3 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{current.name}</h3>
                )}
                {!renaming && (
                  <div className="flex flex-wrap items-center gap-1">
                    <Button size="sm" variant={isLinked ? 'secondary' : 'soft'} aria-pressed={isLinked} disabled={busy} onClick={() => toggleLink(current.id)}>
                      {isLinked ? t('knowledge.list.unlink') : t('knowledge.list.link')}
                    </Button>
                    <IconButton size="sm" label={t('knowledge.rename.action')} disabled={busy} onClick={startRename}>
                      <Pencil size={15} />
                    </IconButton>
                    {!remote && (
                      <IconButton size="sm" label={t('knowledge.tree.open')} disabled={busy} onClick={() => openFolder(dir || undefined)}>
                        <FolderOpen size={15} />
                      </IconButton>
                    )}
                    {canDelete && !isLegacy && (
                      <IconButton size="sm" label={t('knowledge.delete.action')} disabled={busy} onClick={() => void removeBase()} className="hover:text-danger">
                        <Trash2 size={15} />
                      </IconButton>
                    )}
                  </div>
                )}
              </div>

              {isLegacy && (
                <div className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg-2" data-legacy-readonly="">
                  <span className="font-medium text-fg">{t('knowledge.source.legacy')}</span>
                  <span className="font-mono text-[12px]" title={current.linkedPath}>
                    {middleEllipsis(current.linkedPath ?? '', 60)}
                  </span>
                  <span>{t('knowledge.source.legacyHint')}</span>
                </div>
              )}

              {(inherited || overridden) && (
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2" data-link-scope={inherited ? 'inherited' : 'overridden'}>
                  <span>{inherited ? t('knowledge.link.inherited') : t('knowledge.link.overridden')}</span>
                  {overridden && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => resetSessionKnowledge(sessionId)}>
                      {t('knowledge.link.reset')}
                    </Button>
                  )}
                </div>
              )}

              {/* 설명: AI가 언제 이 지식베이스를 쓸지 판단하는 데 쓰인다 */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <h4 className="flex-1 text-[13px] font-semibold text-fg-2">{t('knowledge.description.label')}</h4>
                  {!editingDesc && (
                    <IconButton size="sm" label={t('knowledge.description.edit')} disabled={busy} onClick={startEditDesc}>
                      <Pencil size={14} />
                    </IconButton>
                  )}
                </div>
                {editingDesc ? (
                  <form onSubmit={saveDescription} className="flex flex-col gap-2">
                    <textarea
                      autoFocus
                      aria-label={t('knowledge.description.label')}
                      value={draftDesc}
                      rows={5}
                      maxLength={KNOWLEDGE_DESCRIPTION_MAX}
                      placeholder={t('knowledge.description.placeholder')}
                      onChange={(e) => setDraftDesc(e.target.value)}
                      className="scroll-thin resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-fg outline-none focus:border-accent"
                    />
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>
                        {t('knowledge.description.cancel')}
                      </Button>
                      <Button size="sm" variant="primary" type="submit" disabled={busy}>
                        {t('knowledge.description.save')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <p className={cn('max-h-40 overflow-y-auto whitespace-pre-line break-words text-[14px] scroll-thin', current.description ? 'text-fg' : 'text-fg-2')}>{current.description || t('knowledge.description.empty')}</p>
                )}
              </div>

              {/* 추가: 끌어다 놓기 · 파일 선택 · 링크 · GitHub */}
              {canEditFiles && (
                <div
                  data-knowledge-drop=""
                  className={cn('flex flex-col gap-3 rounded-xl border border-dashed border-line p-3 transition-colors', dragOver && 'border-accent bg-accent-soft')}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Upload size={15} className="text-fg-2" aria-hidden />
                    <span className="min-w-0 flex-1 text-[13px] text-fg-2">
                      {t('knowledge.add.drop')}
                      {dir && <span className="ml-1 text-muted">({t('knowledge.add.intoFolder', { name: dir })})</span>}
                    </span>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void pickFiles()}>
                      {t('knowledge.add.pick')}
                    </Button>
                  </div>

                  <form onSubmit={addLink} className="flex items-center gap-2">
                    <Link2 size={15} className="shrink-0 text-fg-2" aria-hidden />
                    <input
                      aria-label={t('knowledge.add.linkLabel')}
                      value={linkUrl}
                      placeholder={t('knowledge.add.linkPlaceholder')}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[13px] outline-none focus:border-accent"
                    />
                    <Button size="sm" variant="secondary" type="submit" disabled={busy || !linkUrl.trim()}>
                      {t('knowledge.add.linkSubmit')}
                    </Button>
                  </form>

                  <form onSubmit={addGit} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <GitBranch size={15} className="shrink-0 text-fg-2" aria-hidden />
                      <input
                        aria-label={t('knowledge.add.gitLabel')}
                        value={gitUrl}
                        placeholder={t('knowledge.add.gitPlaceholder')}
                        onChange={(e) => setGitUrl(e.target.value)}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[13px] outline-none focus:border-accent"
                      />
                      <Button size="sm" variant="secondary" type="submit" disabled={busy || !gitUrl.trim()}>
                        {t('knowledge.add.gitSubmit')}
                      </Button>
                    </div>
                    <div role="radiogroup" aria-label={t('knowledge.git.modeLabel')} className="flex flex-wrap gap-1 self-start rounded-lg bg-surface-2 p-0.5 pl-[23px]">
                      {GIT_MODES.map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="radio"
                          aria-checked={gitMode === m}
                          onClick={() => setGitMode(m)}
                          className={cn(
                            'min-h-7 rounded-md px-2.5 text-[12px] transition-colors',
                            gitMode === m ? 'bg-surface font-medium text-fg shadow-sm' : 'text-fg-2 hover:text-fg',
                          )}
                        >
                          {t(`knowledge.git.${m}`)}
                        </button>
                      ))}
                    </div>
                    <p className="pl-[23px] text-[12px] text-fg-2">{gitMode === 'clone' ? t('knowledge.git.cloneHint') : t('knowledge.git.zipHint')}</p>
                  </form>

                  {task && <ImportProgress task={task} progress={progress} now={now} onCancel={api.cancel ? cancelImport : undefined} />}
                </div>
              )}

              {notice && (
                <p role={notice.tone === 'error' ? 'alert' : 'status'} className={cn('rounded-lg px-3 py-2 text-[13px]', notice.tone === 'error' ? 'bg-danger-soft text-danger' : 'text-fg-2')}>
                  {notice.text}
                </p>
              )}

              {/* 폴더 탐색: 빵부스러기 · 현재 단계만 */}
              <div className="flex flex-col gap-2">
                <h4 className="text-[13px] font-semibold text-fg-2">{t('knowledge.tree.heading')}</h4>
                <nav aria-label={t('knowledge.tree.breadcrumb')} className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-fg-2">
                  <button
                    type="button"
                    aria-current={dir === '' ? 'page' : undefined}
                    disabled={listing || dir === ''}
                    onClick={() => enterDir('')}
                    className="rounded px-1 hover:text-accent disabled:text-fg disabled:hover:text-fg"
                  >
                    {t('knowledge.tree.root')}
                  </button>
                  {crumbs.map((name, i) => {
                    const path = crumbs.slice(0, i + 1).join('/');
                    const last = i === crumbs.length - 1;
                    return (
                      <span key={path} className="flex min-w-0 items-center gap-1">
                        <ChevronRight size={12} aria-hidden className="shrink-0" />
                        <button
                          type="button"
                          aria-current={last ? 'page' : undefined}
                          disabled={listing || last}
                          onClick={() => enterDir(path)}
                          className="min-w-0 truncate rounded px-1 hover:text-accent disabled:text-fg disabled:hover:text-fg"
                        >
                          {name}
                        </button>
                      </span>
                    );
                  })}
                </nav>

                {listing && (
                  <p role="status" className="flex items-center gap-2 py-2 text-[13px] text-fg-2">
                    <Loader2 size={14} aria-hidden className="animate-spin" />
                    {t('knowledge.tree.loading')}
                  </p>
                )}
                {!listing && entries.length === 0 && <p className="py-2 text-[13px] text-fg-2">{t('knowledge.tree.empty')}</p>}
                {!listing && entries.length > 0 && (
                  <ul aria-label={t('knowledge.tree.heading')} className="flex flex-col">
                    {entries.map((entry) => {
                      const name = entry.path.split('/').pop() ?? entry.path;
                      const badge = entry.source ? sourceBadge(entry.source) : null;
                      const Icon = entry.dir ? Folder : name.match(/\.(md|txt)$/i) ? FileText : File;
                      return (
                        <li key={entry.path} data-entry={entry.path} className="group flex items-center gap-1 rounded-md py-0.5 pr-1 hover:bg-surface-2">
                          {entry.dir ? (
                            <button
                              type="button"
                              title={entry.path}
                              onClick={() => enterDir(entry.path)}
                              className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1 text-left text-[13px] hover:text-accent"
                            >
                              <Icon size={15} className="shrink-0 text-fg-2" aria-hidden />
                              <span className="min-w-0 truncate">{name}</span>
                              {badge && <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-px text-[11px] text-fg-2">{badge}</span>}
                              <ChevronRight size={13} aria-hidden className="ml-auto shrink-0 text-fg-2" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              title={entry.path}
                              onClick={() => void showPreview(entry)}
                              className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-1 text-left text-[13px] hover:text-accent"
                            >
                              <Icon size={15} className="shrink-0 text-fg-2" aria-hidden />
                              <span className="min-w-0 flex-1 truncate">{name}</span>
                              {entry.size !== undefined && <span className="shrink-0 text-[12px] text-muted">{formatSize(entry.size)}</span>}
                            </button>
                          )}
                          {entry.dir && isPullable(entry) && canEditFiles && (
                            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => void pullRepo(entry)}>
                              {t('knowledge.git.pull')}
                            </Button>
                          )}
                          {canRemoveEntries && (
                            <IconButton size="sm" label={`${t('knowledge.tree.remove')}: ${name}`} disabled={busy} onClick={() => void removeEntry(entry)} className="size-6 opacity-70 hover:text-danger hover:opacity-100">
                              <X size={13} />
                            </IconButton>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {preview && (
                <div className="flex flex-col gap-2">
                  <h4 className="truncate text-[13px] font-semibold text-fg-2">{preview.path}</h4>
                  {preview.data.text === null ? (
                    <p className="text-[13px] text-fg-2">{t('knowledge.tree.binary')}</p>
                  ) : (
                    <>
                      {preview.data.truncated && <p className="text-[12px] text-fg-2">{t('knowledge.tree.truncated')}</p>}
                      <pre className="scroll-thin max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-fg">{preview.data.text}</pre>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    );
  })();

  return (
    <Modal open={open} onClose={onClose} label={t('knowledge.dialog.title')} size={full ? 'full' : 'tall'} className="md:max-w-4xl">
      <div className="flex h-13 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="flex-1 truncate text-[16px] font-semibold">{t('knowledge.dialog.title')}</h2>
        <IconButton label={full ? t('knowledge.dialog.exitFull') : t('knowledge.dialog.full')} aria-pressed={full} className="max-md:hidden" onClick={() => setFull((v) => !v)}>
          {full ? <Minimize2 size={17} /> : <Maximize2 size={16} />}
        </IconButton>
        <IconButton label={t('knowledge.dialog.close')} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      {body}
    </Modal>
  );
}

function sortKey(s: KbSort): 'knowledge.list.sortRecent' | 'knowledge.list.sortName' | 'knowledge.list.sortSize' {
  if (s === 'name') return 'knowledge.list.sortName';
  if (s === 'size') return 'knowledge.list.sortSize';
  return 'knowledge.list.sortRecent';
}

/** 가져오기 진행 막대. 비율을 알면 채워지고, 모르면 움직이는 막대를 보인다 */
function ImportProgress({ task, progress, now, onCancel }: { task: ImportTask; progress: KnowledgeProgress | null; now: number; onCancel?: () => void }) {
  const ratio = progress?.ratio;
  const percent = ratio === undefined ? undefined : Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  const phase = progress?.phase ?? (task.kind === 'git' ? 'clone' : task.kind === 'link' ? 'download' : 'copy');
  let label: string;
  if (phase === 'copy') label = progress?.files ? t('knowledge.progress.copied', { count: progress.files, size: formatSize(progress.bytes ?? 0) }) : t('knowledge.progress.copy');
  else label = t(`knowledge.progress.${phase}`);
  if (percent !== undefined) label = `${label} ${percent}%`;
  const seconds = Math.max(0, Math.floor((now - task.startedAt) / 1000));
  return (
    <div className="flex flex-col gap-1.5" data-knowledge-progress="">
      <div className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="min-w-0 flex-1 truncate" aria-live="polite">
          {label}
        </span>
        <span className="shrink-0 tabular-nums">{t('knowledge.progress.elapsed', { seconds })}</span>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t('knowledge.progress.cancel')}
          </Button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={t('knowledge.progress.label')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={label}
        className="relative h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        {percent === undefined ? (
          <div className="kb-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-accent" />
        ) : (
          <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${percent}%` }} />
        )}
      </div>
    </div>
  );
}

function Notice({ text, hint }: { text: string; hint?: string }) {
  if (!hint) return <p className="px-5 py-8 text-center text-[14px] text-fg-2">{text}</p>;
  return (
    <div className="flex flex-col items-center gap-1 px-5 py-8 text-center">
      <p className="text-[14px] font-medium text-fg">{text}</p>
      <p className="text-[13px] text-fg-2">{hint}</p>
    </div>
  );
}

/** 여러 번 나눠 넣은 결과를 하나로 합친다 */
function merge(results: KnowledgeAddResult[]): KnowledgeAddResult {
  return results.reduce<KnowledgeAddResult>((acc, r) => ({ added: [...acc.added, ...r.added], skipped: acc.skipped + r.skipped }), { added: [], skipped: 0 });
}
