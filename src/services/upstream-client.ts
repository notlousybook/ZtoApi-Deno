/**
 * Upstream Client
 * Handles all communication with Z.ai upstream API
 * Ported from Python implementation with full feature parity
 */

import { decodeBase64 } from "@std/encoding/base64";
import { CONFIG, UPSTREAM_URL } from "../config/constants.ts";
import { logger } from "../utils/logger.ts";
import { generateSignature } from "./signature.ts";
import { SmartHeaderGenerator } from "./header-generator.ts";
import { getTokenPool, TokenPool } from "./token-pool.ts";
import { GuestSessionPool, initializeGuestSessionPool } from "./guest-session-pool.ts";
import type { Message, UpstreamRequest } from "../types/definitions.ts";
import type { ModelConfig } from "../config/models.ts";

interface AuthInfo {
  token: string;
  userId: string;
  username: string;
  authMode: "authenticated" | "guest";
  tokenSource: string;
  guestUserId: string | null;
}

interface TransformedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  token: string;
  chatId: string;
  model: string;
  userId: string;
  authMode: string;
  tokenSource: string;
  guestUserId: string | null;
}

export class UpstreamClient {
  private tokenPool: TokenPool;
  private guestPool: GuestSessionPool | null = null;
  private anonymousMode: boolean;

  constructor() {
    this.tokenPool = getTokenPool();
    this.anonymousMode = !Deno.env.get("ZAI_TOKEN") && !Deno.env.get("ZAI_TOKENS");
  }

  async initialize(): Promise<void> {
    if (this.anonymousMode) {
      const poolSize = parseInt(Deno.env.get("GUEST_POOL_SIZE") || "3");
      const sessionMaxAge = parseInt(Deno.env.get("GUEST_SESSION_MAX_AGE") || "480");
      const maintenanceInterval = parseInt(Deno.env.get("GUEST_POOL_MAINTENANCE_INTERVAL") || "30");

      this.guestPool = await initializeGuestSessionPool(poolSize, sessionMaxAge, maintenanceInterval);
      logger.info("Guest session pool initialized for anonymous mode");
    }
  }

