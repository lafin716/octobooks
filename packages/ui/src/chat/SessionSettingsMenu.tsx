import { t } from '../i18n';
import type { ID } from '@branch/core';
import { ListRestart, MoveHorizontal, Settings2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { actions, useApp } from '../app/store';
import { useUi } from '../app/uiState';
import { IconButton } from '../components/Button';
import { cn } from '../lib/cn';
import { reorganizeSession } from './turnActions';

/** 세션 본문 최대 너비. 넓게 보기를 켜면 넓힌다 (ADR-145) */
export function useContentMax(): 'max-w-5xl' | 'max-w-3xl' {
  return useUi((s) => s.wideView) ? 'max-w-5xl' : 'max-w-3xl';
}

/**
 * 세션 제목 오른쪽의 세션 설정 메뉴 (ADR-145).
 * 넓게 보기(기기별), 부모에 요약 붙이기(가지·초안 없음), 세션 재정리(대화에 답변이 있을 때)를 모은다.
 */
export function SessionSettingsMenu({ sessionId, page }: { sessionId: ID; page: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const session = useApp((s) => s.sessions[sessionId]);
  const hasDraft = useApp((s) => !!s.summaryDrafts[sessionId]);
  const streaming = useApp((s) => !!s.streaming[sessionId]);
  const answered = useApp((s) => !!s.messages[sessionId]?.some((m) => m.role === 'assistant' && m.content.trim()));
  const wide = useUi((s) => s.wideView);
  const setWide = useUi((s) => s.setWideView);

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!session) return null;
  const summary = !!session.parentId && !hasDraft;
  const reorganize = answered && !page;
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item =
    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-fg outline-none hover:bg-surface-2 focus:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent max-md:min-h-11';

  return (
    <div ref={box} className="relative shrink-0">
      <IconButton
        size="sm"
        label={t('chat.session.settings')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-session-settings=""
        onClick={() => setOpen(!open)}
        active={open}
      >
        <Settings2 size={15} />
      </IconButton>
      {open && (
        <div role="menu" aria-label={t('chat.session.settings')} className="animate-pop-in absolute top-full right-0 z-30 mt-1.5 w-60 rounded-xl border border-line bg-elev p-1 shadow-float">
          <button type="button" role="menuitemcheckbox" aria-checked={wide} data-wide-view="" onClick={() => setWide(!wide)} className={item}>
            <MoveHorizontal size={16} className="text-muted" />
            <span className="min-w-0 flex-1">{t('chat.session.wideView')}</span>
            <span aria-hidden className={cn('relative h-5 w-8 shrink-0 rounded-full transition-colors', wide ? 'bg-accent' : 'bg-line-strong')}>
              <span className={cn('absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform', wide && 'translate-x-3')} />
            </span>
          </button>
          {(summary || reorganize) && <div className="my-1 h-px bg-line" />}
          {summary && (
            <Item className={item} disabled={streaming} icon={<Sparkles size={16} className="text-anchor-line" />} onClick={run(() => void actions().requestSummary(sessionId))}>
              {session.summary ? t('chat.session.resummarize') : t('chat.session.summarizeToParent')}
            </Item>
          )}
          {reorganize && (
            <Item className={item} disabled={streaming} icon={<ListRestart size={16} className="text-muted" />} onClick={run(() => void reorganizeSession(sessionId))} data-reorganize="">
              {t('chat.session.reorganize')}
            </Item>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ className, icon, onClick, disabled, children, ...rest }: { className: string; icon: ReactNode; onClick(): void; disabled?: boolean; children: ReactNode; 'data-reorganize'?: string }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className={className} {...rest}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
