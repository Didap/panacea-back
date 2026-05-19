import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export function generateOtp(ttlMinutes: number): {
  code: string;
  hash: string;
  expiresAt: Date;
} {
  const code = String(randomInt(100_000, 1_000_000));
  return {
    code,
    hash: hashOtp(code),
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  };
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function verifyOtp(plain: string, hash: string): boolean {
  const incoming = Buffer.from(hashOtp(plain), 'hex');
  const stored = Buffer.from(hash, 'hex');
  if (incoming.length !== stored.length) return false;
  return timingSafeEqual(incoming, stored);
}
