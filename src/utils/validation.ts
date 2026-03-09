/**
 * Validation utilities
 * Contains model normalization and message processing functions
 */

import type { Message, ModelConfig, Tool } from "../types/definitions.ts";
import { getAllTools, hasTool } from "../services/tool-registry.ts";

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
 * Normalize model ID to handle different client naming formats
 */
export function normalizeModelId(modelId: string): string {
  const normalized = modelId.toLowerCase().trim();

  const modelMappings: Record<string, string> = {
    // GLM-4.5V mappings
    "glm-4.5v": "glm-4.5v",
    "glm4.5v": "glm-4.5v",
    "glm_4.5v": "glm-4.5v",
    "glm-4.5v-api": "glm-4.5v",
    "gpt-4-vision-preview": "glm-4.5v", // backward compatibility
    "glm-4.5V": "glm-4.5v", // Allow capital V

    // GLM-4.5 mappings
    "0727-360b-api": "0727-360B-API",
    "glm-4.5": "0727-360B-API",
    "glm4.5": "0727-360B-API",
    "glm_4.5": "0727-360B-API",
    "glm-4.5-api": "0727-360B-API",
    "gpt-4": "0727-360B-API", // backward compatibility

    // GLM-4.6 mappings (from example requests)
    "glm-4.6": "GLM-4-6-API-V1",
    "glm4.6": "GLM-4-6-API-V1",
    "glm_4.6": "GLM-4-6-API-V1",
    "glm-4-6-api-v1": "GLM-4-6-API-V1",
    "glm-4-6": "GLM-4-6-API-V1",
    "glm-4.6-api-v1": "GLM-4-6-API-V1", // Allow lowercase API
    // Add common capitalized versions, mapping to the already normalized lowercase keys
    // The input is already normalized to lowercase, so these explicit duplicates are unnecessary.
  };

  const mapped = modelMappings[normalized];
  if (mapped) {
    debugLog("🔄 Model ID mapping: %s → %s", modelId, mapped);
    return mapped;
  }

  return normalized;
}

/**
 * Process and validate multimodal messages
 * Supports image, video, document, audio types
 */
