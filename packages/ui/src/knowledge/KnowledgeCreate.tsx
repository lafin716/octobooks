import type { DesktopKnowledgeApi, KnowledgeBase } from '@branch/core';
import { useState, type FormEvent } from 'react';
import { t } from '../i18n';
import { Button, IconButton } from '../components/Button';
import { ArrowLeft } from 'lucide-react';
import { ipcErrorMessage } from './api';
import { kbErrorGuide } from './kbErrors';

export interface KnowledgeCreateProps {
  api: DesktopKnowledgeApi;
  /** 만들어진 지식베이스. 바로 상세 화면으로 간다 */
  onCreated(kb: KnowledgeBase, notice?: string): void;
  onCancel(): void;
}

/** 새 지식베이스: 이름과 (선택) 설명만 받는다. 파일·폴더·깃허브는 만든 뒤 상세 화면에서 추가한다. */
export function KnowledgeCreate({ api, onCreated, onCancel }: KnowledgeCreateProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const desc = description.trim();
      const kb = await api.create(trimmed, desc ? { description: desc } : undefined);
      onCreated(kb);
    } catch (err) {
      const guide = kbErrorGuide(err, t);
      const detail = ipcErrorMessage(err);
      const base = t('knowledge.create.failed');
      setError(guide ? `${base} ${guide}` : detail ? `${base} (${detail})` : base);
      setBusy(false);
    }
  };

  return (
    <section aria-label={t('knowledge.create.title')} data-knowledge-create="" className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <IconButton size="sm" label={t('knowledge.create.cancel')} disabled={busy} onClick={onCancel} className="md:hidden">
          <ArrowLeft size={16} />
        </IconButton>
        <h3 className="flex-1 text-[15px] font-semibold text-fg">{t('knowledge.create.title')}</h3>
      </div>

      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">{t('knowledge.create.nameLabel')}</span>
          <input
            autoFocus
            value={name}
            disabled={busy}
            maxLength={80}
            placeholder={t('knowledge.create.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-fg outline-none focus:border-accent disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">{t('knowledge.create.descriptionLabel')}</span>
          <textarea
            value={description}
            disabled={busy}
            rows={3}
            maxLength={500}
            placeholder={t('knowledge.create.descriptionPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
            className="scroll-thin resize-y rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-fg outline-none focus:border-accent disabled:opacity-60"
          />
          <span className="text-[12px] text-muted">{t('knowledge.create.descriptionHint')}</span>
        </label>

        {error && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('knowledge.create.cancel')}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={!trimmed || busy}>
            {busy ? t('knowledge.create.creating') : t('knowledge.create.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
