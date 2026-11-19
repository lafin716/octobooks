import type { ReactNode } from 'react';
import { RhymehubFeedback, RhymehubProvider, type RhymehubClientOptions } from '@rhymehub/react';

// rhymehub 피드백 위젯 — 앱 안에서 버그·기능 요청을 rhymehub Inbox로 보낸다.
// 키(rhk_)가 없으면 위젯 없이 앱만 그린다 (키가 없는 개발 환경·배포 빌드는 그대로 동작).
// 주의: VITE_* 값은 번들에 들어가므로 프로젝트 리포터 키(rhk_)만 넣는다. API 토큰(rht_)은 절대 넣지 않는다.
const projectId = (import.meta.env.VITE_RHYMEHUB_PROJECT as string | undefined)?.trim();
const projectKey = (import.meta.env.VITE_RHYMEHUB_KEY as string | undefined)?.trim();
// 비우면 같은 출처의 /api → Vite 개발 서버 프록시 → rhymehub (vite.config.ts)
const endpoint = (import.meta.env.VITE_RHYMEHUB_PUBLIC_URL as string | undefined)?.trim() ?? '';

export function rhymehubOptions(): RhymehubClientOptions | null {
  if (!projectId || !projectKey) return null;
  return {
    projectId,
    projectKey,
    endpoint,
    appVersion: import.meta.env.VITE_APP_VERSION as string | undefined,
    platform: 'web',
  };
}

export function WithRhymehub({ children }: { children: ReactNode }) {
  const options = rhymehubOptions();
  if (!options) return <>{children}</>;
  return (
    <RhymehubProvider options={options}>
      {children}
      <RhymehubFeedback />
    </RhymehubProvider>
  );
}
