const llm = require("./llm");
const { buildSystemPrompt, buildUserPrompt } = require("./prompt");
const { loadConfig } = require("./config");

async function decide(rankedCandidates, config) {
  const eligibleTimings = config.decision.eligibleTimings;
  const maxN = config.decision.maxCandidatesToLLM || 5;

  const eligible = rankedCandidates
    .filter((c) => eligibleTimings.includes(c.timing?.signal))
    .slice(0, maxN);

  if (eligible.length === 0) {
    const reason = `no eligible candidates (eligible timings: ${eligibleTimings.join(", ")})`;
    return { called: false, pick: null, reason, eligibleCount: 0 };
  }

  const enableLlm = process.env.ENABLE_LLM;
  const hasKey = process.env.LLM_API_KEY || process.env.LLM_API_KEYS;
  if (enableLlm !== "true" || !hasKey) {
    const reason = `LLM disabled or no key (ENABLE_LLM=${enableLlm}, hasKey=${!!hasKey})`;
    console.log(`LLM: not called — ${reason}`);
    return { called: false, pick: null, reason, eligibleCount: eligible.length };
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(eligible);

  try {
    const raw = await llm.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.1, maxTokens: 512 }
    );

    const parsed = _parseResponse(raw, eligible);
    const result = {
      called: true,
      pick: parsed.pick,
      confidence: parsed.confidence,
      reason: parsed.reason,
      rejected: parsed.rejected,
      eligibleCount: eligible.length,
      raw,
    };

    // log decision
    if (result.pick) {
      const picked = eligible.find((c) => c.mint === result.pick);
      console.log(
        `LLM decision: WOULD BUY ${picked?.symbol || result.pick} (conf ${result.confidence}) — ${result.reason}`
      );
    } else {
      console.log(`LLM decision: NO BUY — ${result.reason}`);
    }
    if (result.rejected && result.rejected.length > 0) {
      for (const r of result.rejected) {
        console.log(`  rejected ${r.mint}: ${r.why}`);
      }
    }

    return result;
  } catch (err) {
    console.log(`LLM decision error: ${err.message}`);
    return {
      called: true,
      pick: null,
      reason: `LLM call failed: ${err.message}`,
      eligibleCount: eligible.length,
    };
  }
}

function _parseResponse(raw, eligible) {
  let cleaned = raw.trim();
  // strip markdown code fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.log(`LLM: failed to parse JSON response, treating as NO BUY`);
    return { pick: null, confidence: 0, reason: "unparseable LLM response", rejected: [] };
  }

  const validMints = new Set(eligible.map((c) => c.mint));
  let pick = parsed.pick || null;

  // anti-hallucination: pick must be null or exactly one of eligible mints
  if (pick !== null && !validMints.has(pick)) {
    console.log(`LLM: hallucination — pick "${pick}" not in candidate list, coercing to null`);
    pick = null;
  }

  const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;

  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  const rejected = Array.isArray(parsed.rejected) ? parsed.rejected : [];

  return { pick, confidence, reason, rejected };
}

module.exports = { decide };
