import { codeFor, stepAt } from '../src/modules/identity/domain/totp';

const secret = process.argv[2];
if (!secret) throw new Error('usage: qa-print-otp.ts <base32-secret>');

const now = new Date();
const step = stepAt(now);
console.log(JSON.stringify({
  now: now.toISOString(),
  code: codeFor(secret, step),
  secondsRemaining: 30 - (Math.floor(now.getTime() / 1000) % 30),
}));
