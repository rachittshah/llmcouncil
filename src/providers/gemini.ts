import { GoogleGenAI } from "@google/genai";
import type { ProviderClient, ModelConfig, CompletionResult } from "../types.js";

export class GeminiProvider implements ProviderClient {
  readonly name = "gemini" as const;
  private client: GoogleGenAI | null = null;

  private getClient(): GoogleGenAI {
    if (!this.client) this.client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    return this.client;
  }

  isAvailable(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  async complete(prompt: string, config: ModelConfig): Promise<CompletionResult> {
    const start = Date.now();
    try {
      const response = await this.getClient().models.generateContent({
        model: config.model,
        contents: prompt,
        config: {
          maxOutputTokens: config.maxTokens ?? 4096,
          temperature: config.temperature ?? 0.7,
        },
      });

      const latencyMs = Date.now() - start;

      return {
        content: response.text ?? "",
        model: config.model,
        provider: this.name,
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs,
      };
    } catch (err) {
      throw new Error(
        `[gemini] ${config.model} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
