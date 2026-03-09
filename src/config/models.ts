/**
 * Model configuration and capabilities
 */

import { normalizeModelId } from "../utils/helpers.ts";
import { logger } from "../utils/logger.ts";
import type { ModelCapabilities } from "../types/common.ts";

/**
 * Model configuration interface
 */
export interface ModelConfig {
  id: string; // Model ID as exposed by API
  name: string; // Display name
  upstreamId: string; // Upstream Z.ai model ID
  capabilities: {
    vision: boolean;
    mcp: boolean;
    thinking: boolean;
    search?: boolean;
    advancedSearch?: boolean;
  };
  defaultParams: {
    top_p: number;
    temperature: number;
    max_tokens?: number;
  };
}

/**
 * Supported models configuration
 */
export const SUPPORTED_MODELS: ModelConfig[] = [
  {
    id: "0727-360B-API",
    name: "GLM-4.5",
    upstreamId: "0727-360B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "GLM-4.5-Thinking",
    name: "GLM-4.5-Thinking",
    upstreamId: "0727-360B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "GLM-4.5-Search",
    name: "GLM-4.5-Search",
    upstreamId: "0727-360B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: true,
      search: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "GLM-4.5-Air",
    name: "GLM-4.5-Air",
    upstreamId: "0727-106B-API",
    capabilities: {
      vision: false,
      mcp: true,
      thinking: false,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 80000,
    },
  },
  {
    id: "GLM-4-6-API-V1",
    name: "GLM-4.6",
    upstreamId: "GLM-4-6-API-V1",
    capabilities: {
      vision: true,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 195000,
    },
  },
  {
    id: "glm-4.5v",
    name: "GLM-4.5V",
    upstreamId: "glm-4.5v",
    capabilities: {
      vision: true,
      mcp: false,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.6,
      temperature: 0.8,
    },
  },
  {
    id: "glm-5",
    name: "GLM-5",
    upstreamId: "glm-5",
    capabilities: {
      vision: true,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 200000,
    },
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    upstreamId: "glm-4.7",
    capabilities: {
      vision: true,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 200000,
    },
  },
  {
    id: "GLM-4.7-Thinking",
    name: "GLM-4.7-Thinking",
    upstreamId: "glm-4.7",
    capabilities: {
      vision: true,
      mcp: true,
      thinking: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 200000,
    },
  },
  {
    id: "GLM-4.7-Search",
    name: "GLM-4.7-Search",
    upstreamId: "glm-4.7",
    capabilities: {
      vision: true,
      mcp: true,
      thinking: true,
      search: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 200000,
    },
  },
  {
    id: "GLM-4.7-advanced-search",
    name: "GLM-4.7-advanced-search",
    upstreamId: "glm-4.7",
    capabilities: {
      vision: true,
      mcp: true,
      thinking: true,
      search: true,
      advancedSearch: true,
    },
    defaultParams: {
      top_p: 0.95,
      temperature: 0.6,
      max_tokens: 200000,
    },
  },
];

// Default model
export const DEFAULT_MODEL = SUPPORTED_MODELS[0];

/**
 * Get model configuration by ID
 */
export function getModelConfig(modelId: string): ModelConfig {
  const normalizedModelId = normalizeModelId(modelId);
  const found = SUPPORTED_MODELS.find((m) => m.id === normalizedModelId);

  if (!found) {
    logger.warn(
      "Model config not found: %s (normalized: %s). Using default: %s",
      modelId,
      normalizedModelId,
      DEFAULT_MODEL.name,
    );
  }

  return found || DEFAULT_MODEL;
}

/**
 * Map model ID (handle special cases)
 */
export function mapModelId(modelId: string): string {
  const normalized = normalizeModelId(modelId);

  const modelMappings: Record<string, string> = {
    "glm-4-6": "GLM-4-6-API-V1",
  };

  const mapped = modelMappings[normalized];
  if (mapped) {
    logger.debug("Model ID mapping: %s → %s", modelId, mapped);
    return mapped;
  }

  return normalized;
}

/**
 * Advanced Model Capability Detector
 */
export class ModelCapabilityDetector {
  /**
   * Detect model's advanced capabilities
   */
  static detectCapabilities(modelId: string, reasoning?: boolean): ModelCapabilities {
    const normalizedModelId = modelId.toLowerCase();

    return {
      thinking: this.isThinkingModel(normalizedModelId, reasoning),
      search: this.isSearchModel(normalizedModelId),
      advancedSearch: this.isAdvancedSearchModel(normalizedModelId),
      vision: this.isVisionModel(normalizedModelId),
      mcp: this.supportsMCP(normalizedModelId),
    };
  }

  private static isThinkingModel(modelId: string, reasoning?: boolean): boolean {
    return modelId.includes("thinking") ||
      modelId.includes("4.6") ||
      reasoning === true ||
      modelId.includes("0727-360b-api");
  }

  private static isSearchModel(modelId: string): boolean {
    return modelId.includes("search") ||
      modelId.includes("web") ||
      modelId.includes("browser");
  }

  private static isAdvancedSearchModel(modelId: string): boolean {
    return modelId.includes("advanced-search") ||
      modelId.includes("advanced") ||
      modelId.includes("pro-search");
  }

  private static isVisionModel(modelId: string): boolean {
    return modelId.includes("4.5v") ||
      modelId.includes("vision") ||
      modelId.includes("image") ||
      modelId.includes("multimodal");
  }

  private static supportsMCP(modelId: string): boolean {
    // Most advanced models support MCP
    return this.isThinkingModel(modelId) ||
      this.isSearchModel(modelId) ||
      this.isAdvancedSearchModel(modelId);
  }

  /**
   * Get MCP servers for a model based on capabilities
   */
  static getMCPServersForModel(capabilities: ModelCapabilities): string[] {
    const servers: string[] = [];

    if (capabilities.advancedSearch) {
      servers.push("advanced-search");
      logger.debug("Detected advanced search model, adding advanced-search MCP server");
    } else if (capabilities.search) {
      servers.push("deep-web-search");
    }

    if (capabilities.mcp) {
      logger.debug("Model supports hidden MCP features: vibe-coding, ppt-maker, image-search, deep-research");
    }

    return servers;
  }

  /**
   * Get hidden MCP features list
   */
  static getHiddenMCPFeatures(): Array<{ type: string; server: string; status: string }> {
    return [
      { type: "mcp", server: "vibe-coding", status: "hidden" },
      { type: "mcp", server: "ppt-maker", status: "hidden" },
      { type: "mcp", server: "image-search", status: "hidden" },
      { type: "mcp", server: "deep-research", status: "hidden" },
      { type: "tool_selector", server: "tool_selector", status: "hidden" },
      { type: "mcp", server: "advanced-search", status: "hidden" },
    ];
  }
}
