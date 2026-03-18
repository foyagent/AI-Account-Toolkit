/**
 * 通用类型定义
 */

export interface EmailResult {
  id: string;
  raw?: string;
  subject?: string;
  from?: string;
  createdAt?: string;
}

export interface CreateEmailResult {
  address: string;
  jwt?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface AccountData {
  email: string;
  password: string;
  email_jwt?: string;
  access_token?: string;
  account_id?: string;
  auth_token?: string;
  created_at: string;
}

export interface InviteTracker {
  team_name: string;
  team_email: string;
  child_email: string;
  invited_at: string;
  status: 'pending' | 'accepted' | 'failed';
}
