import { HERMES_HOME_DIR } from '../home.ts';

export const HERMES_BIN: string = process.env.HERMES_BIN ?? 'hermes';
export const HERMES_TIMEOUT_MS: number = parseInt(process.env.HERMES_TIMEOUT ?? '14400', 10) * 1000;
export const HERMES_PROVIDER: string = process.env.HERMES_PROVIDER ?? 'unknown';
export const SESSION_MAP_FILE = `${HERMES_HOME_DIR}/.hermes/_gateway_session_map.json`;
export const STATE_DB_PATH = `${HERMES_HOME_DIR}/.hermes/state.db`;
export const DYN_SYSTEM_PROMPT_FILE = `${HERMES_HOME_DIR}/dynamic/system-prompt.md`;
export const KILL_GRACE_MS = 3_000;

export const TOKEN_COLS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
] as const;

export type TokenCol = typeof TOKEN_COLS[number];
