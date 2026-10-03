import { randomBytes } from 'crypto';

/**
 * The nonce a webview's Content-Security-Policy admits its scripts by.
 *
 * It is the only thing standing between the page and a script that was not
 * ours, so it comes from the system's cryptographic source rather than
 * Math.random, whose output can be predicted from earlier values. 16 bytes is
 * the 128 bits the CSP specification asks a nonce to have at least.
 */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}
