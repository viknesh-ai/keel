import { beforeAll, describe } from "vitest";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { type ContractTarget, contractSuite } from "./contract.js";

/**
 * The same contract suite against Anthropic, with only config changed.
 *
 * Skipped without a key. That is a real gap and worth naming: this half of the
 * exit criterion has not been executed here, because the repository has no
 * Anthropic credential. Set ANTHROPIC_API_KEY and it runs.
 */

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

describe.skipIf(API_KEY === "")("Anthropic adapter", () => {
  let target: ContractTarget;

  beforeAll(() => {
    target = {
      provider: new AnthropicProvider({ apiKey: API_KEY, timeoutMs: 120_000 }),
      model: MODEL,
      local: false,
      supportsTools: true,
    };
  });

  contractSuite(() => target);
});
