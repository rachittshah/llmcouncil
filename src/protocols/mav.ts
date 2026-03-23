import type { ModelConfig, ModelResponse } from "../types.js";
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

interface VerificationResult {
  verdict: boolean;
  aspect: string;
  reasoning: string;
}

function buildVerificationPrompt(
  question: string,
  candidate: ModelResponse,
  anonymize: boolean
): string {
  const name = anonymize
    ? candidate.label
    : `${candidate.provider}/${candidate.model}`;

  return `You are a verification agent. Evaluate whether the following response correctly answers the question.

**Question:** ${question}

**Response from ${name}:**
${candidate.content}

Is this response correct, complete, and well reasoned? Reply with ONLY valid JSON (no markdown fences):
{ "verdict": true, "aspect": "correctness", "reasoning": "..." }

Set "verdict" to true if the response is substantially correct, false otherwise. The "aspect" field should name what you primarily evaluated (e.g., "correctness", "completeness", "reasoning"). The "reasoning" field should explain your judgment.`;
}

function parseVerdict(content: string): VerificationResult {
  try {
    const cleaned = content
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    return JSON.parse(cleaned) as VerificationResult;
  } catch {
    // If parsing fails, try to infer verdict from content
    const lower = content.toLowerCase();
    const verdict =
      lower.includes('"verdict": true') ||
      lower.includes('"verdict":true');
    return {
      verdict,
      aspect: "correctness",
      reasoning: `Parse fallback: ${content.slice(0, 200)}`,
    };
  }
}

export async function runMAV(
  question: string,
  candidates: ModelResponse[],
  verifiers: ModelConfig[],
  anonymize: boolean = false
): Promise<{ verified: ModelResponse; scores: Record<string, number> }> {
  // For each candidate, ask each verifier to evaluate
  const verificationTasks: Array<{
    candidateLabel: string;
    verifierConfig: ModelConfig;
    prompt: string;
  }> = [];

  for (const candidate of candidates) {
    for (const verifier of verifiers) {
      verificationTasks.push({
        candidateLabel: candidate.label,
        verifierConfig: verifier,
        prompt: buildVerificationPrompt(question, candidate, anonymize),
      });
    }
  }

  // Run all verifications in parallel
  const results = await Promise.all(
    verificationTasks.map(async (task) => {
      const response = await queryModel(task.verifierConfig, task.prompt);
      const verdict = parseVerdict(response.content);
      return {
        candidateLabel: task.candidateLabel,
        verdict,
      };
    })
  );

  // Tally scores
  const scores: Record<string, number> = {};
  for (const candidate of candidates) {
    scores[candidate.label] = 0;
  }
  for (const result of results) {
    if (result.verdict.verdict) {
      scores[result.candidateLabel] =
        (scores[result.candidateLabel] ?? 0) + 1;
    }
  }

  // Find the candidate with the highest score
  let bestLabel = candidates[0].label;
  let bestScore = -1;
  for (const [label, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }

  const verified = candidates.find((c) => c.label === bestLabel)!;

  return { verified, scores };
}
