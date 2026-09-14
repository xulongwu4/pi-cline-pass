import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ModelCost } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const API_BASE_URL = "https://api.cline.bot/api/v1";
export const CATALOG_TIMEOUT_MS = 15_000;
const MODELS_URL = `${API_BASE_URL}/ai/cline/models`;
const RECOMMENDED_URL = `${API_BASE_URL}/ai/cline/recommended-models`;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
// Free-tier Cline client headers are applied per-request via the
// before_provider_headers hook (see headers.ts), not baked into models —
// the CLI version stays fresh without rebuilding the catalog.
export { buildFreeModelHeadersSync, getClineVersion, needsFreeModelHeaders } from "./headers.ts";

type ClinePassModel = Model<"openai-completions">;
type CatalogEntry = {
  id?: string;
  context_length?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  supported_parameters?: string[];
  architecture?: { modality?: string; input_modalities?: string[] };
};
type RecommendedEntry = { id?: string; name?: string };
type PassSeed = { id: string; name: string; cost: ModelCost };

// Cline's public ClinePass list is fetched at startup. These documented entries
// keep the subscription provider usable if catalog discovery is unavailable.
const PASS_FALLBACK: PassSeed[] = [
  ["glm-5.3", "GLM-5.3", 1.4, 4.4, 0.26, 0],
  ["glm-5.2", "GLM-5.2", 1.4, 4.4, 0.26, 0],
  ["kimi-k3", "Kimi K3", 3, 15, 0.3, 0],
  ["kimi-k2.7-code", "Kimi K2.7 Code", 0.95, 4, 0.19, 0],
  ["kimi-k2.6", "Kimi K2.6", 0.95, 4, 0.16, 0],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 0.66, 1.98, 0.022, 0],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 0.22, 0.66, 0.007, 0],
  ["mimo-v2.5", "MiMo-V2.5", 0.14, 0.28, 0.0028, 0],
  ["mimo-v2.5-pro", "MiMo-V2.5-Pro", 1.74, 3.48, 0.0145, 0],
  ["minimax-m3", "MiniMax M3", 0.3, 1.2, 0.06, 0],
  ["qwen3.8-max", "Qwen3.8 Max", 2, 6, 0.25, 2.5],
  ["qwen3.7-max", "Qwen3.7 Max", 2.5, 7.5, 0.5, 3.125],
  ["qwen3.7-plus", "Qwen3.7 Plus", 0.4, 1.6, 0.04, 0.5],
].map(([id, name, input, output, cacheRead, cacheWrite]) => ({
  id: `cline-pass/${id}`,
  name,
  cost: { input, output, cacheRead, cacheWrite },
})) as PassSeed[];

function modelFromCatalog(raw: CatalogEntry, seed: PassSeed): ClinePassModel {
  const parameters = raw.supported_parameters ?? [];
  const modalities = raw.architecture?.input_modalities ?? [];
  return {
    id: seed.id,
    name: seed.name,
    api: "openai-completions",
    provider: "cline-pass",
    baseUrl: API_BASE_URL,
    reasoning: parameters.includes("reasoning") || parameters.includes("include_reasoning"),
    input:
      modalities.includes("image") || raw.architecture?.modality?.includes("image")
        ? ["text", "image"]
        : ["text"],
    cost: seed.cost,
    contextWindow: raw.context_length || raw.top_provider?.context_length || 128_000,
    maxTokens: raw.top_provider?.max_completion_tokens || 8_192,
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
  };
}

function fallbackModel(seed: PassSeed): ClinePassModel {
  return {
    id: seed.id,
    name: seed.name,
    api: "openai-completions",
    provider: "cline-pass",
    baseUrl: API_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: seed.cost,
    contextWindow: 128_000,
    maxTokens: 8_192,
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
  };
}

function cachePath(agentDir: string): string {
  return join(agentDir, "cline-pass", "models.json");
}

function loadCachedModels(agentDir: string): ClinePassModel[] | undefined {
  try {
    const models = JSON.parse(readFileSync(cachePath(agentDir), "utf8")) as ClinePassModel[];
    if (
      !Array.isArray(models) ||
      models.length === 0 ||
      models.some(
        (model) =>
          typeof model?.id !== "string" ||
          typeof model?.name !== "string" ||
          model.provider !== "cline-pass" ||
          model.api !== "openai-completions" ||
          !Array.isArray(model.input) ||
          typeof model.contextWindow !== "number" ||
          typeof model.maxTokens !== "number",
      )
    ) {
      return undefined;
    }
    return models;
  } catch {
    return undefined;
  }
}

function writeCachedModels(models: ClinePassModel[], agentDir: string): void {
  try {
    const path = cachePath(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(models, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // A cache write failure must not hide a valid live catalog.
  }
}

export function getFallbackModels(agentDir = getAgentDir()): ClinePassModel[] {
  return loadCachedModels(agentDir) ?? PASS_FALLBACK.map(fallbackModel);
}

async function getJson<T>(fetcher: typeof fetch, url: string, signal?: AbortSignal): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

export async function refreshModelCatalog(
  fetcher: typeof fetch = fetch,
  agentDir = getAgentDir(),
  signal?: AbortSignal,
): Promise<ClinePassModel[] | undefined> {
  const fallback = getFallbackModels(agentDir);
  try {
    const [catalogResult, recommendedResult] = await Promise.allSettled([
      getJson<{ data?: CatalogEntry[] }>(fetcher, MODELS_URL, signal),
      getJson<{ clinePass?: RecommendedEntry[]; free?: RecommendedEntry[] }>(fetcher, RECOMMENDED_URL, signal),
    ]);
    const catalog = catalogResult.status === "fulfilled" ? catalogResult.value.data ?? [] : [];
    const recommended = recommendedResult.status === "fulfilled" ? recommendedResult.value : {};
    const bySlug = new Map(
      catalog
        .filter(
          (entry): entry is CatalogEntry & { id: string } =>
            Boolean(entry.id) && (entry.supported_parameters ?? []).includes("tools"),
        )
        .map((entry) => [entry.id.split("/").at(-1), entry]),
    );
    const seeds = [
      ...new Map(
        [...(recommended.clinePass ?? []), ...(recommended.free ?? [])].flatMap((entry) => {
          if (!entry.id) return [];
          const seed = PASS_FALLBACK.find((model) => model.id === entry.id);
          return [[entry.id, {
            id: entry.id,
            name: entry.name ?? seed?.name ?? entry.id,
            cost: seed?.cost ?? ZERO_COST,
          }] as const];
        }),
      ).values(),
    ];
    if (seeds.length === 0) return fallback;

    const models = seeds.map((seed) => {
      const match = bySlug.get(seed.id.split("/").at(-1));
      return match ? modelFromCatalog(match, seed) : fallbackModel(seed);
    });
    writeCachedModels(models, agentDir);
    return models;
  } catch {
    return undefined;
  }
}

export async function loadModels(
  fetcher: typeof fetch = fetch,
  agentDir = getAgentDir(),
  signal?: AbortSignal,
): Promise<ClinePassModel[]> {
  return (await refreshModelCatalog(fetcher, agentDir, signal)) ?? getFallbackModels(agentDir);
}
