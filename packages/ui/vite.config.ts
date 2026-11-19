import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { pdfjsAssets } from './vitePdfjs';

// 설정 화면에 표시할 앱 버전 — 데스크톱 앱 버전을 기준으로 한다
const { version } = JSON.parse(
  readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8'),
) as { version: string };

// Tailscale MagicDNS(*.ts.net)로 휴대폰 등 원격 기기에서 접속 허용
const allowedHosts = ['.ts.net', 'localhost'];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // rhymehub 피드백 위젯: 브라우저는 같은 출처 /api 로 보내고 개발 서버가 rhymehub 코어로 넘긴다 (CORS 불필요)
  const proxy = {
    '/api': { target: env.VITE_RHYMEHUB_ENDPOINT || 'http://127.0.0.1:7780', changeOrigin: true },
  };
  return {
    plugins: [react(), tailwindcss(), pdfjsAssets()],
    define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) },
    server: { host: '0.0.0.0', port: 5173, allowedHosts, proxy },
    preview: { host: '0.0.0.0', port: 4173, allowedHosts, proxy },
  };
});
