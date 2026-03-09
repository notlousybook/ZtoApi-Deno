/**
 * Type definitions for the ZtoApi server
 * This file contains all the type definitions that were previously in main.ts
 */

declare global {
  interface ImportMeta {
    main: boolean;
  }
}

declare namespace Deno {
  interface Conn {
    readonly rid: number;
    localAddr: Addr;
    remoteAddr: Addr;
    read(p: Uint8Array): Promise<number | null>;
    write(p: Uint8Array): Promise<number>;
    close(): void;
  }

  interface Addr {
    hostname: string;
    port: number;
    transport: string;
  }

  interface Listener extends AsyncIterable<Conn> {
    readonly addr: Addr;
    accept(): Promise<Conn>;
    close(): void;
    [Symbol.asyncIterator](): AsyncIterableIterator<Conn>;
  }

  interface HttpConn {
    nextRequest(): Promise<RequestEvent | null>;
    [Symbol.asyncIterator](): AsyncIterableIterator<RequestEvent>;
  }

  interface RequestEvent {
    request: Request;
    respondWith(r: Response | Promise<Response>): Promise<void>;
  }

  function listen(options: { port: number }): Listener;
  function serveHttp(conn: Conn): HttpConn;
  function serve(options: { port: number; handler: (request: Request) => Promise<Response> }): void;

  namespace env {
    function get(key: string): string | undefined;
  }

  export function readTextFile(path: string): Promise<string>;
  export function readFile(path: string): Promise<Uint8Array>;
}

/**
 * Request statistics interface
 * Tracks metrics for API calls
 */
export interface RequestStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastRequestTime: Date;
  averageResponseTime: number;
}

/**
 * Live request info for Dashboard display
 */
export interface LiveRequest {
  id: string;
  timestamp: Date;
  method: string;
  path: string;
  status: number;
  duration: number;
  userAgent: string;
  model?: string;
}

/**
 * Chat message structure
 * Supports multimodal content: text, image, video, document, audio
 */
export interface Message {
  role: string;
  content:
    | string
    | Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
      video_url?: { url: string };
      document_url?: { url: string };
      audio_url?: { url: string };
    }>;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * Tool function definition
 */
export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Tool definition
 */
export interface Tool {
  type: "function";
  function: ToolFunction;
}

/**
 * Tool call in response
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Tool result message
 */
export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}

/**
 * OpenAI-compatible request structure for chat completions.
 */
export interface OpenAIRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  reasoning?: boolean;
  tools?: Tool[];
  tool_choice?: "none" | "auto" | "required";
}

/**
 * Upstream request structure sent to Z.ai API.
 */
export interface UpstreamRequest {
  stream: boolean;
  model: string;
  messages: Message[];
  params?: Record<string, unknown>;
  features?: Record<string, unknown>;
  tools?: Tool[];
  tool_choice?: "none" | "auto" | "required";
  enable_thinking?: boolean;
  web_search?: boolean;
  background_tasks?: Record<string, boolean>;
  chat_id?: string;
  id?: string;
  mcp_servers?: string[];
  model_item?: {
    id: string;
    name: string;
    owned_by: string;
    openai?: Record<string, unknown>;
    urlIdx?: number;
    info?: Record<string, unknown>;
    actions?: Record<string, unknown>[];
    tags?: Record<string, unknown>[];
  };
  tool_servers?: string[];
  variables?: Record<string, string>;
  signature_prompt?: string;
}

/**
 * OpenAI-compatible response structure
 */
export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export interface Choice {
  index: number;
  message?: Message;
  delta?: Delta;
  finish_reason?: string;
  tool_calls?: ToolCall[];
}

export interface Delta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Configuration for an MCP (Model Context Protocol) server.
 */
export interface MCPServerConfig {
  name: string;
  description: string;
  enabled: boolean;
}

/**
 * Capabilities of a model, indicating supported features.
 */
export interface ModelCapabilities {
  thinking: boolean;
  search: boolean;
  advancedSearch: boolean;
  vision: boolean;
  mcp: boolean;
}

/**
 * Structure representing an uploaded file.
 */
export interface UploadedFile {
  id: string;
  filename: string;
  size: number;
  type: string;
  url: string;
}

/**
 * Upstream SSE data structure
 */
export interface UpstreamData {
  type: string;
  data: {
    delta_content: string;
    edit_content?: string; // Contains complete thinking block when phase changes
    edit_index?: number;
    phase: string;
    done: boolean;
    usage?: Usage;
    error?: UpstreamError;
    inner?: {
      error?: UpstreamError;
    };
  };
  error?: UpstreamError;
}

export interface UpstreamError {
  detail: string;
  code: number;
}

export interface ModelsResponse {
  object: string;
  data: Model[];
}

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/**
 * Supported model configuration
 */
export interface ModelConfig {
  id: string; // Model ID as exposed by API
  name: string; // Display name
  upstreamId: string; // Upstream Z.ai model ID
  capabilities: {
    vision: boolean;
    mcp: boolean;
    thinking: boolean;
  };
  defaultParams: {
    top_p: number;
    temperature: number;
    max_tokens?: number;
  };
}

// Thinking content handling mode:
// - "strip": remove <details> tags and show only content
// - "thinking": convert <details> to <thinking> tags
// - "think": convert <details> to <think> tags
// - "raw": keep as-is
// - "separate": separate reasoning into reasoning_content field
export const THINK_TAGS_MODE = "think"; // options: "strip", "thinking", "think", "raw", "separate"
