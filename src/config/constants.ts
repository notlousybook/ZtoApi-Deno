/**
 * Application-wide constants and configuration values
 * All magic numbers and hardcoded values centralized here
 */

export const CONFIG = {
  // Server Configuration
  DEFAULT_PORT: 9090,

  // Token Management
  TOKEN_RETRY_THRESHOLD: 3,
  ANONYMOUS_TOKEN_TTL_MS: 60 * 60 * 1000, // 1 hour
  TOKEN_CACHE_DURATION_MS: 5 * 60 * 1000, // 5 minutes

  // Retry Configuration
  MAX_RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 2000,

  // Request Limits
  MAX_REQUEST_SIZE: 10 * 1024 * 1024, // 10MB

  // String Truncation
  DEFAULT_TRUNCATE_LENGTH: 50,

  // Upstream Configuration
  DEFAULT_FE_VERSION: "prod-fe-1.0.95" as string,
  DEFAULT_SIGNING_KEY: "key-@@@@)))()((9))-xxxx&&&%%%%%",
  ORIGIN_BASE: "https://chat.z.ai",
  API_ENDPOINT: "https://chat.z.ai/api/v2/chat/completions",

  // Browser Fingerprinting
  BROWSER_UA:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  SEC_CH_UA: '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
  SEC_CH_UA_MOBILE: "?0",
  SEC_CH_UA_PLATFORM: '"Windows"',

  // Default Values
  DEFAULT_API_KEY: "sk-your-key",
  DEFAULT_LANGUAGE: "en-US",

  // Feature Flags (from env)
  get DEBUG_MODE(): boolean {
    return Deno.env.get("DEBUG_MODE") !== "false";
  },
  get DEFAULT_STREAM(): boolean {
    return Deno.env.get("DEFAULT_STREAM") !== "false";
  },
  get DASHBOARD_ENABLED(): boolean {
    return Deno.env.get("DASHBOARD_ENABLED") !== "false";
  },
} as const;

export const UPSTREAM_URL = Deno.env.get("UPSTREAM_URL") || "https://chat.z.ai/api/v2/chat/completions";
export const DEFAULT_KEY = Deno.env.get("DEFAULT_KEY") || CONFIG.DEFAULT_API_KEY;
export const ZAI_TOKEN = Deno.env.get("ZAI_TOKEN") || "";
export const DEFAULT_LANGUAGE = Deno.env.get("DEFAULT_LANGUAGE") || CONFIG.DEFAULT_LANGUAGE;

export const HTTP_PROXY = Deno.env.get("HTTP_PROXY") || "";
export const HTTPS_PROXY = Deno.env.get("HTTPS_PROXY") || "";
export const SOCKS5_PROXY = Deno.env.get("SOCKS5_PROXY") || "";

export function getProxyConfig(): string | undefined {
  if (HTTPS_PROXY) return HTTPS_PROXY;
  if (HTTP_PROXY) return HTTP_PROXY;
  if (SOCKS5_PROXY) return SOCKS5_PROXY;
  return undefined;
}

/**
 * Validate environment configuration at startup
 */
export function validateEnvironment(): string[] {
  const warnings: string[] = [];

  if (!Deno.env.get("ZAI_TOKEN") && !Deno.env.get("ZAI_TOKENS")) {
    warnings.push("⚠️  No ZAI_TOKEN configured - will use anonymous tokens");
  }

  if (DEFAULT_KEY === CONFIG.DEFAULT_API_KEY) {
    warnings.push("⚠️  DEFAULT_KEY is still set to default value - please update for production!");
  }

  return warnings;
}
