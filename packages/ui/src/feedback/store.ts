import { RhymehubClient, RhymehubError } from '@rhymehub/react';
import { create } from 'zustand';
import { desktop, mobile } from '../app/runtime';

// rhymehub 피드백 연결 (ADR-147). 키를 빌드에 넣지 않고, 사용자가 rhymehub에서 만든 리포터 키(rhk_)를
// 앱에서 직접 입력한다. 키·서버 주소는 이 기기 localStorage에만 둔다 (동기화·로그·백업에 넣지 않는다).
const STORAGE_KEY = 'octobooks.rhymehub';
// SDK 필수 값이지만 정보용이다: 서버는 키로 프로젝트를 찾는다
const PROJECT_ID = 'octobooks';
const APP_VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

export interface FeedbackConfig {
  /** 프로젝트 리포터 키 (rhk_) */
  key: string;
  /** rhymehub 코어 주소 (예: http://host.ts.net:7780). 빈 문자열이면 같은 출처(/api → 개발 서버 프록시) */
  endpoint: string;
}

export type VerifyResult = 'ok' | 'invalid' | 'unreachable' | 'error';

function load(): FeedbackConfig | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (v && typeof v === 'object' && 'key' in v && 'endpoint' in v && typeof v.key === 'string' && typeof v.endpoint === 'string' && v.key) {
      return { key: v.key, endpoint: v.endpoint };
    }
  } catch {
    // 저장소를 못 쓰거나 값이 깨졌으면 연결 안 된 상태로 본다
  }
  return null;
}

function persist(config: FeedbackConfig | null) {
  try {
    if (config) localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 저장하지 못해도 이번 실행 동안은 연결돼 있다
  }
}

/** 사용자가 적은 주소를 SDK 형식(스킴 포함, 끝 / · /api/v1 없음)으로. 비우면 같은 출처 */
export function normalizeEndpoint(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '').replace(/\/api\/v1$/, '').replace(/\/+$/, '');
}

export function createClient(config: FeedbackConfig): RhymehubClient {
  return new RhymehubClient({
    projectId: PROJECT_ID,
    projectKey: config.key,
    endpoint: config.endpoint,
    appVersion: APP_VERSION,
    platform: desktop ? 'desktop' : mobile ? 'android' : 'web',
  });
}

/** 키로 서버에 실제 요청해 본다 (이 설치가 보낸 요청 목록 — 부작용 없음) */
export async function verifyConfig(config: FeedbackConfig): Promise<VerifyResult> {
  try {
    await createClient(config).requests.list();
    return 'ok';
  } catch (e) {
    if (e instanceof RhymehubError) {
      if (e.status === 401 || e.status === 403 || e.code === 'invalid_key') return 'invalid';
      if (e.status === 0 || e.status === 404) return 'unreachable';
    }
    if (e instanceof TypeError) return 'unreachable';
    return 'error';
  }
}

interface FeedbackState {
  config: FeedbackConfig | null;
  /** 키 입력 창 */
  connectOpen: boolean;
}

export const useFeedback = create<FeedbackState>(() => ({ config: load(), connectOpen: false }));

export const feedbackActions = {
  openConnect: () => useFeedback.setState({ connectOpen: true }),
  closeConnect: () => useFeedback.setState({ connectOpen: false }),
  save(config: FeedbackConfig) {
    persist(config);
    useFeedback.setState({ config, connectOpen: false });
  },
  disconnect() {
    persist(null);
    useFeedback.setState({ config: null });
  },
};
