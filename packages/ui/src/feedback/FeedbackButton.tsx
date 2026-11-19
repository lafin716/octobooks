import { RhymehubFeedback } from '@rhymehub/react';
import { MessageSquarePlus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, IconButton } from '../components/Button';
import { Modal } from '../components/Modal';
import { t } from '../i18n';
import { cn } from '../lib/cn';
import { createClient, feedbackActions, normalizeEndpoint, useFeedback, verifyConfig, type VerifyResult } from './store';

/** 숨긴 rhymehub 위젯 버튼에 붙이는 클래스 — openFeedback()이 찾아 누른다 */
const TRIGGER_CLASS = 'ob-feedback-trigger';

/**
 * 피드백 창을 연다 (ADR-147). 연결 전이면 키 입력 창을, 연결돼 있으면 rhymehub 피드백 창을 연다.
 * rhymehub 위젯의 자체 버튼은 화면 흐름에 놓여 앱 아래로 밀려나므로 숨기고, 이 함수가 대신 누른다.
 */
export function openFeedback() {
  const trigger = document.querySelector<HTMLButtonElement>(`button.rh-trigger.${TRIGGER_CLASS}`);
  if (useFeedback.getState().config && trigger) trigger.click();
  else feedbackActions.openConnect();
}

/** 상단 바 피드백 버튼 (모바일은 자리가 없어 설정 > 일반에서 연다) */
export function FeedbackButton() {
  return (
    <IconButton label={t('components.feedback.button')} title={t('components.feedback.button')} onClick={openFeedback}>
      <MessageSquarePlus size={18} />
    </IconButton>
  );
}

/** App에 한 번 둔다: 숨긴 rhymehub 위젯(피드백 창) + 키 입력 창 */
export function FeedbackHost() {
  const config = useFeedback((s) => s.config);
  const client = useMemo(() => {
    if (!config) return null;
    try {
      return createClient(config);
    } catch {
      return null;
    }
  }, [config]);
  return (
    <>
      {client && <RhymehubFeedback client={client} className={`hidden ${TRIGGER_CLASS}`} title={t('components.feedback.dialogTitle')} />}
      <FeedbackConnectDialog />
    </>
  );
}

const ERROR_TEXT: Record<Exclude<VerifyResult, 'ok'>, () => string> = {
  invalid: () => t('components.feedback.errInvalid'),
  unreachable: () => t('components.feedback.errUnreachable'),
  error: () => t('components.feedback.errOther'),
};

/** rhymehub 키 입력 창: 키·서버 주소를 받아 서버에 확인한 뒤 이 기기에 저장한다 */
export function FeedbackConnectDialog() {
  const open = useFeedback((s) => s.connectOpen);
  if (!open) return null;
  // 열 때마다 새로 그려 입력값을 지금 연결로 다시 채운다
  return <ConnectForm />;
}

function ConnectForm() {
  const config = useFeedback((s) => s.config);
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 개발 서버는 /api 프록시가 있어 주소를 비워도 된다. 패키징 앱은 주소가 있어야 한다
  const needsEndpoint = !import.meta.env.DEV;

  const submit = async () => {
    const k = key.trim();
    const ep = normalizeEndpoint(endpoint);
    if (!k.startsWith('rhk_')) return setError(t('components.feedback.errKeyFormat'));
    if (needsEndpoint && !ep) return setError(t('components.feedback.errEndpoint'));
    setBusy(true);
    setError(null);
    const next = { key: k, endpoint: ep };
    const result = await verifyConfig(next);
    setBusy(false);
    if (result === 'ok') feedbackActions.save(next);
    else setError(ERROR_TEXT[result]());
  };

  const input =
    'h-10 w-full min-w-0 rounded-lg border border-line bg-bg px-3 font-mono text-[13px] outline-none placeholder:font-sans focus:border-accent';

  return (
    <Modal open onClose={feedbackActions.closeConnect} label={t('components.feedback.connectTitle')} className="md:max-w-md">
      <div className="flex h-13 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="flex-1 text-[16px] font-semibold">{t('components.feedback.connectTitle')}</h2>
        <IconButton label={t('components.feedback.close')} onClick={feedbackActions.closeConnect}>
          <X size={18} />
        </IconButton>
      </div>
      <form
        className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-[13px] text-fg-2">{t('components.feedback.connectIntro')}</p>
        {config && <p className="text-[12.5px] text-muted">{t('components.feedback.connectedAs', { key: maskKey(config.key) })}</p>}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t('components.feedback.keyLabel')}</span>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="rhk_…"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className={input}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">{t('components.feedback.endpointLabel')}</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="http://my-mac.tailnet.ts.net:7780"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            className={input}
          />
          <span className="mt-1 block text-[12px] text-muted">
            {needsEndpoint ? t('components.feedback.endpointHint') : t('components.feedback.endpointHintDev')}
          </span>
        </label>
        {error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}
        <div className={cn('flex gap-2 pt-1', config ? 'justify-between' : 'justify-end')}>
          {config && (
            <Button
              variant="ghost"
              onClick={() => {
                feedbackActions.disconnect();
                feedbackActions.closeConnect();
              }}
            >
              {t('components.feedback.disconnect')}
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={busy || !key.trim()}>
            {busy ? t('components.feedback.verifying') : t('components.feedback.connect')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** 화면에는 키 앞뒤 몇 글자만 */
export function maskKey(key: string): string {
  return key.length <= 12 ? 'rhk_…' : `${key.slice(0, 8)}…${key.slice(-4)}`;
}
