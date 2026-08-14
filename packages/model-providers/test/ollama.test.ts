import { beforeAll, describe } from "vitest";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible.js";
import { type ContractTarget, contractSuite } from "./contract.js";

/**
 * The contract suite against a real local Ollama, through the *generic*
 * OpenAI-compatible adapter with no Ollama-specific code anywhere.
 *
 * Skipped when nothing is listening, so a contributor without Ollama still gets
 * a green suite — but it is wired into CI, so "it works locally" is not the
 * only evidence.
 */

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:0.5b";

async function ollamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(BASE_URL.replace(/\/v1$/, "/api/tags"), {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await ollamaAvailable();

describe.skipIf(!available)("OpenAI-compatible adapter against local Ollama", () => {
  let target: ContractTarget;

  beforeAll(() => {
    target = {
      provider: new OpenAiCompatibleProvider({
        id: "local",
        baseUrl: BASE_URL,
        timeoutMs: 120_000,
      }),
      model: MODEL,
      local: true,
      supportsTools: true,
    };
  });

  contractSuite(() => target);
});
