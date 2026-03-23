import type { CouncilConfig, ModelConfig, ModelResponse } from "../types.js";
import { getProvider } from "../providers/index.js";

async function queryModel(
  config: ModelConfig,
  prompt: string
): Promise<ModelResponse> {
  const provider = getProvider(config.provider);
  const result = await provider.complete(prompt, config);
  return {
    label: config.label ?? `${config.provider}/${config.model}`,
    provider: result.provider,
    model: result.model,
    content: result.content,
    tokens: { input: result.inputTokens, output: result.outputTokens },
    latencyMs: result.latencyMs,
  };
}

function buildCritiquePrompt(
  question: string,
  responses: ModelResponse[],
  criticLabel: string,
  anonymize: boolean
): string {
  const responseList = responses
    .filter((r) => r.label !== criticLabel)
    .map((r) => {
      const name = anonymize ? r.label : `${r.provider}/${r.model}`;
      return `### ${name}\n${r.content}`;
    })
    .join("\n\n");

  return `You are a critical reviewer. Evaluate each of the following responses to the question below.

**Question:** ${question}

**Responses:**

${responseList}

For each response, provide structured feedback:
* **Strengths**: What the response does well
* **Weaknesses**: Where it falls short
* **Errors**: Any factual or logical errors
* **Confidence**: Your confidence in the response's correctness (0-100%)

Be thorough and specific.`;
}

function buildRedTeamPrompt(
  question: string,
  responses: ModelResponse[],
  attackerLabel: string,
  anonymize: boolean
): string {
  const responseList = responses
    .filter((r) => r.label !== attackerLabel)
    .map((r) => {
      const name = anonymize ? r.label : `${r.provider}/${r.model}`;
      return `### ${name}\n${r.content}`;
    })
    .join("\n\n");

  return `You are a red team adversary. Your job is to stress test the following responses by finding flaws, edge cases, adversarial inputs, or failure modes.

**Question:** ${question}

**Responses:**

${responseList}

For each response, identify:
* **Flaws**: Logical errors, unsupported claims, or incorrect reasoning
* **Edge Cases**: Scenarios where the response would fail or produce wrong results
* **Adversarial Inputs**: Inputs that could exploit weaknesses in the approach
* **Failure Modes**: How and when the response would break down

Be aggressive and creative in finding problems.`;
}

export async function runCritique(
  question: string,
  responses: ModelResponse[],
  config: CouncilConfig
): Promise<{ critiques: ModelResponse[]; redTeam?: ModelResponse[] }> {
  const anonymize = config.anonymize ?? false;
  const isRedTeam = config.protocol === "redteam";

  // Standard critique pass
  const critiquePromises = config.models.map((m) => {
    const label = m.label ?? `${m.provider}/${m.model}`;
    const prompt = buildCritiquePrompt(question, responses, label, anonymize);
    return queryModel(m, prompt);
  });

  const critiques = await Promise.all(critiquePromises);

  // Red team pass (if protocol is redteam)
  if (isRedTeam) {
    const redTeamPromises = config.models.map((m) => {
      const label = m.label ?? `${m.provider}/${m.model}`;
      const prompt = buildRedTeamPrompt(question, responses, label, anonymize);
      return queryModel(m, prompt);
    });

    const redTeam = await Promise.all(redTeamPromises);
    return { critiques, redTeam };
  }

  return { critiques };
}
