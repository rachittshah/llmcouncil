---
name: council
description: Consult a multi-LLM council for deliberation, debate, voting, critique, or verification. Uses GPT-5, Gemini 2.5, and Claude as peers.
user_invocable: true
---

# LLM Council Skill

You have access to the LLM Council MCP tools. Use them to orchestrate multi-model deliberation.

## Available Tools

1. **council_deliberate** — Full council deliberation with configurable protocol
2. **council_vote** — Quick voting: all models answer, then anonymously rank each other
3. **council_debate** — Structured debate with adaptive stopping
4. **council_critique** — Peer critique or adversarial red-teaming
5. **council_verify** — Multi-agent verification of an answer
6. **council_estimate_cost** — Estimate cost before running
7. **council_status** — Check which providers are available
8. **council_configure** — Update default council composition

## Usage Patterns

### Quick consensus
Use `council_vote` for straightforward questions where you want the best answer selected by peer review.

### Deep analysis
Use `council_debate` with `adaptiveStop: true` for complex questions that benefit from iterative refinement. Set `maxRounds: 3` for thorough analysis.

### Verification
Use `council_verify` to check if an answer is correct by having multiple models independently verify it.

### Stress testing
Use `council_critique` with `redTeam: true` to find flaws, edge cases, and failure modes in responses.

### Full deliberation
Use `council_deliberate` with `protocol: "synthesize"` for the chairman synthesis pattern — all models answer, then a chairman produces an authoritative synthesis.

## Best Practices (from research)
- Scale agents (more models), not rounds (more debate turns)
- Heterogeneous models (mix providers) outperform homogeneous ones
- Anonymous peer review prevents model favoritism bias
- Always check cost estimate before large council runs
- Default council (GPT-5 + Gemini 2.5 Pro + Claude Sonnet 4.6) provides optimal diversity

## Example Invocations

User: "What are the tradeoffs of microservices vs monolith?"
→ Use council_vote for quick consensus

User: "Is this algorithm correct? [code]"
→ Use council_verify

User: "Debate whether Rust or Go is better for this use case"
→ Use council_debate with maxRounds: 2

User: "Red team this API design"
→ Use council_critique with redTeam: true