export function processMessages(messages: Message[], modelConfig: ModelConfig): Message[] {
  const processedMessages: Message[] = [];

  for (const message of messages) {
    const processedMessage: Message = { ...message };

    if (Array.isArray(message.content)) {
      debugLog("Detected multimodal message, blocks: %d", message.content.length);

      const mediaStats = {
        text: 0,
        images: 0,
        videos: 0,
        documents: 0,
        audios: 0,
        others: 0,
      };

      if (!modelConfig.capabilities.vision) {
        debugLog("Warning: Model %s does not support multimodal content but received it", modelConfig.name);
        // Keep only text blocks
        const textContent = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        processedMessage.content = textContent;
      } else {
        // GLM-4.5V supports full multimodal handling
        for (const block of message.content) {
          switch (block.type) {
            case "text":
              if (block.text) {
                mediaStats.text++;
                debugLog("📝 Text block length: %d", block.text.length);
              }
              break;

            case "image_url":
              if (block.image_url?.url) {
                mediaStats.images++;
                const url = block.image_url.url;
                if (url.startsWith("data:image/")) {
                  const mimeMatch = url.match(/data:image\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog("🖼️ Image data: %s format, size: %d chars", format, url.length);
                } else if (url.startsWith("http")) {
                  debugLog("🔗 Image URL: %s", url);
                } else {
                  debugLog("⚠️ Unknown image format: %s", url.substring(0, 50));
                }
              }
              break;

            case "video_url":
              if (block.video_url?.url) {
                mediaStats.videos++;
                const url = block.video_url.url;
                if (url.startsWith("data:video/")) {
                  const mimeMatch = url.match(/data:video\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog("🎥 Video data: %s format, size: %d chars", format, url.length);
                } else if (url.startsWith("http")) {
                  debugLog("🔗 Video URL: %s", url);
                } else {
                  debugLog("⚠️ Unknown video format: %s", url.substring(0, 50));
                }
              }
              break;

            case "document_url":
              if (block.document_url?.url) {
                mediaStats.documents++;
                const url = block.document_url.url;
                if (url.startsWith("data:application/")) {
                  const mimeMatch = url.match(/data:application\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog("📄 Document data: %s format, size: %d chars", format, url.length);
                } else if (url.startsWith("http")) {
                  debugLog("🔗 Document URL: %s", url);
                } else {
                  debugLog("⚠️ Unknown document format: %s", url.substring(0, 50));
                }
              }
              break;

            case "audio_url":
              if (block.audio_url?.url) {
                mediaStats.audios++;
                const url = block.audio_url.url;
                if (url.startsWith("data:audio/")) {
                  const mimeMatch = url.match(/data:audio\/([^;]+)/);
                  const format = mimeMatch ? mimeMatch[1] : "unknown";
                  debugLog("🎵 Audio data: %s format, size: %d chars", format, url.length);
                } else if (url.startsWith("http")) {
                  debugLog("🔗 Audio URL: %s", url);
                } else {
                  debugLog("⚠️ Unknown audio format: %s", url.substring(0, 50));
                }
              }
              break;

            default:
              mediaStats.others++;
              debugLog("❓ Unknown block type: %s", block.type);
          }
        }

        const totalMedia = mediaStats.images + mediaStats.videos + mediaStats.documents + mediaStats.audios;
        if (totalMedia > 0) {
          debugLog(
            "🎯 Multimodal stats: text(%d) images(%d) videos(%d) documents(%d) audio(%d)",
            mediaStats.text,
            mediaStats.images,
            mediaStats.videos,
            mediaStats.documents,
            mediaStats.audios,
          );
        }
      }
    } else if (typeof message.content === "string") {
      debugLog("📝 Plain text message, length: %d", message.content.length);
    }

    processedMessages.push(processedMessage);
  }

  return processedMessages;
}

/**
 * Validate tool parameters against schema
 * Enhanced to support complex Claude Code tool schemas with $schema, additionalProperties, etc.
 * @param toolName Name of the tool
 * @param parameters Parameters to validate
 * @param schema JSON schema to validate against
 * @throws Error if validation fails
 */
function validateToolParameters(
  toolName: string,
  parameters: unknown,
  schema: { type: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown },
): void {
  if (schema.type !== "object") {
    return; // Only validate object schemas
  }

  if (typeof parameters !== "object" || parameters === null) {
    if (schema.required && Array.isArray(schema.required) && schema.required.length > 0) {
      throw new Error(`Tool '${toolName}' requires an object with parameters, but received: ${typeof parameters}`);
    }
    return;
  }

  const params = parameters as Record<string, unknown>;
  const required = schema.required || [];
  const properties = schema.properties || {};
  const additionalProperties = schema.additionalProperties;

  // Check required parameters
  for (const requiredParam of required) {
    if (!(requiredParam in params)) {
      throw new Error(
        `Tool '${toolName}' is missing required parameter: '${requiredParam}'. Required parameters: ${
          (required as string[]).join(", ")
        }`,
      );
    }
  }

  // Check additionalProperties constraint
  if (additionalProperties === false) {
    for (const paramName of Object.keys(params)) {
      if (!(paramName in properties)) {
        throw new Error(
          `Tool '${toolName}' parameter '${paramName}' is not allowed. Additional properties are forbidden.`,
        );
      }
    }
  }

  // Check parameter types and constraints
  for (const [paramName, paramValue] of Object.entries(params)) {
    const paramSchema = properties[paramName];
    if (!paramSchema || typeof paramSchema !== "object") {
      continue; // Skip validation for unknown parameters unless additionalProperties is false
    }

    const paramSchemaObj = paramSchema as {
      type?: string | string[];
      enum?: unknown[];
      minLength?: number;
      format?: string;
      description?: string;
      [key: string]: unknown;
    };

    // Handle type validation (including union types)
    if (paramSchemaObj.type) {
      const expectedTypes = Array.isArray(paramSchemaObj.type) ? paramSchemaObj.type : [paramSchemaObj.type];

      const actualType = typeof paramValue;
      if (!expectedTypes.includes(actualType)) {
        throw new Error(
          `Tool '${toolName}' parameter '${paramName}' must be of type ${
            expectedTypes.join(" or ")
          }, but received ${actualType}`,
        );
      }
    }

    // Handle enum validation
    if (paramSchemaObj.enum && Array.isArray(paramSchemaObj.enum)) {
      if (!paramSchemaObj.enum.includes(paramValue)) {
        throw new Error(
          `Tool '${toolName}' parameter '${paramName}' must be one of: ${
            paramSchemaObj.enum.join(", ")
          }, but received: ${paramValue}`,
        );
      }
    }

    // Handle string constraints
    if (typeof paramValue === "string") {
      if (paramSchemaObj.minLength && paramValue.length < paramSchemaObj.minLength) {
        throw new Error(
          `Tool '${toolName}' parameter '${paramName}' must be at least ${paramSchemaObj.minLength} characters long, but received ${paramValue.length}`,
        );
      }
    }

    // Handle URI format validation
    if (paramSchemaObj.format === "uri" && typeof paramValue === "string") {
      try {
        new URL(paramValue);
      } catch {
        throw new Error(
          `Tool '${toolName}' parameter '${paramName}' must be a valid URI, but received: ${paramValue}`,
        );
      }
    }
  }
}

/**
 * Validate tools array in request
 * Enhanced to support both native and upstream tools, including complex Claude Code schemas
 * @param tools Tools array from request
 * @param toolArguments Optional tool arguments to validate
 * @param allowUpstreamTools Whether to allow non-native tools to pass through (default: true)
 * @throws Error if validation fails
 */
export function validateTools(
  tools?: Tool[],
  toolArguments?: Record<string, unknown>[],
  allowUpstreamTools: boolean = true,
): void {
  if (!tools || tools.length === 0) {
    return;
  }

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];

    if (tool.type !== "function") {
      throw new Error(`Unsupported tool type: ${tool.type}. Only 'function' type is supported.`);
    }

    if (!tool.function || !tool.function.name) {
      throw new Error("Tool function must have a name");
    }

    const toolName = tool.function.name;

    // Enhanced parameter schema validation
    if (tool.function.parameters) {
      if (typeof tool.function.parameters !== "object" || tool.function.parameters === null) {
        throw new Error(`Tool parameters must be a valid JSON schema object for tool: ${toolName}`);
      }

      const schema = tool.function.parameters as { type?: string; [key: string]: unknown };

      // Validate schema structure
      if (schema.type && schema.type !== "object") {
        throw new Error(
          `Tool parameters schema must have type 'object' for tool: ${toolName}, but received: ${schema.type}`,
        );
      }

      // Validate $schema if present (common in Claude Code tools)
      if (schema.$schema && typeof schema.$schema !== "string") {
        throw new Error(`Tool parameters $schema must be a string for tool: ${toolName}`);
      }

      // Validate properties if present
      if (schema.properties && typeof schema.properties !== "object") {
        throw new Error(`Tool parameters properties must be an object for tool: ${toolName}`);
      }

      // Validate required array if present
      if (schema.required && !Array.isArray(schema.required)) {
        throw new Error(`Tool parameters required must be an array for tool: ${toolName}`);
      }

      // Validate additionalProperties if present
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
        throw new Error(`Tool parameters additionalProperties must be a boolean for tool: ${toolName}`);
      }
    }

    // Check if tool is native
    if (hasTool(toolName)) {
      // Validate tool arguments if provided for native tools
      if (toolArguments && toolArguments[i] && tool.function.parameters) {
        validateToolParameters(
          toolName,
          toolArguments[i],
          tool.function.parameters as { type: string; properties?: Record<string, unknown>; required?: string[] },
        );
      }

      debugLog("✅ Validated native tool: %s", toolName);
    } else {
      // This is not a native tool (Claude Code tools like Task, Bash, Glob, etc.)
      if (allowUpstreamTools) {
        // Allow upstream tools to pass through with enhanced validation
        debugLog("🔄 Allowing upstream tool to pass through: %s", toolName);

        // Additional validation for complex Claude Code tools
        if (tool.function.parameters) {
          const schema = tool.function.parameters as {
            type?: string;
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
            [key: string]: unknown;
          };

          // Log complex schema features for debugging
          if (schema.$schema) {
            debugLog("📋 Tool %s uses JSON Schema: %s", toolName, schema.$schema);
          }

          if (schema.additionalProperties === false) {
            debugLog("🔒 Tool %s forbids additional properties", toolName);
          }

          if (schema.properties) {
            const propCount = Object.keys(schema.properties).length;
            debugLog("📝 Tool %s has %d properties defined", toolName, propCount);
          }
        }
      } else {
        // Strict mode - fail on non-native tools
        const availableTools = getAvailableToolNames();
        if (availableTools.length === 0) {
          throw new Error(`Tool not found: ${toolName}. No tools are currently registered.`);
        }
        throw new Error(`Tool not found: ${toolName}. Available tools: ${availableTools.join(", ")}`);
      }
    }
  }
}

/**
 * Get list of available tool names
 * @returns Array of tool names
 */
export function getAvailableToolNames(): string[] {
  return getAllTools().map((tool: { name: string }) => tool.name);
}
