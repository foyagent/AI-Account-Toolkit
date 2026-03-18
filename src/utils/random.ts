import { randomBytes, randomInt } from 'crypto';

/**
 * 生成随机姓名
 */
export function generateRandomName(): { firstName: string; lastName: string } {
  const firstNames = ['James', 'Robert', 'John', 'Michael', 'David', 'Mary', 'Jennifer', 'Linda', 'Emma', 'Olivia'];
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller'];

  return {
    firstName: firstNames[randomInt(0, firstNames.length)],
    lastName: lastNames[randomInt(0, lastNames.length)],
  };
}

/**
 * 生成随机生日（1992-2003）
 */
export function generateRandomBirthday(): string {
  const year = randomInt(1992, 2004);
  const month = randomInt(1, 13).toString().padStart(2, '0');
  const day = randomInt(1, 29).toString().padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * 生成随机密码
 */
export function generateRandomPassword(length: number = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
  const password: string[] = [];

  // 确保包含至少一个大写字母、一个小写字母、一个数字和一个特殊字符
  password.push(String.fromCharCode(65 + randomInt(0, 26))); // A-Z
  password.push(String.fromCharCode(97 + randomInt(0, 26))); // a-z
  password.push(String.fromCharCode(48 + randomInt(0, 10))); // 0-9
  password.push('!@#$%'[randomInt(0, 5)]);

  // 填充剩余长度
  for (let i = password.length; i < length; i++) {
    password.push(chars[randomInt(0, chars.length)]);
  }

  // 随机打乱
  for (let i = password.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [password[i], password[j]] = [password[j], password[i]];
  }

  return password.join('');
}
