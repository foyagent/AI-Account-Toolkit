import { describe, it, expect, vi, beforeEach } from 'vitest';
import { gptLoginAndCPAUpload, batchGPTLoginAndCPAUpload, saveResult, type GPTAccount, type CodexUploadResult } from '../src/codex-cpa-upload.js';

vi.mock('../src/core/index.js', () => ({
  oauthLogin: vi.fn(),
  uploadToCPA: vi.fn(),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}));

import { oauthLogin, uploadToCPA } from '../src/core/index.js';
import { loadConfig } from '../src/config.js';

describe('codex-cpa-upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  describe('gptLoginAndCPAUpload', () => {
    it('应该成功登录并上传到 CPA', async () => {
      const account: GPTAccount = {
        email: 'test@example.com',
        password: 'password123',
      };

      vi.mocked(oauthLogin).mockResolvedValue('mock_access_token_1234567890');
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const result = await gptLoginAndCPAUpload(account);

      expect(result.email).toBe('test@example.com');
      expect(result.cpaUploaded).toBe(true);
      expect(result.accessToken).toBe('mock_access_token_1234567890');
      expect(result.message).toBe('成功完成登录和 CPA 上传');
      expect(oauthLogin).toHaveBeenCalledTimes(1);
      expect(uploadToCPA).toHaveBeenCalledTimes(1);
      expect(uploadToCPA).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
        'mock_access_token_1234567890'
      );
    });

    it('应该在登录失败时返回错误', async () => {
      const account: GPTAccount = {
        email: 'test@example.com',
        password: 'wrong_password',
      };

      vi.mocked(oauthLogin).mockResolvedValue(null);
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const result = await gptLoginAndCPAUpload(account);

      expect(result.email).toBe('test@example.com');
      expect(result.cpaUploaded).toBe(false);
      expect(result.accessToken).toBeUndefined();
      expect(result.message).toContain('登录失败');
      expect(oauthLogin).toHaveBeenCalledTimes(1);
      expect(uploadToCPA).not.toHaveBeenCalled();
    });

    it('应该在 CPA 上传失败时返回错误', async () => {
      const account: GPTAccount = {
        email: 'test@example.com',
        password: 'password123',
      };

      vi.mocked(oauthLogin).mockResolvedValue('mock_access_token');
      vi.mocked(uploadToCPA).mockResolvedValue(false);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const result = await gptLoginAndCPAUpload(account);

      expect(result.email).toBe('test@example.com');
      expect(result.cpaUploaded).toBe(false);
      expect(result.accessToken).toBe('mock_access_token');
      expect(result.message).toContain('CPA 上传失败');
      expect(oauthLogin).toHaveBeenCalledTimes(1);
      expect(uploadToCPA).toHaveBeenCalledTimes(1);
    });

    it('应该处理异常错误', async () => {
      const account: GPTAccount = {
        email: 'test@example.com',
        password: 'password123',
      };

      vi.mocked(oauthLogin).mockRejectedValue(new Error('Network error'));
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const result = await gptLoginAndCPAUpload(account);

      expect(result.email).toBe('test@example.com');
      expect(result.cpaUploaded).toBe(false);
      expect(result.message).toContain('Network error');
      expect(oauthLogin).toHaveBeenCalledTimes(1);
    });

    it('应该使用代理配置', async () => {
      const account: GPTAccount = {
        email: 'test@example.com',
        password: 'password123',
      };

      vi.mocked(oauthLogin).mockResolvedValue('mock_access_token');
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: 'http://proxy.example.com:8080' });

      await gptLoginAndCPAUpload(account);

      expect(oauthLogin).toHaveBeenCalledWith(
        'test@example.com',
        'password123',
        '',
        'http://proxy.example.com:8080'
      );
    });
  });

  describe('batchGPTLoginAndCPAUpload', () => {
    it('应该批量处理账号', async () => {
      const accounts: GPTAccount[] = [
        { email: 'user1@example.com', password: 'pass1' },
        { email: 'user2@example.com', password: 'pass2' },
      ];

      vi.mocked(oauthLogin).mockResolvedValue('mock_access_token');
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const result = await batchGPTLoginAndCPAUpload(accounts);

      expect(result.success.length).toBe(2);
      expect(result.fail).toBe(0);
      expect(oauthLogin).toHaveBeenCalledTimes(2);
      expect(uploadToCPA).toHaveBeenCalledTimes(2);
    });

    it('应该处理部分失败', async () => {
      const accounts: GPTAccount[] = [
        { email: 'user1@example.com', password: 'pass1' },
        { email: 'user2@example.com', password: 'pass2' },
      ];

      let callCount = 0;
      vi.mocked(oauthLogin).mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? 'mock_access_token' : null);
      });
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const result = await batchGPTLoginAndCPAUpload(accounts);

      expect(result.success.length).toBe(2);
      expect(result.fail).toBe(1);
      expect(result.success[0].cpaUploaded).toBe(true);
      expect(result.success[1].cpaUploaded).toBe(false);
    });

    it('应该调用 onProgress 回调', async () => {
      const accounts: GPTAccount[] = [
        { email: 'user1@example.com', password: 'pass1' },
        { email: 'user2@example.com', password: 'pass2' },
      ];

      const mockOnProgress = vi.fn();
      vi.mocked(oauthLogin).mockResolvedValue('mock_access_token');
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      await batchGPTLoginAndCPAUpload(accounts, mockOnProgress);

      expect(mockOnProgress).toHaveBeenCalledTimes(2);
      expect(mockOnProgress).toHaveBeenNthCalledWith(1, 1, 2, expect.any(Object));
      expect(mockOnProgress).toHaveBeenNthCalledWith(2, 2, 2, expect.any(Object));
    });

    it('应该在批量处理时在账号之间延迟', async () => {
      const accounts: GPTAccount[] = [
        { email: 'user1@example.com', password: 'pass1' },
        { email: 'user2@example.com', password: 'pass2' },
      ];

      vi.mocked(oauthLogin).mockResolvedValue('mock_access_token');
      vi.mocked(uploadToCPA).mockResolvedValue(true);
      vi.mocked(loadConfig).mockReturnValue({ proxy: '' });

      const startTime = Date.now();
      await batchGPTLoginAndCPAUpload(accounts);
      const elapsedTime = Date.now() - startTime;

      // 应该至少延迟 2 秒（因为有 2 个账号，中间延迟 1 次 2 秒）
      expect(elapsedTime).toBeGreaterThanOrEqual(2000);
    }, 5000);
  });

  describe('saveResult', () => {
    it('应该保存结果到文件', () => {
      const mockResult: CodexUploadResult = {
        email: 'test@example.com',
        accessToken: 'mock_token',
        cpaUploaded: true,
        message: '成功',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      // 注意：这个测试会实际写入文件
      // 在 CI/CD 环境中可能需要临时文件处理
      expect(() => saveResult(mockResult)).not.toThrow();
    });
  });

  describe('类型定义', () => {
    it('应该正确处理 GPTAccount 类型', () => {
      const account: GPTAccount = {
        email: 'test@example.com',
        password: 'password123',
      };
      expect(account.email).toBe('test@example.com');
      expect(account.password).toBe('password123');
    });

    it('应该正确处理 CodexUploadResult 类型', () => {
      const result: CodexUploadResult = {
        email: 'test@example.com',
        accessToken: 'token123',
        cpaUploaded: true,
        message: '成功',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      expect(result.email).toBe('test@example.com');
      expect(result.accessToken).toBe('token123');
      expect(result.cpaUploaded).toBe(true);
    });
  });
});
