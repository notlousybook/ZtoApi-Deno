/**
 * OpenAI API handlers
 * Handles OpenAI-compatible chat completions API (/v1/chat/completions)
 */

import type { Message, OpenAIRequest, OpenAIResponse, UpstreamRequest } from "../types/definitions.ts";
import { getModelConfig } from "../config/models.ts";
import { addLiveRequest, recordRequestStats } from "../utils/stats.ts";
import { setCORSHeaders } from "../utils/helpers.ts";
import { processMessages, validateTools } from "../utils/validation.ts";
import { getAnonymousToken } from "../services/anonymous-token.ts";
import { getUpstreamClient } from "../services/upstream-client.ts";

/**
 * Debug logging function - will be injected
 */
let debugLog: (format: string, ...args: unknown[]) => void = () => {};

/**
 * Set the debug logger (called from main)
 */
export function setDebugLogger(logger: (format: string, ...args: unknown[]) => void) {
  debugLog = logger;
}

/**
 * Handle OpenAI-compatible chat completions
 */
export async function handleChatCompletions(request: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const path = url.pathname;
  const userAgent = request.headers.get("User-Agent") || "";

  debugLog("Received chat completions request");
  debugLog("🌐 User-Agent: %s", userAgent);

  // Read feature control headers
  const _thinkingHeader = request.headers.get("X-Feature-Thinking") || request.headers.get("X-Thinking");
  const _thinkTagsModeHeader = request.headers.get("X-Think-Tags-Mode");

  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // API key validation
  const authHeader = request.headers.get("Authorization");
  const { validateApiKey } = await import("../utils/helpers.ts");
  if (authHeader && !validateApiKey(authHeader)) {
    debugLog("Invalid Authorization header");
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest(request.method, path, 401, duration, userAgent);
    return new Response("Invalid Authorization header", {
      status: 401,
      headers,
    });
  }

  // Read request body
  let body: string;
  try {
    body = await request.text();
    debugLog("📥 Received body length: %d chars", body.length);
  } catch (error) {
    debugLog("Failed to read request body: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response("Failed to read request body", {
      status: 400,
      headers,
    });
  }

  // Parse JSON
  let openaiReq: OpenAIRequest;
  try {
    openaiReq = JSON.parse(body);
  } catch (error) {
    debugLog("JSON parse failed: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response("Invalid JSON", {
      status: 400,
      headers,
    });
  }

  // Validate tools if present
  try {
    validateTools(openaiReq.tools);
  } catch (error) {
    debugLog("Tool validation failed: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      error instanceof Error ? error.message : "Tool validation failed",
      {
        status: 400,
        headers,
      },
    );
  }

  const model = openaiReq.model || "glm-4.5";
  const modelConfig = getModelConfig(model);

  debugLog("Model: %s, Config: %s", model, modelConfig.id);

  // Check if streaming
  const isStreaming = openaiReq.stream !== false;

  // Get authentication token
  let authToken: string;
  try {
    authToken = await getAnonymousToken();
  } catch (error) {
    debugLog("Failed to get anonymous token: %v", error);
    return new Response("Failed to get authentication token", {
      status: 500,
      headers,
    });
  }

  // Process messages
  let processedMessages: Message[];
  try {
    processedMessages = processMessages(openaiReq.messages, modelConfig);
  } catch (error) {
    debugLog("Failed to process messages: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      error instanceof Error ? error.message : "Failed to process messages",
      {
        status: 400,
        headers,
      },
    );
  }

  // Create upstream request
  const upstreamReq: UpstreamRequest = {
    stream: isStreaming,
    model: model,
    messages: processedMessages,
    params: {
      top_p: modelConfig.defaultParams.top_p,
      temperature: modelConfig.defaultParams.temperature,
      ...(modelConfig.defaultParams.max_tokens && { max_tokens: modelConfig.defaultParams.max_tokens }),
    },
    features: {
      thinking: modelConfig.capabilities.thinking,
      ...(modelConfig.capabilities.vision && { vision: true }),
    },
    enable_thinking: modelConfig.capabilities.thinking,
  };

  debugLog("Created upstream request");

  // Call upstream using new upstream client
  let response: Response;
  try {
    const upstreamClient = await getUpstreamClient();
    response = await upstreamClient.chatCompletion(upstreamReq, modelConfig);
  } catch (error) {
    debugLog("Upstream request failed: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 500);
    addLiveRequest(request.method, path, 500, duration, userAgent);
    return new Response("Failed to connect to upstream service", {
      status: 500,
      headers,
    });
  }

  // Record stats
  const duration = Date.now() - startTime;
  recordRequestStats(startTime, path, response.status);
  addLiveRequest(request.method, path, response.status, duration, userAgent, model);

  // Upstream client already returns properly formatted response, just add CORS headers
  setCORSHeaders(headers);
  return response;
}
