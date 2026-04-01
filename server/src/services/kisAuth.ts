import { getSettings } from './settings';

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export function getKisConfig() {
  const s = getSettings();
  const appKey = process.env.KIS_APP_KEY || s.kisAppKey;
  const appSecret = process.env.KIS_APP_SECRET || s.kisAppSecret;
  const isVirtual = s.kisVirtual;
  const baseUrl = isVirtual
    ? 'https://openapivts.koreainvestment.com:9443'
    : 'https://openapi.koreainvestment.com:9443';
  return { appKey, appSecret, baseUrl, isVirtual };
}

export async function getAccessToken(): Promise<string> {
  const { appKey, appSecret, baseUrl } = getKisConfig();

  if (!appKey || !appSecret) {
    throw new Error('KIS AppKey 또는 AppSecret이 설정되지 않았습니다. 설정 페이지에서 입력해주세요.');
  }

  // 캐시된 토큰 재사용 (만료 5분 전까지)
  if (tokenCache && tokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokenCache.token;
  }

  // 설정이 바뀌면 기존 캐시 무효화
  tokenCache = null;

  const response = await fetch(`${baseUrl}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`KIS 토큰 발급 실패: ${response.status} ${err}`);
  }

  const data: any = await response.json();
  const token: string = data.access_token;
  const expiresIn = ((data.expires_in ?? 86400) - 3600) * 1000;
  tokenCache = { token, expiresAt: Date.now() + expiresIn };

  return token;
}

export function invalidateToken() {
  tokenCache = null;
}
