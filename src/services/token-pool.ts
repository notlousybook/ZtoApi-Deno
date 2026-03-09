/**
 * Token Pool Management System
 * Supports multiple token rotation, validation, and health checks
 * Enhanced with token validation via API
 */

import { CONFIG, ZAI_TOKEN } from "../config/constants.ts";
import { logger } from "../utils/logger.ts";
import type { TokenInfo } from "../types/common.ts";
import { getAnonymousToken } from "./anonymous-token.ts";

export type TokenType = "user" | "guest" | "unknown";

export class TokenPool {
  private tokens: TokenInfo[] = [];
  private currentIndex: number = 0;
  private anonymousToken: string | null = null;
  private anonymousTokenExpiry: number = 0;
  private failureThreshold: number = CONFIG.TOKEN_RETRY_THRESHOLD;
  private recoveryTimeout: number = 30 * 60 * 1000; // 30 minutes

  constructor() {
    this.initializeTokens();
  }

  private initializeTokens(): void {
    const tokenEnv = Deno.env.get("ZAI_TOKENS");
    if (tokenEnv) {
      const tokenList = tokenEnv.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
      this.tokens = tokenList.map((token) => ({
        token,
        isValid: true,
        lastUsed: 0,
        failureCount: 0,
        isAnonymous: false,
      }));
      logger.info(`Token pool initialized with ${this.tokens.length} tokens`);
    } else if (ZAI_TOKEN) {
      this.tokens = [{
        token: ZAI_TOKEN,
        isValid: true,
        lastUsed: 0,
        failureCount: 0,
        isAnonymous: false,
      }];
      logger.info("Using single token configuration");
    } else {
      logger.warn("No token configured, will use anonymous token");
    }
  }

  async getToken(excludeTokens?: Set<string>): Promise<string> {
    if (this.tokens.length > 0) {
      const token = this.getNextValidToken(excludeTokens);
      if (token) {
        token.lastUsed = Date.now();
        return token.token;
      }
    }

    return await this.getAnonymousToken();
  }

  private getNextValidToken(excludeTokens?: Set<string>): TokenInfo | null {
    const excluded = excludeTokens || new Set<string>();

    const availableTokens = this.tokens.filter((t) =>
      t.isValid &&
      t.failureCount < this.failureThreshold &&
      !t.isAnonymous &&
      !excluded.has(t.token)
    );

    if (availableTokens.length === 0) {
      this.tryRecoverFailedTokens();
      const retryAvailable = this.tokens.filter((t) =>
        t.isValid &&
        t.failureCount < this.failureThreshold &&
        !t.isAnonymous &&
        !excluded.has(t.token)
      );

      if (retryAvailable.length === 0) {
        logger.warn("No available authenticated tokens");
        return null;
      }

      const token = retryAvailable[this.currentIndex % retryAvailable.length];
      this.currentIndex = (this.currentIndex + 1) % retryAvailable.length;
      return token;
    }

    const token = availableTokens[this.currentIndex % availableTokens.length];
    this.currentIndex = (this.currentIndex + 1) % availableTokens.length;
    return token;
  }

  private tryRecoverFailedTokens(): void {
    const now = Date.now();
    let recovered = 0;

    for (const token of this.tokens) {
      if (
        !token.isAnonymous &&
        !token.isValid &&
        (now - token.lastUsed) > this.recoveryTimeout
      ) {
        token.isValid = true;
        token.failureCount = 0;
        recovered++;
        logger.info(`Recovered failed token: ${token.token.substring(0, 20)}...`);
      }
    }

    if (recovered > 0) {
      logger.info(`Recovered ${recovered} failed tokens`);
    }
  }

  markSuccess(token: string): void {
    const tokenInfo = this.tokens.find((t) => t.token === token);
    if (tokenInfo) {
      tokenInfo.failureCount = 0;
      tokenInfo.isValid = true;
      tokenInfo.lastUsed = Date.now();
    }
  }

  markFailure(token: string, _error?: Error): void {
    const tokenInfo = this.tokens.find((t) => t.token === token);
    if (tokenInfo) {
      tokenInfo.failureCount++;
      tokenInfo.lastUsed = Date.now();

      if (tokenInfo.failureCount >= this.failureThreshold) {
        tokenInfo.isValid = false;
        logger.warn(
          `Token disabled after ${tokenInfo.failureCount} failures: ${token.substring(0, 20)}...`,
        );
      }
    }
  }

  async validateToken(token: string): Promise<TokenType> {
    try {
      const response = await fetch("https://chat.z.ai/api/v1/auths/", {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (response.status !== 200) {
        return "unknown";
      }

      const data = await response.json() as { role?: string };
      const role = data.role;

      if (role === "user") {
        return "user";
      } else if (role === "guest") {
        return "guest";
      }

      return "unknown";
    } catch (error) {
      logger.debug(`Token validation error: ${error}`);
      return "unknown";
    }
  }

  async healthCheckAll(): Promise<void> {
    if (this.tokens.length === 0) {
      logger.warn("Token pool is empty, skipping health check");
      return;
    }

    logger.info(`Starting token pool health check for ${this.tokens.length} tokens`);

    const checks = this.tokens.map(async (tokenInfo) => {
      const tokenType = await this.validateToken(tokenInfo.token);
      const wasGuest = tokenInfo.isAnonymous;

      if (tokenType === "guest") {
        tokenInfo.isAnonymous = true;
        tokenInfo.isValid = false;
        if (!wasGuest) {
          logger.warn(`Token marked as guest: ${tokenInfo.token.substring(0, 20)}...`);
        }
      } else if (tokenType === "user") {
        tokenInfo.isAnonymous = false;
        if (wasGuest) {
          logger.info(`Token now validated as user: ${tokenInfo.token.substring(0, 20)}...`);
        }
      } else {
        tokenInfo.isValid = false;
        logger.warn(`Token validation failed: ${tokenInfo.token.substring(0, 20)}...`);
      }
    });

    await Promise.allSettled(checks);
    logger.info("Token pool health check completed");
  }

  private async getAnonymousToken(): Promise<string> {
    const now = Date.now();

    if (this.anonymousToken && this.anonymousTokenExpiry > now) {
      return this.anonymousToken;
    }

    try {
      this.anonymousToken = await getAnonymousToken();
      this.anonymousTokenExpiry = now + CONFIG.ANONYMOUS_TOKEN_TTL_MS;
      logger.debug("Anonymous token obtained and cached");
      return this.anonymousToken;
    } catch (error) {
      logger.error(`Failed to obtain anonymous token: ${error}`);
      throw error;
    }
  }

  clearAnonymousTokenCache(): void {
    this.anonymousToken = null;
    this.anonymousTokenExpiry = 0;
    logger.debug("Anonymous token cache cleared");
  }

  getPoolSize(): number {
    return this.tokens.length;
  }

  isAnonymousToken(token: string): boolean {
    return this.anonymousToken === token;
  }

  getPoolStatus(): {
    totalTokens: number;
    availableTokens: number;
    validTokens: number;
  } {
    const available = this.tokens.filter((t) => t.isValid && t.failureCount < this.failureThreshold && !t.isAnonymous);

    return {
      totalTokens: this.tokens.length,
      availableTokens: available.length,
      validTokens: this.tokens.filter((t) => t.isValid).length,
    };
  }
}

let tokenPoolInstance: TokenPool | null = null;

export function getTokenPool(): TokenPool {
  if (!tokenPoolInstance) {
    tokenPoolInstance = new TokenPool();
  }
  return tokenPoolInstance;
}
