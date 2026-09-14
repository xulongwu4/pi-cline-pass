import {
  createProvider,
  envApiKeyAuth,
  openAICompletionsApi,
  type Provider,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API_BASE_URL, getFallbackModels, loadModels } from "./models.ts";

export function createClinePassProvider(
  fetcher: typeof fetch = fetch,
  agentDir?: string,
): Provider<"openai-completions"> {
  return createProvider({
    id: "cline-pass",
    name: "ClinePass",
    baseUrl: API_BASE_URL,
    auth: { apiKey: envApiKeyAuth("Cline API key", ["CLINE_API_KEY"]) },
    models: getFallbackModels(agentDir),
    async fetchModels(context) {
      return loadModels(fetcher, agentDir, context.signal);
    },
    api: openAICompletionsApi(),
  });
}

export function registerClinePassProvider(
  pi: { registerProvider(provider: Provider): void },
  fetcher: typeof fetch = fetch,
  agentDir?: string,
): void {
  pi.registerProvider(createClinePassProvider(fetcher, agentDir));
}

export default function clinePassExtension(pi: ExtensionAPI): void {
  registerClinePassProvider(pi);

  pi.on("session_start", (_event, ctx) => {
    void ctx.modelRegistry.refresh({ providers: ["cline-pass"] }).then((result) => {
      for (const [provider, error] of result.errors) {
        console.warn(`[pi-cline] ${provider} refresh failed: ${error.message}`);
      }
    }).catch((error) => {
      console.warn(`[pi-cline] Model refresh failed: ${String(error)}`);
    });
  });
}
