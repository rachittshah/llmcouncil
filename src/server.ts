import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ModelConfig, Protocol, CouncilConfig } from "./types.js";
import { DEFAULT_MODELS, DEFAULT_CHAIRMAN, PRICING } from "./types.js";
import { runCouncil } from "./council.js";
import { CostTracker } from "./cost.js";
// providers are checked directly via env vars in council_status

// Module level config override (set via council_configure)

let configOverride: {
  models?: ModelConfig[];
  chairman?: ModelConfig;
  defaultProtocol?: Protocol;
} = {};

// Helpers

function ok(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

function err(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function resolveModels(models?: ModelConfig[]): ModelConfig[] {
  return models ?? configOverride.models ?? DEFAULT_MODELS;
}

function resolveChairman(chairman?: { provider: string; model: string }): ModelConfig {
  if (chairman) return { provider: chairman.provider as ModelConfig["provider"], model: chairman.model, label: "Chairman" };
  return configOverride.chairman ?? DEFAULT_CHAIRMAN;
}

// Model input schema (reused across tools)

const modelsSchema = {
  type: "array",
  description: "Models to include in the council. Defaults to GPT 5.4, Gemini 2.5 Pro, Claude Sonnet 4.6.",
  items: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["openai", "gemini", "anthropic"], description: "LLM provider" },
      model: { type: "string", description: "Model identifier (e.g. gpt-5, gemini-2.5-pro, claude-sonnet-4-6-20250514)" },
      label: { type: "string", description: "Anonymous label for peer review (e.g. ModelA)" },
    },
    required: ["provider", "model"],
  },
} as const;

// Server setup

const server = new Server(
  { name: "llmcouncil", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Tool definitions

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "council_deliberate",
      description:
        "Run a multi LLM council deliberation. Sends the same question to multiple frontier models and combines their responses using a chosen protocol (synthesize, vote, debate, critique, redteam, or MAV verification). Returns responses, synthesis/consensus, cost breakdown, and latency.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question or task for the council to deliberate on" },
          context: { type: "string", description: "Optional background context provided to all models before the question" },
          protocol: {
            type: "string",
            enum: ["vote", "debate", "synthesize", "critique", "redteam", "mav"],
            description: "Deliberation protocol. synthesize: chairman merges responses. vote: models rank each other. debate: multi round argumentation. critique: peer review. redteam: adversarial critique. mav: model as verifier cross check.",
          },
          models: modelsSchema,
          chairman: {
            type: "object",
            description: "Model used to synthesize final output. Defaults to Claude Sonnet 4.6.",
            properties: {
              provider: { type: "string", description: "Provider name" },
              model: { type: "string", description: "Model identifier" },
            },
            required: ["provider", "model"],
          },
          maxRounds: { type: "number", description: "Maximum debate rounds (debate protocol only, default: 1)" },
          anonymize: { type: "boolean", description: "Hide model identities during peer review (default: true)" },
          adaptiveStop: { type: "boolean", description: "Enable KS statistic early stopping for debate (default: false)" },
        },
        required: ["question"],
      },
    },
    {
      name: "council_vote",
      description:
        "Quick voting: each model answers, then all models rank each other's responses. Returns the winner by first place votes with confidence score and dissent list.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to vote on" },
          context: { type: "string", description: "Optional background context" },
          models: modelsSchema,
        },
        required: ["question"],
      },
    },
    {
      name: "council_debate",
      description:
        "Multi round debate: models argue in rounds, optionally stopping early when responses converge (KS statistic). Chairman synthesizes the final round into a consensus answer.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The debate topic or question" },
          context: { type: "string", description: "Optional background context" },
          models: modelsSchema,
          maxRounds: { type: "number", description: "Maximum debate rounds (default: 1)" },
          adaptiveStop: { type: "boolean", description: "Stop early when responses converge (default: false)" },
        },
        required: ["question"],
      },
    },
    {
      name: "council_critique",
      description:
        "Peer critique: models answer, then critique each other's responses. Set redTeam=true for adversarial redteaming that actively tries to find flaws, hallucinations, and failure modes.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to critique responses for" },
          context: { type: "string", description: "Optional background context" },
          redTeam: { type: "boolean", description: "Use adversarial redteam protocol instead of standard critique (default: false)" },
        },
        required: ["question"],
      },
    },
    {
      name: "council_verify",
      description:
        "MAV (Model as Verifier): cross checks an answer using multiple models. Each model scores the candidate answer, and the highest scored response becomes the verified output. Use this to fact check or validate an existing answer.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The original question" },
          answer: { type: "string", description: "The candidate answer to verify" },
        },
        required: ["question", "answer"],
      },
    },
    {
      name: "council_estimate_cost",
      description:
        "Estimate the USD cost of a council run before executing it. Returns per model and total cost estimates based on token counts and current pricing.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", description: "Protocol to estimate for" },
          models: modelsSchema,
          avgInputTokens: { type: "number", description: "Estimated input tokens per model call (default: 1000)" },
          avgOutputTokens: { type: "number", description: "Estimated output tokens per model call (default: 500)" },
          rounds: { type: "number", description: "Number of rounds (for debate, default: 1)" },
        },
        required: ["protocol"],
      },
    },
    {
      name: "council_status",
      description:
        "Check which LLM providers have API keys configured and list available models with their pricing. Use this to verify the council is ready before running a deliberation.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "council_configure",
      description:
        "Update the default council configuration for this session. Changes persist until the server restarts. Use this to set preferred models, chairman, or default protocol without passing them on every call.",
      inputSchema: {
        type: "object",
        properties: {
          models: modelsSchema,
          chairman: {
            type: "object",
            properties: {
              provider: { type: "string", description: "Provider name" },
              model: { type: "string", description: "Model identifier" },
            },
            required: ["provider", "model"],
          },
          defaultProtocol: {
            type: "string",
            enum: ["vote", "debate", "synthesize", "critique", "redteam", "mav"],
            description: "Default protocol for council_deliberate calls",
          },
        },
      },
    },
  ],
}));

