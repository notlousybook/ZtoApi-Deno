/**
 * Anthropic API handlers
 * Handles Anthropic-compatible API requests (/v1/messages, /v1/models, etc.)
 */

import {
  type AnthropicMessagesRequest,
  type AnthropicTokenCountRequest,
  convertAnthropicToOpenAI,
  convertOpenAIToAnthropic,
  countTokens,
  getClaudeModels,
} from "../../anthropic.ts";
import type { Message, UpstreamRequest } from "../types/definitions.ts";
import { getModelConfig } from "../config/models.ts";
import { addLiveRequest, recordRequestStats } from "../utils/stats.ts";
import { setCORSHeaders } from "../utils/helpers.ts";
import { processMessages, validateTools } from "../utils/validation.ts";
import { getAnonymousToken } from "../services/anonymous-token.ts";
import { callUpstreamWithHeaders } from "../services/upstream-caller.ts";
import { collectFullResponse, processUpstreamStream } from "../utils/stream.ts";

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
 * Handle Anthropic models endpoint
 */
export function handleAnthropicModels(request: Request): Response {
  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  const models = getClaudeModels();

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ data: models }), {
    status: 200,
    headers,
  });
}

/**
 * Handle Anthropic messages endpoint
 */
export async function handleAnthropicMessages(request: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const path = url.pathname;
  const userAgent = request.headers.get("User-Agent") || "";

  debugLog("Received Anthropic messages request");
  debugLog("🌐 User-Agent: %s", userAgent);

  // Process Anthropic beta flags for Claude Code compatibility
  const betaFlags = request.headers.get("anthropic-beta") || "";
  if (betaFlags) {
    debugLog("🚀 Anthropic beta flags: %s", betaFlags);

    // Parse beta flags to detect Claude Code and other features
    const betaFeatures = betaFlags.split(",").map((flag) => flag.trim());
    const isClaudeCode = betaFeatures.includes("claude-code-20250219");
    const hasFineGrainedToolStreaming = betaFeatures.includes("fine-grained-tool-streaming-2025-05-14");
    const hasInterleavedThinking = betaFeatures.includes("interleaved-thinking-2025-05-14");
    const hasTokenCounting = betaFeatures.includes("token-counting-2024-11-01");

    if (isClaudeCode) {
      debugLog("🤖 Claude Code request detected");
    }
    if (hasFineGrainedToolStreaming) {
      debugLog("🔧 Fine-grained tool streaming enabled");
    }
    if (hasInterleavedThinking) {
      debugLog("🧠 Interleaved thinking enabled");
    }
    if (hasTokenCounting) {
      debugLog("🔢 Token counting beta enabled");
    }
  }

  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // API key validation
  const authHeader = request.headers.get("Authorization") || request.headers.get("x-api-key");
  if (!authHeader || (!authHeader.startsWith("Bearer ") && !authHeader.startsWith("sk-"))) {
    debugLog("Missing or invalid Authorization header for Anthropic API");
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest(request.method, path, 401, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Missing or invalid API key",
        },
      }),
      {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
  const { validateApiKey } = await import("../utils/helpers.ts");
  if (!validateApiKey(`Bearer ${apiKey}`)) {
    debugLog("Invalid API key for Anthropic request");
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 401);
    addLiveRequest(request.method, path, 401, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      }),
      {
        status: 401,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  debugLog("Anthropic API key validated");

  // Read request body with optimized handling for large payloads
  let body: string;
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      debugLog("📥 Content-Length header: %d bytes", size);

      // Warn about large payloads
      if (size > 10 * 1024 * 1024) { // 10MB
        debugLog("⚠️ Very large request detected: %d bytes", size);
      } else if (size > 1024 * 1024) { // 1MB
        debugLog("📊 Large request detected: %d bytes", size);
      }
    }

    body = await request.text();
    debugLog("📥 Received Anthropic body length: %d chars", body.length);

    // Log payload size categories for debugging
    if (body.length > 50000) {
      debugLog("🦣 Large payload detected: %d chars (Claude Code style request)", body.length);
    } else if (body.length > 10000) {
      debugLog("📋 Medium payload: %d chars", body.length);
    } else {
      debugLog("📝 Small payload: %d chars", body.length);
    }
  } catch (error) {
    debugLog("Failed to read Anthropic request body: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Failed to read request body",
        },
      }),
      {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  // Parse JSON with performance monitoring for large payloads
  let anthropicReq: AnthropicMessagesRequest;
  try {
    const parseStartTime = Date.now();
    anthropicReq = JSON.parse(body) as AnthropicMessagesRequest;
    const parseDuration = Date.now() - parseStartTime;
    debugLog("✅ Anthropic JSON parsed successfully in %dms", parseDuration);

    // Log parsing performance for large payloads
    if (body.length > 50000 && parseDuration > 100) {
      debugLog("⚠️ Slow JSON parsing detected: %dms for %d chars", parseDuration, body.length);
    }
  } catch (error) {
    debugLog("Anthropic JSON parse failed: %v", error);
    debugLog("🔍 Failed JSON length: %d chars", body.length);
    debugLog("🔍 JSON preview: %s", body.substring(0, 200) + (body.length > 200 ? "..." : ""));
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON",
        },
      }),
      {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  // Process cache control and metadata for Claude Code compatibility
  if (anthropicReq.system && Array.isArray(anthropicReq.system)) {
    let cacheControlCount = 0;
    for (const systemBlock of anthropicReq.system) {
      if (systemBlock.cache_control) {
        cacheControlCount++;
        debugLog("🗄️ System block has cache_control: %s", systemBlock.cache_control.type);
      }
    }
    if (cacheControlCount > 0) {
      debugLog("📊 Found %d system blocks with cache_control", cacheControlCount);
    }
  }

  // Process message cache controls
  if (anthropicReq.messages) {
    let messageCacheControlCount = 0;
    for (const message of anthropicReq.messages) {
      if (Array.isArray(message.content)) {
        for (const contentBlock of message.content) {
          if (contentBlock.type === "text" && contentBlock.cache_control) {
            messageCacheControlCount++;
            debugLog("🗄️ Message content block has cache_control: %s", contentBlock.cache_control.type);
          }
        }
      }
    }
    if (messageCacheControlCount > 0) {
      debugLog("📊 Found %d message content blocks with cache_control", messageCacheControlCount);
    }
  }

  // Process metadata if present
  if (anthropicReq.metadata) {
    debugLog("📋 Request metadata: %s", JSON.stringify(anthropicReq.metadata));
    if (anthropicReq.metadata.user_id) {
      debugLog("👤 User ID from metadata: %s", anthropicReq.metadata.user_id);
    }
  }

  // Validate tools if present
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    try {
      // Convert Anthropic tools to OpenAI format for validation
      const openaiTools = anthropicReq.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
      validateTools(openaiTools);
      debugLog("✅ Anthropic tools validated successfully");
    } catch (error) {
      debugLog("Tool validation failed: %v", error);
      const duration = Date.now() - startTime;
      recordRequestStats(startTime, path, 400);
      addLiveRequest(request.method, path, 400, duration, userAgent);
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: error instanceof Error ? error.message : "Tool validation failed",
          },
        }),
        {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        },
      );
    }
  }

  // Convert to OpenAI format for processing
  const model = anthropicReq.model || "claude-3-haiku-20240307";
  const modelConfig = getModelConfig(model);
  const openaiReq = convertAnthropicToOpenAI(anthropicReq);

  debugLog("Converted to OpenAI format, model: %s", openaiReq.model);

  // Check if streaming
  const isStreaming = openaiReq.stream || false;

  // Get token for upstream request
  let authToken: string;
  try {
    authToken = await getAnonymousToken();
  } catch (error) {
    debugLog("Failed to get anonymous token: %v", error);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: "Failed to get authentication token",
        },
      }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  // Process messages
  let processedMessages: Message[];
  try {
    processedMessages = processMessages(openaiReq.messages as Message[], modelConfig);
  } catch (error) {
    debugLog("Failed to process messages: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: error instanceof Error ? error.message : "Failed to process messages",
        },
      }),
      {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  // Create upstream request
  const upstreamReq: UpstreamRequest = {
    stream: isStreaming,
    model: modelConfig.upstreamId,
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
    chat_id: `chat_${Date.now()}_${Math.random().toString(36).substring(7)}`,
  };

  debugLog("Created upstream request: %s", JSON.stringify(upstreamReq, null, 2));

  // Call upstream
  let response: Response;
  try {
    response = await callUpstreamWithHeaders(upstreamReq, upstreamReq.chat_id!, authToken);
  } catch (error) {
    debugLog("Upstream request failed: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 500);
    addLiveRequest(request.method, path, 500, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: "Failed to connect to upstream service",
        },
      }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  // Record stats
  const duration = Date.now() - startTime;
  recordRequestStats(startTime, path, response.status);
  addLiveRequest(request.method, path, response.status, duration, userAgent, model);

  // Convert response back to Anthropic format
  if (isStreaming) {
    return handleAnthropicStreamResponse(response, headers, model, openaiReq, startTime);
  } else {
    return handleAnthropicNonStreamResponse(response, headers, model, openaiReq, startTime);
  }
}

/**
 * Handle streaming response for Anthropic
 */
export async function handleAnthropicStreamResponse(
  upstreamResponse: Response,
  headers: Headers,
  model: string,
  _openaiReq: unknown,
  _startTime: number,
): Promise<Response> {
  if (!upstreamResponse.body) {
    const response = new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: "No response body from upstream",
        },
      }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
    // Dummy await to satisfy lint
    await Promise.resolve();
    return response;
  }

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Set up headers for streaming
  setCORSHeaders(headers);
  headers.set("Content-Type", "text/event-stream");
  headers.set("Cache-Control", "no-cache");
  headers.set("Connection", "keep-alive");

  // Process the upstream stream
  processUpstreamStream(
    upstreamResponse.body,
    writer,
    encoder,
    model,
  ).catch((error) => {
    debugLog("Error processing stream: %v", error);
  });

  const response = new Response(stream.readable, {
    status: upstreamResponse.status,
    headers,
  });

  // Dummy await to satisfy lint
  await Promise.resolve();

  return response;
}

