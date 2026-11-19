import { KeyRound, MessageSquarePlus } from 'lucide-react';
import { Button } from '../components/Button';
import { t } from '../i18n';
import { Section } from '../settings/controls';
import { maskKey, openFeedback } from './FeedbackButton';
import { feedbackActions, useFeedback } from './store';

/** 설정 > 일반 > 피드백 (ADR-147): 연결 상태, 키 입력·바꾸기, 피드백 보내기 (모바일은 상단 바 버튼 대신 여기서) */
export function FeedbackSettings() {
  const config = useFeedback((s) => s.config);
  return (
    <Section title={t('components.feedback.settingsTitle')} hint={t('components.feedback.settingsHint')}>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3.5 py-3">
        <div className="min-w-0 text-[13px]">
          {config ? (
            <>
              <div className="font-medium">{t('components.feedback.statusConnected')}</div>
              <div className="mt-0.5 truncate font-mono text-[12px] text-muted">
                {maskKey(config.key)} · {config.endpoint || t('components.feedback.sameOrigin')}
              </div>
            </>
          ) : (
            <div className="text-fg-2">{t('components.feedback.statusNone')}</div>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={<KeyRound size={14} />} onClick={feedbackActions.openConnect}>
            {config ? t('components.feedback.changeKey') : t('components.feedback.enterKey')}
          </Button>
          {config && (
            <Button size="sm" variant="soft" icon={<MessageSquarePlus size={14} />} onClick={openFeedback}>
              {t('components.feedback.button')}
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}
