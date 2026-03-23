import type { ProviderName, ProviderClient } from "../types.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";
import { AnthropicProvider } from "./anthropic.js";

const providers = new Map<ProviderName, ProviderClient>();

function ensureProvider(name: ProviderName): ProviderClient {
  let provider = providers.get(name);
  if (provider) return provider;

  switch (name) {
    case "openai":
      provider = new OpenAIProvider();
      break;
    case "gemini":
      provider = new GeminiProvider();
      break;
    case "anthropic":
      provider = new AnthropicProvider();
      break;
    default:
      throw new Error(`Unknown provider: ${name as string}`);
  }

  providers.set(name, provider);
  return provider;
}

export function getProvider(name: ProviderName): ProviderClient {
  const provider = ensureProvider(name);
  if (!provider.isAvailable()) {
    throw new Error(
      `Provider "${name}" is not available — missing API key`
    );
  }
  return provider;
}

export function getAvailableProviders(): ProviderClient[] {
  const names: ProviderName[] = ["openai", "gemini", "anthropic"];
  return names.map(ensureProvider).filter((p) => p.isAvailable());
}

export function getAllProviders(): Map<ProviderName, ProviderClient> {
  const names: ProviderName[] = ["openai", "gemini", "anthropic"];
  for (const name of names) ensureProvider(name);
  return new Map(providers);
}