/**
 * Handle non-streaming response for Anthropic
 */
export async function handleAnthropicNonStreamResponse(
  upstreamResponse: Response,
  headers: Headers,
  model: string,
  _openaiReq: unknown,
  _startTime: number,
): Promise<Response> {
  if (!upstreamResponse.ok) {
    const errorBody = await upstreamResponse.text();
    debugLog("Upstream error: %s", errorBody);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: "Upstream service returned an error",
        },
      }),
      {
        status: upstreamResponse.status,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  if (!upstreamResponse.body) {
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: "No response body from upstream",
        },
      }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const result = await collectFullResponse(upstreamResponse.body);
    const openaiResp = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: result.content,
            ...(result.reasoning_content && { reasoning_content: result.reasoning_content }),
          },
          finish_reason: "stop",
        },
      ],
      ...(result.usage && { usage: result.usage }),
    };

    const requestId = `msg_${Date.now()}`;
    const anthropicResp = convertOpenAIToAnthropic(openaiResp, model, requestId);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(anthropicResp), {
      status: 200,
      headers,
    });
  } catch (error) {
    debugLog("Failed to process response: %v", error);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "upstream_error",
          message: "Failed to process response",
        },
      }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Handle token count endpoint
 */
export async function handleAnthropicTokenCount(request: Request): Promise<Response> {
  const startTime = Date.now();
  const url = new URL(request.url);
  const path = url.pathname;
  const userAgent = request.headers.get("User-Agent") || "";

  debugLog("Received Anthropic token count request");

  const headers = new Headers();
  setCORSHeaders(headers);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  // Read and parse request body
  let body: string;
  try {
    body = await request.text();
  } catch (error) {
    debugLog("Failed to read request body: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Failed to read request body",
        },
      }),
      {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  let countReq: AnthropicTokenCountRequest;
  try {
    countReq = JSON.parse(body);
  } catch (error) {
    debugLog("Invalid JSON: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 400);
    addLiveRequest(request.method, path, 400, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Invalid JSON",
        },
      }),
      {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }

  try {
    const result = await countTokens(countReq);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 200);
    addLiveRequest(request.method, path, 200, duration, userAgent);

    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(result), {
      status: 200,
      headers,
    });
  } catch (error) {
    debugLog("Token counting failed: %v", error);
    const duration = Date.now() - startTime;
    recordRequestStats(startTime, path, 500);
    addLiveRequest(request.method, path, 500, duration, userAgent);
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "internal_error",
          message: "Token counting failed",
        },
      }),
      {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      },
    );
  }
}
