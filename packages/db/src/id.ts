/**
 * 实体 id 生成。统一使用 ULID（Crockford Base32 编码，26 字符）。
 *
 * 与 UUIDv7 同样含 48-bit unix ms 时间戳，天然字典序时间有序；但比 UUIDv7 短 10 字符
 * （26 vs 36），4 个嵌套 id 即可节省 40 字符 —— 对 Windows 260 字符路径上限至关重要。
 *
 * 编码：32-char Crockford alphabet (0123456789ABCDEFGHJKMNPQRSTVWXYZ)，
 *      10 位时间戳 (48-bit) + 16 位随机 (80-bit)。
 */

export type EntityPrefix = 'thr' | 'msg' | 'lp' | 'tc';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function getRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function encodeTimestamp(ms: number): string {
  // 48 bit → 10 base32 chars
  let n = BigInt(ms);
  const out = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    out[i] = CROCKFORD[Number(n & 0x1fn)]!;
    n >>= 5n;
  }
  return out.join('');
}

function encodeRandom16(): string {
  // 16 base32 chars = 80 bits; sample 10 random bytes (80 bits) and base32-encode
  const bytes = getRandomBytes(10);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  const out = new Array<string>(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = CROCKFORD[Number(n & 0x1fn)]!;
    n >>= 5n;
  }
  return out.join('');
}

function ulid(): string {
  return encodeTimestamp(Date.now()) + encodeRandom16();
}

function newEntityId(prefix: EntityPrefix): string {
  return `${prefix}_${ulid()}`;
}

class IdGenerator {
  get thread(): string {
    return newEntityId('thr');
  }

  get agentLoop(): string {
    return newEntityId('lp');
  }

  get message(): string {
    return newEntityId('msg');
  }

  get tool(): string {
    return newEntityId('tc');
  }

  get trace() {
    return `trace_${Date.now()}`;
  }
}

export const genId = new IdGenerator();
