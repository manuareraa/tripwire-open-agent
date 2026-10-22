// Runtime config. SAMPLE_MODE=true forces fully offline (bundled data, rule-based agents).
// Otherwise each sponsor is used live when its credentials exist, and falls back when they don't.

const env = process.env;
const forcedSample = env.SAMPLE_MODE === "true";

export const config = {
  sampleMode: forcedSample || (!env.ZETARIS_API_KEY && !env.ZETARIS_PASSWORD && !env.NVIDIA_API_KEY),
  useZetaris: !forcedSample && !!(env.ZETARIS_API_KEY || env.ZETARIS_PASSWORD),
  useNemotron: !forcedSample && !!env.NVIDIA_API_KEY,
  dataDir: env.DATA_DIR ?? "data",
  port: Number(env.PORT ?? 8000),
  zetaris: {
    baseUrl: env.ZETARIS_BASE_URL ?? "http://localhost:3000",
    orgId: env.ZETARIS_ORG_ID ?? "",
    apiKey: env.ZETARIS_API_KEY ?? "",
    username: env.ZETARIS_USERNAME ?? "",
    storageRoot: env.ZETARIS_STORAGE_ROOT ?? "",
    timeoutMs: Number(env.ZETARIS_TIMEOUT_MS ?? 30000),
  },
  nvidia: {
    baseUrl: env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: env.NVIDIA_API_KEY ?? "",
    reasoningModel: env.NVIDIA_REASONING_MODEL ?? "",
    smallModel: env.NVIDIA_SMALL_MODEL ?? "",
    guardModel: env.NVIDIA_GUARD_MODEL ?? "",
    timeoutMs: Number(env.MODEL_TIMEOUT_MS ?? 60000),
  },
  limits: {
    maxRoundsPerDecision: 3,
    maxRetriesPerQuery: 2,
    runTimeoutMs: Number(env.RUN_TIMEOUT_MS ?? 180000),
  },
};
