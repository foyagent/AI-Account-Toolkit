import { randomBytes, randomInt } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Base64 } from 'js-base64';
import type { AxiosInstance } from 'axios';

const MAX_ATTEMPTS = 500_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * Sentinel Token 生成器（反机器人保护）
 */
export class SentinelTokenGenerator {
  private deviceId: string;
  private requirementsSeed: string;
  private sid: string;

  constructor(deviceId?: string) {
    this.deviceId = deviceId || uuidv4();
    this.requirementsSeed = Math.random().toString();
    this.sid = uuidv4();
  }

  /**
   * FNV-1a 32 位哈希
   */
  private static fnv1a32(text: string): string {
    let h = 2166136261;
    for (const ch of text) {
      h ^= ch.charCodeAt(0);
      h = (h * 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = (h * 2246822507) >>> 0;
    h ^= h >>> 13;
    h = (h * 3266489909) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * Base64 编码
   */
  private static b64(data: unknown): string {
    const json = JSON.stringify(data);
    return Base64.encode(json);
  }

  /**
   * 获取配置数组
   */
  private getConfig(): unknown[] {
    const now = new Date().toUTCString();
    const perfNow = Math.random() * 49000 + 1000;
    const timeOrigin = Date.now() - perfNow;

    return [
      '1920x1080',
      now,
      4294705152,
      Math.random(),
      USER_AGENT,
      'https://sentinel.openai.com/sentinel/20260124ceb8/sdk.js',
      null,
      null,
      'en-US',
      'en-US,en',
      Math.random(),
      'vendorSub-undefined',
      'location',
      'Object',
      perfNow,
      this.sid,
      '',
      [4, 8, 12, 16][randomInt(0, 4)],
      timeOrigin,
    ];
  }

  /**
   * 生成 requirements token
   */
  generateRequirementsToken(): string {
    const cfg = this.getConfig();
    cfg[3] = 1;
    cfg[9] = Math.floor(Math.random() * 45 + 5);
    return 'gAAAAAC' + SentinelTokenGenerator.b64(cfg);
  }

  /**
   * 生成完整 token
   */
  generateToken(seed?: string, difficulty?: string): string {
    const actualSeed = seed || this.requirementsSeed;
    const actualDifficulty = difficulty || '0';

    const cfg = this.getConfig();
    const start = Date.now();

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      cfg[3] = i;
      cfg[9] = Math.floor((Date.now() - start) * 1000);

      const data = SentinelTokenGenerator.b64(cfg);
      const hashHex = SentinelTokenGenerator.fnv1a32(actualSeed + data);

      const prefix = hashHex.slice(0, actualDifficulty.length);
      if (prefix <= actualDifficulty) {
        return 'gAAAAAB' + data + '~S';
      }
    }

    return 'gAAAAAB' + SentinelTokenGenerator.b64(null);
  }

  getDeviceId(): string {
    return this.deviceId;
  }
}

/**
 * 获取 Sentinel 挑战
 */
export async function fetchSentinelChallenge(
  session: AxiosInstance,
  deviceId: string,
  flow: string = 'authorize_continue'
): Promise<Record<string, unknown> | null> {
  const gen = new SentinelTokenGenerator(deviceId);

  const body = {
    p: gen.generateRequirementsToken(),
    id: deviceId,
    flow: flow,
  };

  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    Referer: 'https://sentinel.openai.com/backend-api/sentinel/frame.html',
    'User-Agent': USER_AGENT,
    Origin: 'https://sentinel.openai.com',
  };

  try {
    const response = await session.post('https://sentinel.openai.com/backend-api/sentinel/req', body, {
      headers,
      timeout: 15000,
    });

    if (response.status === 200 && typeof response.data === 'object') {
      return response.data;
    }
  } catch {
    // Ignore errors
  }

  return null;
}

/**
 * 构建 Sentinel Token
 */
export async function buildSentinelToken(
  session: AxiosInstance,
  deviceId: string,
  flow: string = 'authorize_continue'
): Promise<string> {
  const challenge = await fetchSentinelChallenge(session, deviceId, flow);

  if (!challenge) {
    const gen = new SentinelTokenGenerator(deviceId);
    return JSON.stringify({
      p: gen.generateRequirementsToken(),
      t: '',
      c: '',
      id: deviceId,
      flow: flow,
    });
  }

  const cValue = (challenge as any).token || '';
  const powData = (challenge as any).proofofwork || {};
  const gen = new SentinelTokenGenerator(deviceId);

  let pValue: string;
  if (typeof powData === 'object' && powData.required && powData.seed) {
    pValue = gen.generateToken(powData.seed, powData.difficulty || '0');
  } else {
    pValue = gen.generateRequirementsToken();
  }

  return JSON.stringify({
    p: pValue,
    t: '',
    c: cValue,
    id: deviceId,
    flow: flow,
  });
}
