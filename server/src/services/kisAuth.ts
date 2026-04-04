import { getSettings } from './settings';
import logger from '../logger';

let tokenRetryCount = 0;
const MAX_TOKEN_RETRIES = 3;

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
    tokenRetryCount++;
    if (tokenRetryCount <= MAX_TOKEN_RETRIES) {
      logger.error({ retryCount: tokenRetryCount, maxRetries: MAX_TOKEN_RETRIES }, 'KIS token issuance failed, retrying in 10s');
      await new Promise(r => setTimeout(r, 10000));
      return getAccessToken(); // 재귀 재시도
    }
    tokenRetryCount = 0;
    throw new Error(`KIS 토큰 발급 실패 (${MAX_TOKEN_RETRIES}회 재시도 후): ${response.status} ${err}`);
  }

  tokenRetryCount = 0;
  const data: any = await response.json();
  const token: string = data.access_token;
  const expiresIn = ((data.expires_in ?? 86400) - 3600) * 1000;
  tokenCache = { token, expiresAt: Date.now() + expiresIn };

  logger.info({ expiresAt: new Date(tokenCache.expiresAt).toISOString() }, 'KIS token issued successfully');
  return token;
}

export function invalidateToken() {
  tokenCache = null;
}
