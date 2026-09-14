import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension, { createClinePassProvider, registerClinePassProvider } from "./index.ts";
import { CATALOG_TIMEOUT_MS, CLINE_FREE_HEADERS, getFallbackModels, loadModels } from "./models.ts";

const catalog = {
  data: [
    {
      id: "anthropic/claude-test",
      name: "Claude Test",
      supported_parameters: ["reasoning", "tools"],
    },
    {
      id: "z-ai/glm-5.3",
      name: "GLM 5.3",
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 131_072 },
      supported_parameters: ["reasoning", "tools"],
    },
  ],
};
const recommended = {
  free: [{ id: "cline-free/claude-test", name: "Claude Test" }],
  clinePass: [{ id: "cline-pass/glm-5.3", name: "GLM-5.3" }],
};

function fakeFetch(input: string | URL | Request): Promise<Response> {
  return Promise.resolve(Response.json(String(input).endsWith("recommended-models") ? recommended : catalog));
}

test("allows 15 seconds for the live ClinePass catalog", () => {
  assert.equal(CATALOG_TIMEOUT_MS, 15_000);
});

test("maps the ClinePass and free catalogs", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-map-"));
  try {
    const models = await loadModels(fakeFetch, agentDir);
    assert.equal(models.length, 2, "ClinePass and free models are included");
    assert.equal(models[0].id, "cline-pass/glm-5.3");
    assert.equal(models[0].provider, "cline-pass");
    assert.equal(models[0].contextWindow, 1_000_000);
    const free = models.find((m) => m.id === "cline-free/claude-test");
    assert.equal(free?.provider, "cline-pass");
    assert.deepEqual(free?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(free?.headers, CLINE_FREE_HEADERS, "cline-free ids carry the Cline client headers");
    assert.equal(models[0].headers, undefined, "paid ids keep default headers");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("registers initial ClinePass models and refreshes dynamically", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-register-"));
  try {
    const provider = createClinePassProvider(fakeFetch, agentDir);
    assert.equal(provider.id, "cline-pass");
    assert.equal(provider.getModels().length, 13);

    await provider.refreshModels!({
      allowNetwork: true,
      publish: async (publication) => {
        publication.update?.();
        return true;
      },
      signal: new AbortController().signal,
    });

    assert.ok(provider.getModels().some((model) => model.id === "cline-pass/glm-5.3"));
    assert.ok(provider.getModels().every((model) => model.provider === "cline-pass"));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("registers only ClinePass and refreshes without blocking startup", async () => {
  const providers: Provider[] = [];
  let sessionStart: ((event: unknown, ctx: any) => unknown) | undefined;
  let finishRefresh!: (value: { errors: Map<string, Error> }) => void;
  const pending = new Promise<{ errors: Map<string, Error> }>((resolve) => { finishRefresh = resolve; });

  extension({
    registerProvider(provider: Provider) { providers.push(provider); },
    on(event: string, handler: (event: unknown, ctx: any) => unknown) {
      if (event === "session_start") sessionStart = handler;
    },
  } as any);

  assert.deepEqual(providers.map((provider) => provider.id), ["cline-pass"]);
  const returned = sessionStart?.({}, { modelRegistry: { refresh: () => pending } });
  assert.equal(returned, undefined);
  finishRefresh({ errors: new Map() });
  await pending;
});

test("allows baseUrl overwrite for ClinePass", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-override-"));
  try {
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: { "cline-pass": { baseUrl: "http://localhost:8789" } },
    }));
    const runtime = await ModelRuntime.create({
      modelsPath,
      authPath: join(agentDir, "auth.json"),
    });
    const registry = new ModelRegistry(runtime);
    registerClinePassProvider(registry, fakeFetch, agentDir);

    assert.equal(runtime.getProvider("cline"), undefined);
    assert.equal(runtime.getProvider("cline-pass")?.baseUrl, "http://localhost:8789");
    assert.equal(runtime.getModels("cline-pass")[0]?.baseUrl, "http://localhost:8789");
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("preserves route-marker wrapping across dynamic refreshes", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-route-marker-"));
  process.env.CLINE_API_KEY = "dummy-key";
  try {
    const modelsPath = join(agentDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        "cline-pass": { baseUrl: "http://localhost:8788", routeMarker: "route_to" },
      },
    }));
    const runtime = await ModelRuntime.create({
      modelsPath,
      authPath: join(agentDir, "auth.json"),
    });
    const registry = new ModelRegistry(runtime);
    registerClinePassProvider(registry, fakeFetch, agentDir);

    const native = registry.getRegisteredNativeProvider("cline-pass")!;
    const routedBaseUrl = "http://localhost:8788/route_to/https://api.cline.bot/api/v1";
    const routedProvider: Provider = {
      ...native,
      baseUrl: routedBaseUrl,
      auth: {
        apiKey: {
          ...native.auth.apiKey!,
          async resolve(input) {
            const result = await native.auth.apiKey!.resolve(input);
            return result ? { ...result, auth: { ...result.auth, baseUrl: routedBaseUrl } } : undefined;
          },
        },
      },
    };
    registry.registerProvider(routedProvider);

    const provider = registry.getRegisteredNativeProvider("cline-pass")!;
    await provider.refreshModels!({
      allowNetwork: true,
      publish: async (publication) => {
        publication.update?.();
        return true;
      },
      signal: new AbortController().signal,
    });

    assert.equal((await runtime.getAuth("cline-pass"))?.auth.baseUrl, routedBaseUrl);
    assert.ok(runtime.getModels("cline-pass").some((model) => model.id === "cline-pass/glm-5.3"));
    assert.ok(runtime.getModels("cline-pass").every((model) => model.provider === "cline-pass"));
  } finally {
    delete process.env.CLINE_API_KEY;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("caches the live ClinePass catalog and reuses it offline", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-cache-"));
  try {
    const live = await loadModels(fakeFetch, agentDir);
    const path = join(agentDir, "cline-pass", "models.json");
    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(Array.isArray(JSON.parse(readFileSync(path, "utf8"))));
    assert.deepEqual(getFallbackModels(agentDir), live);

    const offline = () => Promise.resolve(new Response("down", { status: 503 }));
    assert.deepEqual(await loadModels(offline, agentDir), live);

    writeFileSync(path, "not json");
    assert.equal(getFallbackModels(agentDir).length, 13);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("keeps ClinePass usable when discovery fails", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-cline-fallback-"));
  try {
    const fail = () => Promise.resolve(new Response("down", { status: 503 }));
    assert.equal((await loadModels(fail, agentDir)).length, 13);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
