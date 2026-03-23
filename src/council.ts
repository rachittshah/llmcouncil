import type {
  CouncilRequest,
  CouncilResult,
  ModelConfig,
  ModelResponse,
} from "./types.js";
import { DEFAULT_CHAIRMAN } from "./types.js";
import { getProvider } from "./providers/index.js";
import { CostTracker } from "./cost.js";
import { runVote } from "./protocols/vote.js";
import { runDebate } from "./protocols/debate.js";
import { runSynthesis } from "./protocols/synthesize.js";
import { runCritique } from "./protocols/critique.js";
import { runMAV } from "./protocols/mav.js";

async function queryModel(
  config: ModelConfig,
  prompt: string,
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

async function queryAllModels(
  models: ModelConfig[],
  prompt: string,
): Promise<ModelResponse[]> {
  return Promise.all(models.map(m => queryModel(m, prompt)));
}

export async function runCouncil(request: CouncilRequest): Promise<CouncilResult> {
  const startTime = Date.now();
  const tracker = new CostTracker();
  const { config } = request;
  const { models, protocol, anonymize = true } = config;
  const chairman = config.chairman ?? DEFAULT_CHAIRMAN;

  const question = request.context
    ? `Context: ${request.context}\n\nQuestion: ${request.question}`
    : request.question;

  const result: CouncilResult = {
    protocol,
    question: request.question,
    responses: [],
    cost: { totalUsd: 0, byModel: {} },
    metadata: {
      totalLatencyMs: 0,
      modelsUsed: models.map(m => m.label ?? `${m.provider}/${m.model}`),
    },
  };

  switch (protocol) {
    case "vote": {
      const { responses, votes } = await runVote(question, models, anonymize);
      tracker.trackResponses(responses);

      // Derive consensus: model with the most #1 votes wins
      const firstPlaceCounts = new Map<string, number>();
      for (const vote of votes) {
        if (vote.rankings.length > 0) {
          const top = vote.rankings[0];
          firstPlaceCounts.set(top, (firstPlaceCounts.get(top) ?? 0) + 1);
        }
      }

      let winnerLabel = responses[0]?.label ?? "";
      let maxVotes = 0;
      for (const [label, count] of firstPlaceCounts) {
        if (count > maxVotes) {
          maxVotes = count;
          winnerLabel = label;
        }
      }

      const winnerResponse = responses.find(r => r.label === winnerLabel);
      const totalVoters = votes.filter(v => v.rankings.length > 0).length;
      const dissenters = votes
        .filter(v => v.rankings.length > 0 && v.rankings[0] !== winnerLabel)
        .map(v => v.voter);

      result.responses = responses;
      result.votes = votes;
      result.synthesis = winnerResponse?.content;
      result.consensus = {
        answer: winnerResponse?.content ?? "",
        confidence: totalVoters > 0 ? maxVotes / totalVoters : 0,
        dissent: dissenters,
      };
      break;
    }

    case "debate": {
      const debateResult = await runDebate(question, config);
      result.debateRounds = debateResult.rounds;

      for (const round of debateResult.rounds) {
        tracker.trackResponses(round.responses);
      }

      result.responses = debateResult.rounds[0]?.responses ?? [];

      // Synthesize final round via chairman
      const finalRound = debateResult.rounds[debateResult.rounds.length - 1];
      if (finalRound) {
        const synthesis = await runSynthesis(
          question,
          finalRound.responses,
          chairman,
          anonymize,
        );
        result.synthesis = synthesis;
        result.consensus = {
          answer: synthesis,
          confidence: 0.8, // debate synthesis confidence
          dissent: [],
        };
      }

      result.metadata.stoppedEarly = debateResult.rounds.some(r => r.converged === true);
      break;
    }

    case "synthesize": {
      const responses = await queryAllModels(models, question);
      tracker.trackResponses(responses);

      const synthesis = await runSynthesis(question, responses, chairman, anonymize);

      result.responses = responses;
      result.synthesis = synthesis;
      result.consensus = {
        answer: synthesis,
        confidence: 0.85, // multi model synthesis confidence
        dissent: [],
      };
      break;
    }

    case "critique":
    case "redteam": {
      const responses = await queryAllModels(models, question);
      tracker.trackResponses(responses);

      // runCritique takes (question, responses, config) and returns { critiques, redTeam? }
      const critiqueResult = await runCritique(question, responses, config);
      tracker.trackResponses(critiqueResult.critiques);
      if (critiqueResult.redTeam) {
        tracker.trackResponses(critiqueResult.redTeam);
      }

      result.responses = responses;
      result.critique = critiqueResult.critiques.map(c => c.content).join("\n\n===\n\n");
      if (critiqueResult.redTeam) {
        result.critique += "\n\n=== RED TEAM ===\n\n" +
          critiqueResult.redTeam.map(r => r.content).join("\n\n===\n\n");
      }
      break;
    }

    case "mav": {
      const candidateResponses = await queryAllModels(models, question);
      tracker.trackResponses(candidateResponses);

      // runMAV returns { verified: ModelResponse, scores: Record<string, number> }
      const mavResult = await runMAV(question, candidateResponses, models, anonymize);

      result.responses = candidateResponses;
      const maxScore = Math.max(...Object.values(mavResult.scores), 1);
      result.consensus = {
        answer: mavResult.verified.content,
        confidence: mavResult.scores[mavResult.verified.label] / maxScore,
        dissent: Object.entries(mavResult.scores)
          .filter(([label]) => label !== mavResult.verified.label)
          .map(([label, score]) => `${label}: ${score}/${maxScore}`),
      };
      result.synthesis = mavResult.verified.content;
      break;
    }
  }

  result.cost = tracker.getBreakdown();
  result.metadata.totalLatencyMs = Date.now() - startTime;

  return result;
}
