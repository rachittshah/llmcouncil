import OpenAI from "openai";
import type { ProviderClient, ModelConfig, CompletionResult } from "../types.js";

export class OpenAIProvider implements ProviderClient {
  readonly name = "openai" as const;
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) this.client = new OpenAI();
    return this.client;
  }

  isAvailable(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  async complete(prompt: string, config: ModelConfig): Promise<CompletionResult> {
    const start = Date.now();
    try {
      const response = await this.getClient().chat.completions.create({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        messages: [{ role: "user", content: prompt }],
      });

      const latencyMs = Date.now() - start;
      const content = response.choices[0]?.message?.content ?? "";

      return {
        content,
        model: config.model,
        provider: this.name,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    } catch (err) {
      throw new Error(
        `[openai] ${config.model} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