  private extractUserIdFromToken(token: string): string {
    try {
      const parts = token.split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(
          new TextDecoder().decode(decodeBase64(parts[1])),
        );
        for (const key of ["id", "user_id", "uid", "sub"]) {
          const val = payload[key];
          if (typeof val === "string" || typeof val === "number") {
            const strVal = String(val);
            if (strVal.length > 0) {
              return strVal;
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return "guest";
  }

  private async getAuthInfo(
    excludedTokens?: Set<string>,
    excludedGuestUserIds?: Set<string>,
  ): Promise<AuthInfo> {
    const token = await this.tokenPool.getToken(excludedTokens);

    if (token) {
      const userId = this.extractUserIdFromToken(token);
      return {
        token,
        userId,
        username: "User",
        authMode: "authenticated",
        tokenSource: "auth_pool",
        guestUserId: null,
      };
    }

    if (this.anonymousMode && this.guestPool) {
      try {
        const session = await this.guestPool.acquire(excludedGuestUserIds);
        if (session) {
          logger.info(`Using guest session: userId=${session.userId}`);
          return {
            token: session.token,
            userId: session.userId,
            username: session.username,
            authMode: "guest",
            tokenSource: "guest_pool",
            guestUserId: session.userId,
          };
        }
      } catch (error) {
        logger.warn(`Guest pool acquire failed, falling back to direct: ${error}`);
      }
    }

    return await this.fetchDirectGuestAuth();
  }

  private async fetchDirectGuestAuth(): Promise<AuthInfo> {
    try {
      const headers = await SmartHeaderGenerator.generateHeaders();
      const response = await fetch("https://chat.z.ai/api/v1/auths/", {
        method: "GET",
        headers: {
          ...headers,
          "Accept": "*/*",
        },
      });

      if (response.status === 200) {
        const data = await response.json() as { token: string; id?: string; name?: string; email?: string };
        const token = data.token?.trim();
        if (token) {
          const userId = data.id || this.extractUserIdFromToken(token);
          const username = data.name || data.email?.split("@")[0] || "Guest";
          logger.info(`Direct guest auth successful: ${token.substring(0, 20)}...`);
          return {
            token,
            userId: String(userId),
            username: String(username),
            authMode: "guest",
            tokenSource: "guest_direct",
            guestUserId: String(userId),
          };
        }
      }

      if (response.status === 405) {
        logger.error("Request blocked by WAF (405), cannot get direct guest auth");
      }
    } catch (error) {
      logger.warn(`Direct guest auth failed: ${error}`);
    }

    return {
      token: "",
      userId: "guest",
      username: "Guest",
      authMode: "guest",
      tokenSource: "guest_direct",
      guestUserId: null,
    };
  }

  private preprocessMessages(messages: Message[]): Message[] {
    const normalized: Message[] = [];

    for (const msg of messages) {
      const role = msg.role;

      if (role === "developer") {
        normalized.push({ ...msg, role: "system" });
        continue;
      }

      if (role === "tool") {
        const _toolCallId = msg.tool_call_id || "unknown";
        const name = (msg as unknown as { name?: string }).name || "unknown_tool";
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);

        const formatted = this.formatToolResultMessage(name, "{}", content);
        normalized.push({
          role: "user",
          content: formatted,
        });
        continue;
      }

      if (role === "assistant" && msg.tool_calls) {
        const toolCalls = msg.tool_calls;
        const content = typeof msg.content === "string" ? msg.content : "";
        const toolCallsText = this.formatAssistantToolCalls(toolCalls);

        const mergedContent = [content, toolCallsText].filter(Boolean).join("\n").trim();
        normalized.push({
          role: "assistant",
          content: mergedContent,
        });
        continue;
      }

      normalized.push({ ...msg });
    }

    return normalized;
  }

  private formatToolResultMessage(toolName: string, toolArguments: string, resultContent: string): string {
    return `<tool_execution_result>
<tool_name>${toolName}</tool_name>
<tool_arguments>${toolArguments}</tool_arguments>
<tool_output>${resultContent}</tool_output>
</tool_execution_result>`;
  }

  private formatAssistantToolCalls(toolCalls: Message["tool_calls"]): string {
    if (!toolCalls) return "";

    const blocks: string[] = [];

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name?.trim();
      if (!name) continue;

      const arguments_ = typeof toolCall.function?.arguments === "string"
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function?.arguments || {});

      blocks.push(`</minimax:tool_call>
<name>${name}</name>
<args_json>${arguments_}</args_json>
</function_call>`);
    }

    if (blocks.length === 0) return "";
    return `<function_calls>\n${blocks.join("\n")}\n</function_calls>`;
  }

  private extractLastUserText(messages: Message[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          return msg.content;
        }
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text" && part.text) {
              return part.text;
            }
          }
        }
      }
    }
    return "";
  }

  async transformRequest(
    request: UpstreamRequest,
    modelConfig: ModelConfig,
    excludedTokens?: Set<string>,
    excludedGuestUserIds?: Set<string>,
  ): Promise<TransformedRequest> {
    const normalizedMessages = this.preprocessMessages(request.messages);

    const authInfo = await this.getAuthInfo(excludedTokens, excludedGuestUserIds);
    const token = authInfo.token;

    if (!token) {
      throw new Error("Failed to obtain upstream authentication token");
    }

    const userId = authInfo.userId || this.extractUserIdFromToken(token);
    const chatId = `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const lastUserText = this.extractLastUserText(request.messages);

    const timestamp = Date.now();
    const requestId = crypto.randomUUID();
    const e = `requestId,${requestId},timestamp,${timestamp},user_id,${userId}`;

    const { signature } = await generateSignature(e, lastUserText, timestamp);

    const headers = await SmartHeaderGenerator.generateHeaders(chatId);
    headers["Authorization"] = `Bearer ${token}`;
    headers["X-Signature"] = signature;

    const requestModel = request.model.toLowerCase();
    const isThinkingModel = requestModel.includes("thinking");
    const isSearchModel = requestModel.includes("search");
    const isAdvancedSearch = requestModel.includes("advanced-search");

    const enableThinking = request.enable_thinking ?? isThinkingModel;
    const webSearch = request.web_search ?? (isSearchModel || isAdvancedSearch);

    const mcpServers: string[] = [];
    if (isAdvancedSearch) {
      mcpServers.push("advanced-search");
    }

    const bodyParams: Record<string, number> = {};
    const params = request.params as Record<string, unknown> | undefined;
    if (params?.temperature !== undefined) {
      bodyParams.temperature = Number(params.temperature);
    }
    if (params?.top_p !== undefined) {
      bodyParams.top_p = Number(params.top_p);
    }
    if (params?.max_tokens !== undefined) {
      bodyParams.max_tokens = Number(params.max_tokens);
    }

    const body: Record<string, unknown> = {
      stream: true,
      model: modelConfig.upstreamId,
      messages: normalizedMessages,
      signature_prompt: lastUserText,
      files: [],
      params: bodyParams,
      extra: {},
      features: {
        image_generation: false,
        web_search: webSearch,
        auto_web_search: webSearch,
        preview_mode: true,
        flags: [],
        features: [
          { type: "mcp", server: "vibe-coding", status: "hidden" },
          { type: "mcp", server: "ppt-maker", status: "hidden" },
          { type: "mcp", server: "image-search", status: "hidden" },
          { type: "mcp", server: "deep-research", status: "hidden" },
          { type: "tool_selector", server: "tool_selector", status: "hidden" },
          { type: "mcp", server: "advanced-search", status: "hidden" },
        ],
        enable_thinking: enableThinking,
      },
      background_tasks: {
        title_generation: false,
        tags_generation: false,
      },
      mcp_servers: mcpServers,
      variables: {
        "{{USER_NAME}}": "Guest",
        "{{USER_LOCATION}}": "Unknown",
        "{{CURRENT_DATETIME}}": new Date().toISOString().replace("T", " ").substring(0, 23),
        "{{CURRENT_DATE}}": new Date().toISOString().split("T")[0],
        "{{CURRENT_TIME}}": new Date().toTimeString().split(" ")[0],
        "{{CURRENT_WEEKDAY}}": new Date().toLocaleDateString("en-US", { weekday: "long" }),
        "{{CURRENT_TIMEZONE}}": "Asia/Shanghai",
        "{{USER_LANGUAGE}}": "zh-CN",
      },
      model_item: {
        id: modelConfig.upstreamId,
        name: request.model,
        owned_by: "Z.ai",
      },
      chat_id: chatId,
      id: requestId,
      session_id: crypto.randomUUID(),
      current_user_message_id: requestId,
      current_user_message_parent_id: null,
    };

    if (request.tools) {
      body.tools = request.tools;
      if (request.tool_choice) {
        body.tool_choice = request.tool_choice;
      }
    } else {
      body.tools = null;
    }

    const queryParams = new URLSearchParams({
      timestamp: timestamp.toString(),
      requestId,
      user_id: userId,
      version: "0.0.1",
      platform: "web",
      token,
      current_url: `https://chat.z.ai/c/${chatId}`,
      pathname: `/c/${chatId}`,
      signature_timestamp: timestamp.toString(),
    });

    const url = `${UPSTREAM_URL}?${queryParams.toString()}`;

    return {
      url,
      headers,
      body,
      token,
      chatId,
      model: request.model,
      userId,
      authMode: authInfo.authMode,
      tokenSource: authInfo.tokenSource,
      guestUserId: authInfo.guestUserId,
    };
  }

  async chatCompletion(
    request: UpstreamRequest,
    modelConfig: ModelConfig,
  ): Promise<Response> {
    const maxAttempts = this.getTotalRetryLimit();
    const excludedTokens = new Set<string>();
    const excludedGuestUserIds = new Set<string>();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const transformed = await this.transformRequest(
        request,
        modelConfig,
        excludedTokens,
        excludedGuestUserIds,
      );

      try {
        const response = await this.makeRequest(transformed);

        if (response.ok) {
          if (!this.isGuestAuth(transformed)) {
            this.tokenPool.markSuccess(transformed.token);
          }

          if (request.stream) {
            return this.handleStreamResponse(response, transformed);
          } else {
            return this.handleNonStreamResponse(response, transformed);
          }
        }

        const errorCode = response.status;
        const errorMessage = await response.text();

        if (this.shouldRetryGuestSession(errorCode, transformed)) {
          const guestUserId = transformed.guestUserId || transformed.userId;
          if (guestUserId) {
            excludedGuestUserIds.add(guestUserId);
          }
          if (this.guestPool) {
            await this.guestPool.reportFailure(guestUserId);
          }
          continue;
        }

        if (this.shouldRetryAuthenticatedSession(errorCode, transformed)) {
          excludedTokens.add(transformed.token);
          this.tokenPool.markFailure(transformed.token);
          continue;
        }

        return new Response(errorMessage, {
          status: errorCode,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        logger.error(`Upstream request failed: ${error}`);

        if (this.isGuestAuth(transformed) && this.guestPool) {
          await this.guestPool.release(transformed.guestUserId || "");
        } else {
          this.tokenPool.markFailure(transformed.token, error as Error);
        }

        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY_MS));
          continue;
        }

        throw error;
      }
    }

    throw new Error("Max retry attempts exceeded");
  }

  private getTotalRetryLimit(): number {
    const poolStatus = this.tokenPool.getPoolStatus();
    const authLimit = poolStatus.availableTokens;

    let guestLimit = 0;
    if (this.guestPool) {
      const guestStatus = this.guestPool.getPoolStatus();
      guestLimit = guestStatus.availableSessions;
    }

    return Math.max(1, authLimit + guestLimit);
  }

  private isGuestAuth(transformed: TransformedRequest): boolean {
    return transformed.authMode === "guest";
  }

  private shouldRetryGuestSession(statusCode: number, transformed: TransformedRequest): boolean {
    return (
      this.isGuestAuth(transformed) &&
      (statusCode === 401 || statusCode === 429)
    );
  }

  private shouldRetryAuthenticatedSession(statusCode: number, transformed: TransformedRequest): boolean {
    return (
      !this.isGuestAuth(transformed) &&
      Boolean(transformed.token) &&
      (statusCode === 401 || statusCode === 429)
    );
  }

  private async makeRequest(transformed: TransformedRequest): Promise<Response> {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: transformed.headers,
      body: JSON.stringify(transformed.body),
    };

    return await fetch(transformed.url, fetchOptions);
  }

  private async handleStreamResponse(response: Response, transformed: TransformedRequest): Promise<Response> {
    if (!response.body) {
      return new Response("No response body", { status: 500 });
    }

    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();

    await this.processStream(response.body, writer, encoder, transformed.model, transformed.chatId)
      .catch((error) => {
        logger.error(`Stream processing error: ${error}`);
      });

    const headers = new Headers();
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    headers.set("Connection", "keep-alive");
    headers.set("Access-Control-Allow-Origin", "*");

    return new Response(stream.readable, {
      status: response.status,
      headers,
    });
  }

  private async processStream(
    readable: ReadableStream<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    encoder: TextEncoder,
    model: string,
    chatId: string,
  ): Promise<void> {
    const reader = readable.getReader();
    let buffer = "";
    const usageInfo: Record<string, number> = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        const chunkValue = result.value;
        buffer += new TextDecoder().decode(chunkValue);

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const dataStr = trimmed.substring(5).trim();
          if (dataStr === "[DONE]" || dataStr === "DONE") {
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            await writer.close();
            return;
          }

          try {
            const chunk = JSON.parse(dataStr);
            const processedChunk = this.processUpstreamChunk(chunk, model, chatId, usageInfo);

            if (processedChunk) {
              await writer.write(encoder.encode(`data: ${JSON.stringify(processedChunk)}\n\n`));
            }
          } catch {
            // skip invalid JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processUpstreamChunk(
    chunk: unknown,
    model: string,
    chatId: string,
    usageInfo: Record<string, number>,
  ): Record<string, unknown> | null {
    if (!chunk || typeof chunk !== "object") return null;

    const chunkObj = chunk as Record<string, unknown>;
    const chunkType = chunkObj.type as string;
    const data = chunkType === "chat:completion" ? (chunkObj.data as Record<string, unknown>) : chunkObj;
    if (!data || typeof data !== "object") return null;

    const phase = data.phase as string | undefined;
    const deltaContent = (data.delta_content as string) || "";
    const editContent = (data.edit_content as string) || "";

    if (data.usage) {
      usageInfo = data.usage as Record<string, number>;
    }

    let content = "";
    let reasoningContent = "";

    if (phase === "thinking" && deltaContent) {
      reasoningContent = this.cleanReasoningDelta(deltaContent);
    } else if (phase === "answer" || phase === "other") {
      content = deltaContent || this.extractAnswerContent(editContent);
    } else if (phase === "search") {
      const citations = this.formatSearchResults(data);
      content = citations;
    }

    const result: Record<string, unknown> = {
      id: chatId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {} as Record<string, unknown>,
        finish_reason: null,
      }],
      usage: usageInfo,
    };

    const choices = result.choices as Array<Record<string, unknown>>;
    const choice0 = choices[0];

    if (reasoningContent) {
      choice0.delta = {
        reasoning_content: reasoningContent,
      };
    } else if (content) {
      choice0.delta = { content };
    }

    if (data.done || phase === "done") {
      choice0.finish_reason = "stop";
    }

    return result;
  }

  private cleanReasoningDelta(content: string): string {
    if (!content) return "";

    if (content.startsWith("<details")) {
      if (content.includes("</summary>\n>")) {
        return content.split("</summary>\n>").pop()?.trim() || content;
      }
      if (content.includes("</summary>\n")) {
        return content.split("</summary>\n").pop()?.replace(/^>\s*/, "").trim() || content;
      }
    }

    return content;
  }

  private extractAnswerContent(text: string): string {
    if (!text) return "";

    if (text.includes("</details>\n")) {
      return text.split("</details>\n").pop() || text;
    }
    if (text.includes("</details>")) {
      return text.split("</details>").pop()?.trim() || text;
    }

    return text;
  }

  private formatSearchResults(data: Record<string, unknown>): string {
    const searchInfo = data.results || data.sources || data.citations;
    if (!Array.isArray(searchInfo) || searchInfo.length === 0) return "";

    const citations: string[] = [];

    for (let i = 0; i < searchInfo.length; i++) {
      const item = searchInfo[i] as Record<string, unknown>;
      const title = (item.title as string) || (item.name as string) || `Result ${i + 1}`;
      const url = (item.url as string) || (item.link as string);

      if (url) {
        citations.push(`[${i + 1}] [${title}](${url})`);
      }
    }

    if (citations.length === 0) return "";
    return "\n\n---\n" + citations.join("\n");
  }

  private async handleNonStreamResponse(response: Response, transformed: TransformedRequest): Promise<Response> {
    const text = await response.text();
    const lines = text.split("\n");

    let finalContent = "";
    let reasoningContent = "";
    let usageInfo: Record<string, number> = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const dataStr = trimmed.substring(5).trim();
      if (dataStr === "[DONE]" || dataStr === "DONE") continue;

      try {
        const chunk = JSON.parse(dataStr);
        const chunkType = (chunk as Record<string, unknown>).type as string;
        const innerData = (chunk as Record<string, unknown>).data as Record<string, unknown> | undefined;

        if (!innerData) continue;

        if (innerData.usage) {
          usageInfo = innerData.usage as Record<string, number>;
        }

        const phase = innerData.phase as string | undefined;
        const deltaContent = (innerData.delta_content as string) || "";
        const editContent = (innerData.edit_content as string) || "";

        if (phase === "thinking" && deltaContent) {
          reasoningContent += this.cleanReasoningDelta(deltaContent);
        } else if (phase === "answer" || phase === "other") {
          finalContent += deltaContent || this.extractAnswerContent(editContent);
        } else if (phase === "search") {
          finalContent += this.formatSearchResults(innerData as Record<string, unknown>);
        }
      } catch {
        // skip invalid JSON
      }
    }

    finalContent = (finalContent || reasoningContent).trim();

    const result = {
      id: transformed.chatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: transformed.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: finalContent,
          ...(reasoningContent && { reasoning_content: reasoningContent }),
        },
        finish_reason: "stop",
      }],
      usage: usageInfo,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

let upstreamClient: UpstreamClient | null = null;

export async function getUpstreamClient(): Promise<UpstreamClient> {
  if (!upstreamClient) {
    upstreamClient = new UpstreamClient();
    await upstreamClient.initialize();
  }
  return upstreamClient;
}
