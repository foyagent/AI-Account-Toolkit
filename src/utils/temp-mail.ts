import { randomInt, randomBytes } from 'crypto';
import type { AxiosInstance } from 'axios';
import type { TempMailConfig } from '../types/config.js';
import type { EmailResult, CreateEmailResult } from '../types/index.js';

/**
 * 创建临时邮箱
 */
export async function createTempEmail(
  session: AxiosInstance,
  config: TempMailConfig
): Promise<{ email: string | null; jwt: string | null }> {
  // 生成随机邮箱名
  const nameLen = randomInt(10, 15);
  const nameChars: string[] = [];

  for (let i = 0; i < nameLen; i++) {
    nameChars.push(String.fromCharCode(97 + randomInt(0, 26))); // a-z
  }

  // 随机插入数字
  const numInserts = randomInt(1, 3);
  for (let i = 0; i < numInserts; i++) {
    const pos = randomInt(2, nameChars.length);
    nameChars.splice(pos, 0, String.fromCharCode(48 + randomInt(0, 10))); // 0-9
  }

  const name = nameChars.join('');
  const chosenDomain = config.email_domains[randomInt(0, config.email_domains.length)];

  try {
    const response = await session.post(
      `https://${config.worker_domain}/admin/new_address`,
      {
        enablePrefix: true,
        name: name,
        domain: chosenDomain,
      },
      {
        headers: {
          'x-admin-auth': config.admin_password,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    if (response.status === 200 && response.data) {
      const email = response.data.address || null;
      const jwt = response.data.jwt || null;

      if (email) {
        return { email, jwt };
      }
    }
  } catch (error) {
    console.warn(`创建临时邮箱异常: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { email: null, jwt: null };
}

/**
 * 拉取邮件列表
 */
export async function fetchEmailsList(
  session: AxiosInstance,
  workerDomain: string,
  jwtToken: string
): Promise<EmailResult[]> {
  try {
    const response = await session.get(`https://${workerDomain}/api/mails`, {
      params: { limit: 10, offset: 0 },
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
      timeout: 30000,
    });

    if (response.status === 200 && response.data?.results) {
      return Array.isArray(response.data.results) ? response.data.results : [];
    }
  } catch {
    // Ignore errors
  }

  return [];
}

/**
 * 从邮件内容提取 6 位验证码
 */
export function extractOTP(content: string): string | null {
  if (!content) return null;

  // 尝试多种模式
  const patterns = [
    /background-color:\s*#F3F3F3[^>]*>[\s\S]*?(\d{6})[\s\S]*?<\/p>/,
    />\s*(\d{6})\s*</,
    /(?<![#&])\b(\d{6})\b/,
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const code = match[1];
      // 排除已知的无效验证码
      if (code !== '177010') {
        return code;
      }
    }
  }

  return null;
}

/**
 * 等待验证码（轮询）
 */
export async function waitForOTP(
  session: AxiosInstance,
  workerDomain: string,
  jwtToken: string,
  timeout: number = 120
): Promise<string | null> {
  const seenIds = new Set<string>();
  const startTime = Date.now();

  while (Date.now() - startTime < timeout * 1000) {
    const emails = await fetchEmailsList(session, workerDomain, jwtToken);

    for (const email of emails) {
      if (seenIds.has(email.id)) continue;
      seenIds.add(email.id);

      const code = extractOTP(email.raw || '');
      if (code) {
        console.log(`收到验证码: ${code}`);
        return code;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.warn(`等待验证码超时 (${timeout}s)`);
  return null;
}