// Tool dispatch

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // council_deliberate
      case "council_deliberate": {
        const a = args as {
          question: string;
          context?: string;
          protocol?: Protocol;
          models?: ModelConfig[];
          chairman?: { provider: string; model: string };
          maxRounds?: number;
          anonymize?: boolean;
          adaptiveStop?: boolean;
        };

        const config: CouncilConfig = {
          models: resolveModels(a.models),
          protocol: a.protocol ?? configOverride.defaultProtocol ?? "synthesize",
          chairman: resolveChairman(a.chairman),
          maxRounds: a.maxRounds,
          anonymize: a.anonymize ?? true,
          adaptiveStop: a.adaptiveStop,
        };

        const result = await runCouncil({ question: a.question, context: a.context, config });
        return ok(result);
      }

      // council_vote
      case "council_vote": {
        const a = args as { question: string; context?: string; models?: ModelConfig[] };

        const config: CouncilConfig = {
          models: resolveModels(a.models),
          protocol: "vote",
          anonymize: true,
        };

        const result = await runCouncil({ question: a.question, context: a.context, config });
        return ok(result);
      }

      // council_debate
      case "council_debate": {
        const a = args as {
          question: string;
          context?: string;
          models?: ModelConfig[];
          maxRounds?: number;
          adaptiveStop?: boolean;
        };

        const config: CouncilConfig = {
          models: resolveModels(a.models),
          protocol: "debate",
          chairman: resolveChairman(),
          maxRounds: a.maxRounds,
          anonymize: true,
          adaptiveStop: a.adaptiveStop,
        };

        const result = await runCouncil({ question: a.question, context: a.context, config });
        return ok(result);
      }

      // council_critique
      case "council_critique": {
        const a = args as { question: string; context?: string; redTeam?: boolean };

        const config: CouncilConfig = {
          models: resolveModels(),
          protocol: a.redTeam ? "redteam" : "critique",
          anonymize: true,
        };

        const result = await runCouncil({ question: a.question, context: a.context, config });
        return ok(result);
      }

      // council_verify
      case "council_verify": {
        const a = args as { question: string; answer: string };

        // Synthesize a candidate response that includes the answer to verify
        const verifyQuestion = `Verify this answer:\n\nQuestion: ${a.question}\n\nCandidate Answer: ${a.answer}`;

        const config: CouncilConfig = {
          models: resolveModels(),
          protocol: "mav",
          anonymize: true,
        };

        const result = await runCouncil({ question: verifyQuestion, config });
        return ok(result);
      }

      // council_estimate_cost
      case "council_estimate_cost": {
        const a = args as {
          protocol: string;
          models?: ModelConfig[];
          avgInputTokens?: number;
          avgOutputTokens?: number;
          rounds?: number;
        };

        const models = resolveModels(a.models);
        const avgInput = a.avgInputTokens ?? 1000;
        const avgOutput = a.avgOutputTokens ?? 500;
        const rounds = a.rounds ?? 1;

        const tracker = new CostTracker();
        const estimatedTotal = tracker.estimateCost(models, avgInput, avgOutput, rounds);

        // Build per model breakdown
        const perModel = models.map((m) => {
          const pricing = PRICING[m.model] ?? { inputPer1M: 2.0, outputPer1M: 10.0 };
          const costPerRound =
            (avgInput / 1_000_000) * pricing.inputPer1M +
            (avgOutput / 1_000_000) * pricing.outputPer1M;
          return {
            model: m.model,
            provider: m.provider,
            costPerRound: +costPerRound.toFixed(6),
            totalCost: +(costPerRound * rounds).toFixed(6),
          };
        });

        // Protocol multipliers (rough: vote adds N peer calls, debate multiplies by rounds)
        let protocolMultiplier = 1;
        if (a.protocol === "vote") protocolMultiplier = 2; // answer + voting round
        if (a.protocol === "debate") protocolMultiplier = rounds;
        if (a.protocol === "critique" || a.protocol === "redteam") protocolMultiplier = 2;
        if (a.protocol === "mav") protocolMultiplier = 2; // answer + verification

        return ok({
          protocol: a.protocol,
          models: perModel,
          rounds,
          avgInputTokens: avgInput,
          avgOutputTokens: avgOutput,
          estimatedCostUsd: +(estimatedTotal * protocolMultiplier).toFixed(4),
          note: "Estimate only. Actual cost depends on prompt length and response verbosity.",
        });
      }

      // council_status
      case "council_status": {
        const providerModels: Record<string, string[]> = {
          openai: Object.keys(PRICING).filter((k) => k.startsWith("gpt") || k.startsWith("o3") || k.startsWith("o4")),
          gemini: Object.keys(PRICING).filter((k) => k.startsWith("gemini")),
          anthropic: Object.keys(PRICING).filter((k) => k.startsWith("claude")),
        };

        const providers: Record<string, { available: boolean; models: string[] }> = {
          openai: { available: !!process.env.OPENAI_API_KEY, models: providerModels.openai },
          gemini: { available: !!process.env.GEMINI_API_KEY, models: providerModels.gemini },
          anthropic: { available: !!process.env.ANTHROPIC_API_KEY, models: providerModels.anthropic },
        };

        return ok({
          providers,
          currentConfig: {
            models: configOverride.models ?? "default (GPT 5.4, Gemini 2.5 Pro, Claude Sonnet 4.6)",
            chairman: configOverride.chairman ?? "default (Claude Sonnet 4.6)",
            defaultProtocol: configOverride.defaultProtocol ?? "synthesize",
          },
          pricing: PRICING,
        });
      }

      // council_configure
      case "council_configure": {
        const a = args as {
          models?: ModelConfig[];
          chairman?: { provider: string; model: string };
          defaultProtocol?: string;
        };

        if (a.models) configOverride.models = a.models;
        if (a.chairman) {
          configOverride.chairman = {
            provider: a.chairman.provider as ModelConfig["provider"],
            model: a.chairman.model,
            label: "Chairman",
          };
        }
        if (a.defaultProtocol) configOverride.defaultProtocol = a.defaultProtocol as Protocol;

        return ok({
          message: "Configuration updated",
          current: {
            models: configOverride.models?.map((m) => `${m.provider}/${m.model}`) ?? "default",
            chairman: configOverride.chairman ? `${configOverride.chairman.provider}/${configOverride.chairman.model}` : "default",
            defaultProtocol: configOverride.defaultProtocol ?? "synthesize",
          },
        });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return err(error);
  }
});

// Start

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
