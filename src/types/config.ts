/**
 * 配置文件类型定义
 */

export interface TempMailConfig {
  worker_domain: string;
  email_domains: string[];
  admin_password: string;
}

export interface CliProxyConfig {
  management_url: string;
  password: string;
  api_base: string;
  upload_enabled: boolean;
}

export interface OutputConfig {
  accounts_file: string;
  invite_tracker_file: string;
  results_file: string;
}

export interface TeamConfig {
  name: string;
  email: string;
  password?: string;
  jwt?: string;
  max_invites: number;
  account_id?: string;
  auth_token?: string;
}

export interface AppConfig {
  total_accounts: number;
  temp_mail: TempMailConfig;
  cli_proxy?: CliProxyConfig;
  output: OutputConfig;
  teams: TeamConfig[];
  proxy?: string;
}
