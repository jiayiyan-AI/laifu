import { readFileSync } from 'node:fs';
import { HERMES_HOME_DIR } from '../../home.ts';

export const PORT: number = parseInt(process.env.PORT ?? '8080', 10);
export const DEFAULT_SESSION: string = process.env.HERMES_DEFAULT_SESSION ?? 'main';
export const DEFAULT_SOURCE: string = process.env.HERMES_DEFAULT_SOURCE ?? 'web';
export const GATEWAY_BASE_URL: string = process.env.GATEWAY_BASE_URL ?? '';
export const USER_ID: string = (process.env.USER_ID ?? '').trim();
export const GATEWAY_SECRET: string = (process.env.GATEWAY_SECRET ?? '').trim();
export const INBOX_CACHE_TTL_DAYS: number = parseInt(process.env.INBOX_CACHE_TTL_DAYS ?? '7', 10);
export const CALLBACK_MAX_RETRIES = 3;
export const HEARTBEAT_INTERVAL_MS = 120_000;

export const INBOX_ROOT_DIR = `${HERMES_HOME_DIR}/inbox`;
export const IMAGE_CACHE_DIR = `${INBOX_ROOT_DIR}/images`;
export const FILE_CACHE_DIR = `${INBOX_ROOT_DIR}/files`;
const TOKEN_FILE = `${HERMES_HOME_DIR}/.hermes/.laifu_user_token`;

function readLaifuToken(): string {
  const fromEnv = (process.env.LAIFU_USER_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

export const LAIFU_USER_TOKEN: string = readLaifuToken();
