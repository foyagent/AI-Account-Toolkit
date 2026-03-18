import { randomBytes, createHash } from 'crypto';

/**
 * 生成 PKCE code_verifier 和 code_challenge
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // 生成随机 code_verifier
  const codeVerifier = randomBytes(64)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // 计算 code_challenge (SHA256 -> base64url)
  const digest = createHash('sha256').update(codeVerifier).digest();
  const codeChallenge = digest
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return { codeVerifier, codeChallenge };
}
