/**
 * Guest Session Pool Management
 * Manages anonymous guest sessions for upstream API requests
 * Ported from Python implementation
 */

import { logger } from "../utils/logger.ts";
import { SmartHeaderGenerator } from "./header-generator.ts";

export interface GuestSession {
  token: string;
  userId: string;
  username: string;
  createdAt: number;
  activeRequests: number;
  valid: boolean;
  failureCount: number;
  lastFailureTime: number;
}

export class GuestSessionPool {
  private sessions: Map<string, GuestSession> = new Map();
  private poolSize: number;
  private sessionMaxAge: number;
  private maintenanceInterval: number;
  private maintenanceTask: number | null = null;
  private cleanupParallelism: number;

  constructor(
    poolSize: number = 3,
    sessionMaxAge: number = 480,
    maintenanceInterval: number = 30,
    cleanupParallelism: number = 4,
  ) {
    this.poolSize = Math.max(1, poolSize);
    this.sessionMaxAge = Math.max(60, sessionMaxAge);
    this.maintenanceInterval = Math.max(10, maintenanceInterval);
    this.cleanupParallelism = Math.max(1, cleanupParallelism);
  }

  async initialize(): Promise<void> {
    logger.info(`Initializing guest session pool with ${this.poolSize} sessions`);

    const createPromises: Promise<GuestSession | null>[] = [];
    for (let i = 0; i < this.poolSize; i++) {
      createPromises.push(this.createSession());
    }

    const results = await Promise.allSettled(createPromises);
    let created = 0;

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const session = result.value;
        this.sessions.set(session.userId, session);
        created++;
      }
    }

    if (created === 0) {
      const fallback = await this.createSession();
      if (fallback) {
        this.sessions.set(fallback.userId, fallback);
        created = 1;
      }
    }

    logger.info(`Guest session pool initialized with ${created} sessions`);
    this.startMaintenance();
  }

  private startMaintenance(): void {
    if (this.maintenanceTask !== null) return;

    const runMaintenance = async () => {
      try {
        await this.maintenanceLoop();
      } catch (error) {
        logger.warn(`Guest session pool maintenance error: ${error}`);
      }

      this.maintenanceTask = setTimeout(runMaintenance, this.maintenanceInterval * 1000);
    };

    runMaintenance();
  }

  private async maintenanceLoop(): Promise<void> {
    const now = Date.now() / 1000;
    const staleSessions: string[] = [];

    for (const [userId, session] of this.sessions.entries()) {
      const shouldRemove = (!session.valid || (now - session.createdAt) > this.sessionMaxAge) &&
        session.activeRequests === 0;

      if (shouldRemove) {
        staleSessions.push(userId);
      }
    }

    for (const userId of staleSessions) {
      const session = this.sessions.get(userId);
      if (session) {
        await this.deleteAllChats(session);
        this.sessions.delete(userId);
      }
    }

    await this.ensureCapacity();
  }

  private async ensureCapacity(): Promise<void> {
    const validSessions = this.getValidSessions();
    const need = this.poolSize - validSessions.length;

    if (need <= 0) return;

    const createPromises: Promise<GuestSession | null>[] = [];
    for (let i = 0; i < need; i++) {
      createPromises.push(this.createSession());
    }

    const results = await Promise.allSettled(createPromises);

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const session = result.value;
        if (!this.sessions.has(session.userId)) {
          this.sessions.set(session.userId, session);
        }
      }
    }
  }

  private async createSession(): Promise<GuestSession | null> {
    try {
      const headers = await SmartHeaderGenerator.generateHeaders();

      const response = await fetch("https://chat.z.ai/api/v1/auths/", {
        method: "GET",
        headers: {
          ...headers,
          "Accept": "*/*",
        },
      });

      if (response.status !== 200) {
        logger.warn(`Guest session creation failed: HTTP ${response.status}`);
        return null;
      }

      const data = await response.json() as {
        token: string;
        id?: string;
        user_id?: string;
        name?: string;
        email?: string;
      };

      const token = data.token?.trim();
      if (!token) {
        logger.warn("Guest session creation failed: no token in response");
        return null;
      }

      const userId = data.id || data.user_id || `guest-${token.substring(0, 12)}`;
      const username = data.name || data.email?.split("@")[0] || "Guest";

      logger.debug(`Guest session created: userId=${userId}`);

      return {
        token,
        userId: String(userId),
        username: String(username),
        createdAt: Date.now() / 1000,
        activeRequests: 0,
        valid: true,
        failureCount: 0,
        lastFailureTime: 0,
      };
    } catch (error) {
      logger.warn(`Guest session creation error: ${error}`);
      return null;
    }
  }

  private async deleteAllChats(session: GuestSession): Promise<boolean> {
    try {
      const headers = await SmartHeaderGenerator.generateHeaders();
      headers["Authorization"] = `Bearer ${session.token}`;
      headers["Accept"] = "application/json";
      headers["Content-Type"] = "application/json";

      const response = await fetch("https://chat.z.ai/api/v1/chats/", {
        method: "DELETE",
        headers,
      });

      if (response.status === 200) {
        logger.debug(`Deleted all chats for guest session: ${session.userId}`);
        return true;
      }

      logger.debug(`Failed to delete chats for ${session.userId}: HTTP ${response.status}`);
      return false;
    } catch (error) {
      logger.debug(`Error deleting chats for ${session.userId}: ${error}`);
      return false;
    }
  }

  private getValidSessions(excludeUserIds?: Set<string>): GuestSession[] {
    const now = Date.now() / 1000;
    const excluded = excludeUserIds || new Set<string>();

    return Array.from(this.sessions.values()).filter((session) =>
      session.valid &&
      (now - session.createdAt) < this.sessionMaxAge &&
      !excluded.has(session.userId)
    );
  }

  async acquire(excludeUserIds?: Set<string>): Promise<GuestSession | null> {
    const excluded = excludeUserIds || new Set<string>();

    const candidates = this.getValidSessions(excludeUserIds);
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        const aScore = a.activeRequests * 1000 + a.createdAt;
        const bScore = b.activeRequests * 1000 + b.createdAt;
        return aScore - bScore;
      });

      const session = candidates[0];
      const current = this.sessions.get(session.userId);
      if (current && current.valid && !excluded.has(current.userId)) {
        current.activeRequests++;
        return current;
      }
    }

    const newSession = await this.createSession();
    if (!newSession) return null;

    if (excluded.has(newSession.userId)) {
      await this.deleteAllChats(newSession);
      return this.acquire(excluded);
    }

    newSession.activeRequests = 1;
    this.sessions.set(newSession.userId, newSession);
    return newSession;
  }

  release(userId: string): void {
    const session = this.sessions.get(userId);
    if (session) {
      session.activeRequests = Math.max(0, session.activeRequests - 1);
    }
  }

  async reportFailure(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;

    session.valid = false;
    session.failureCount++;
    session.lastFailureTime = Date.now() / 1000;
    session.activeRequests = 0;

    this.sessions.delete(userId);
    await this.deleteAllChats(session);

    logger.warn(`Guest session marked as failed and removed: ${userId}`);
    await this.ensureCapacity();
  }

  async cleanupIdleChats(): Promise<void> {
    const idleSessions = Array.from(this.sessions.values()).filter(
      (session) => session.valid && session.activeRequests === 0,
    );

    const semaphore = async (concurrency: number, tasks: (() => Promise<void>)[]) => {
      const executing: Promise<void>[] = [];
      for (const task of tasks) {
        const p = Promise.resolve().then(() => task());
        executing.push(p);
        if (executing.length >= concurrency) {
          await Promise.race(executing);
          executing.splice(executing.findIndex((e) => e === p), 1);
        }
      }
      await Promise.all(executing);
    };

    const tasks = idleSessions.map((session) => async () => {
      await this.deleteAllChats(session);
    });
    await semaphore(this.cleanupParallelism, tasks);
  }

  getPoolStatus(): {
    totalSessions: number;
    validSessions: number;
    availableSessions: number;
    busySessions: number;
    expiredSessions: number;
  } {
    const now = Date.now() / 1000;
    const sessions = Array.from(this.sessions.values());

    const validSessions = sessions.filter(
      (s) => s.valid && (now - s.createdAt) < this.sessionMaxAge,
    );
    const busySessions = validSessions.filter((s) => s.activeRequests > 0);

    return {
      totalSessions: sessions.length,
      validSessions: validSessions.length,
      availableSessions: validSessions.length,
      busySessions: busySessions.length,
      expiredSessions: sessions.filter((s) => (now - s.createdAt) >= this.sessionMaxAge).length,
    };
  }

  async close(): Promise<void> {
    if (this.maintenanceTask !== null) {
      clearTimeout(this.maintenanceTask);
      this.maintenanceTask = null;
    }

    const idleSessions = Array.from(this.sessions.values()).filter(
      (s) => s.activeRequests === 0,
    );

    for (const session of idleSessions) {
      await this.deleteAllChats(session);
    }

    this.sessions.clear();
    logger.info("Guest session pool closed");
  }
}

let guestSessionPool: GuestSessionPool | null = null;

export async function initializeGuestSessionPool(
  poolSize: number = 3,
  sessionMaxAge: number = 480,
  maintenanceInterval: number = 30,
): Promise<GuestSessionPool> {
  if (guestSessionPool) {
    return guestSessionPool;
  }

  guestSessionPool = new GuestSessionPool(poolSize, sessionMaxAge, maintenanceInterval);
  await guestSessionPool.initialize();
  return guestSessionPool;
}

export function getGuestSessionPool(): GuestSessionPool | null {
  return guestSessionPool;
}

export async function closeGuestSessionPool(): Promise<void> {
  if (guestSessionPool) {
    await guestSessionPool.close();
    guestSessionPool = null;
  }
}
