export interface PiRuntimeConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

export function getPiRuntimeConfig(): PiRuntimeConfig {
  return {
    provider: (process.env.PI_PROVIDER ?? '').trim(),
    model: (process.env.PI_MODEL ?? '').trim(),
    apiKey: (process.env.PI_API_KEY ?? '').trim(),
    baseUrl: (process.env.PI_BASE_URL ?? '').trim(),
  };
}


export function piTimeoutMs(): number {
  const value = process.env.PI_TIMEOUT;
  if (value === undefined || value.trim() === '') return 14_400_000;

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid PI_TIMEOUT: ${value}`);
  }
  return Math.floor(seconds * 1000);
}
