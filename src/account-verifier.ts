/**
 * account-verifier.ts
 * ================
 * 账号状态验证模块
 * 检测账号的登录状态、封禁/暂停/未验证等状态
 */

import axios from 'axios';
import type { AccountData } from './types/index.js';

export interface AccountStatus {
  email: string;
  status: 'active' | 'banned' | 'suspended' | 'unverified' | 'unknown';
  message: string;
  checkedAt: string;
  accountId?: string;
}

/**
 * 验证单个账号状态
 * @param account 账号数据
 * @returns 账号状态
 */
export async function verifyAccount(account: AccountData): Promise<AccountStatus> {
  const { email, password, access_token, email_jwt } = account;

  // 如果没有 access_token，尝试登录获取
  let token = access_token;

  if (!token && email && password) {
    // 这里应该调用 oauthLogin 函数获取 token
    // 为了简化，这里假设需要重新登录
    return {
      email,
      status: 'unverified',
      message: '缺少 access_token，需要重新登录',
      checkedAt: new Date().toISOString(),
    };
  }

  if (!token) {
    return {
      email,
      status: 'unknown',
      message: '账号信息不完整',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    // 使用 access_token 检查账号状态
    const response = await axios.get('https://api.openai.com/v1/organizations', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 10000,
    });

    if (response.status === 200) {
      const data = response.data as any;
      const organizations = data.data || [];

      if (organizations.length === 0) {
        return {
          email,
          status: 'suspended',
          message: '账号没有任何组织，可能被暂停',
          checkedAt: new Date().toISOString(),
        };
      }

      const org = organizations[0];
      return {
        email,
        status: 'active',
        message: '账号正常',
        accountId: org.id,
        checkedAt: new Date().toISOString(),
      };
    }
  } catch (error: any) {
    if (error.response) {
      const status = error.response.status;

      if (status === 401) {
        return {
          email,
          status: 'unverified',
          message: 'Token 过期或无效，需要重新登录',
          checkedAt: new Date().toISOString(),
        };
      } else if (status === 403) {
        const errorMsg = error.response.data?.error?.message || String(error.response.data);

        if (errorMsg.toLowerCase().includes('banned') || errorMsg.toLowerCase().includes('flagged')) {
          return {
            email,
            status: 'banned',
            message: '账号被封禁',
            checkedAt: new Date().toISOString(),
          };
        } else if (errorMsg.toLowerCase().includes('suspended')) {
          return {
            email,
            status: 'suspended',
            message: '账号被暂停',
            checkedAt: new Date().toISOString(),
          };
        }
      }
    }

    return {
      email,
      status: 'unknown',
      message: error.message || '验证失败',
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    email,
    status: 'unknown',
    message: '未知状态',
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 批量验证账号
 * @param accounts 账号列表
 * @param onProgress 进度回调
 * @returns 验证结果列表
 */
export async function verifyAccountsBatch(
  accounts: AccountData[],
  onProgress?: (current: number, total: number, status: AccountStatus) => void
): Promise<AccountStatus[]> {
  const results: AccountStatus[] = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const status = await verifyAccount(account);
    results.push(status);

    if (onProgress) {
      onProgress(i + 1, accounts.length, status);
    }

    // 避免请求过快
    if (i < accounts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  return results;
}
