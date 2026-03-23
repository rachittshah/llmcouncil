import Anthropic from "@anthropic-ai/sdk";
import type { ProviderClient, ModelConfig, CompletionResult } from "../types.js";

export class AnthropicProvider implements ProviderClient {
  readonly name = "anthropic" as const;
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  async complete(prompt: string, config: ModelConfig): Promise<CompletionResult> {
    const start = Date.now();
    try {
      const response = await this.getClient().messages.create({
        model: config.model,
        max_tokens: config.maxTokens ?? 4096,
        temperature: config.temperature ?? 0.7,
        messages: [{ role: "user", content: prompt }],
      });

      const latencyMs = Date.now() - start;
      const textBlock = response.content.find((block) => block.type === "text");
      const content = textBlock?.type === "text" ? textBlock.text : "";

      return {
        content,
        model: config.model,
        provider: this.name,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        latencyMs,
      };
    } catch (err) {
      throw new Error(
        `[anthropic] ${config.model} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
