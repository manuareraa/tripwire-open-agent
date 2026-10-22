// Runtime config. SAMPLE_MODE is on when asked for, or when no live credentials exist.

const env = process.env;

export const config = {
  sampleMode:
    env.SAMPLE_MODE === "true" ||
    (!env.ZETARIS_API_KEY && !env.ZETARIS_PASSWORD && !env.NVIDIA_API_KEY),
  port: Number(env.PORT ?? 8000),
  zetaris: {
    baseUrl: env.ZETARIS_BASE_URL ?? "http://localhost:3000",
    orgId: env.ZETARIS_ORG_ID ?? "",
    apiKey: env.ZETARIS_API_KEY ?? "",
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
