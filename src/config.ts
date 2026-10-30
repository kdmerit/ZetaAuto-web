import type { AuthConfig } from './types';

const required = (value: string | undefined, name: string): string => {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} 설정이 없습니다.`);
  return normalized;
};

const httpsOrigin = (value: string, name: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} URL 형식이 올바르지 않습니다.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name}은 HTTPS URL이어야 합니다.`);
  }
  return url.toString().replace(/\/$/, '');
};

export function getAuthConfig(): AuthConfig {
  return {
    apiBaseUrl: httpsOrigin(
      required(import.meta.env.VITE_API_BASE_URL, 'VITE_API_BASE_URL'),
      'VITE_API_BASE_URL',
    ),
    cognitoDomain: httpsOrigin(
      required(import.meta.env.VITE_COGNITO_DOMAIN, 'VITE_COGNITO_DOMAIN'),
      'VITE_COGNITO_DOMAIN',
    ),
    clientId: required(
      import.meta.env.VITE_COGNITO_CLIENT_ID,
      'VITE_COGNITO_CLIENT_ID',
    ),
    redirectUri:
      import.meta.env.VITE_COGNITO_REDIRECT_URI?.trim() ||
      `${window.location.origin}${import.meta.env.BASE_URL}`,
    logoutUri:
      import.meta.env.VITE_COGNITO_LOGOUT_URI?.trim() ||
      `${window.location.origin}${import.meta.env.BASE_URL}`,
  };
}

export function tryGetAuthConfig(): AuthConfig | null {
  try {
    return getAuthConfig();
  } catch {
    return null;
  }
}

export const AUTH_CONFIG_ERROR =
  '웹 인증 설정이 아직 연결되지 않았습니다. 배포 출력값으로 VITE_COGNITO_CLIENT_ID와 VITE_COGNITO_DOMAIN을 설정해 주세요.';
