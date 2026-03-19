import yaml from 'yaml';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { AppConfig } from '../types/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function loadConfig(): AppConfig {
  const configPath = join(__dirname, '../config.yaml');

  try {
    const fileContent = readFileSync(configPath, 'utf-8');
    const config = yaml.parse(fileContent) as AppConfig;

    // 验证必需字段
    if (!config.temp_mail) {
      throw new Error('配置文件缺少 temp_mail 配置');
    }

    return config;
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      throw new Error(`找不到配置文件: ${configPath}`);
    }
    throw error;
  }
}
