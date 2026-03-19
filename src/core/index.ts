/**
 * core/index.ts
 * ============
 * 核心模块统一导出
 * 所有核心函数都从 core/ 目录导出，不包含运行逻辑
 */

export { Registrar } from './registrar.js';
export { oauthLogin } from './oauth.js';
export { motherLogin, sendTeamInvite, codexOAuth, uploadToCPA } from './team.js';
export { createTempEmail, waitForOTP, generateRandomPassword } from '../utils/temp-mail.js';
export { generateRandomPassword as generatePassword } from '../utils/random.js';
