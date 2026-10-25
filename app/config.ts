// Runtime config. SAMPLE_MODE=true forces fully offline (bundled data, rule-based agents).
// Otherwise each sponsor is used live when its credentials exist, and falls back when they don't.

const env = process.env;
const forcedSample = env.SAMPLE_MODE === "true";
/** auto (Nightshift first, NVIDIA direct as backup) | nightshift | nvidia. */
const provider = (env.LLM_PROVIDER ?? "auto").toLowerCase();
const hasNightshift = !!(env.METERLESS_RUNTIME_TOKEN || env.METERLESS_TOKEN_FILE);

export const config = {
  sampleMode: forcedSample || (!env.ZETARIS_API_KEY && !env.ZETARIS_PASSWORD && !env.NVIDIA_API_KEY && !hasNightshift),
  useZetaris: !forcedSample && !!(env.ZETARIS_API_KEY || env.ZETARIS_PASSWORD),
  /** Nightshift is the primary model provider; direct NVIDIA is only a labelled backup. */
  useNightshift: !forcedSample && hasNightshift && provider !== "nvidia",
  useNvidiaDirect: !forcedSample && !!env.NVIDIA_API_KEY && provider !== "nightshift",
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
  nightshift: {
    baseUrl: env.METERLESS_BASE_URL ?? "http://127.0.0.1:8088/v1",
    token: env.METERLESS_RUNTIME_TOKEN ?? "",
    /** <stateDir>/proxy-token written by the Nightshift runtime; read when no token is set. */
    tokenFile: env.METERLESS_TOKEN_FILE ?? "",
    appId: env.METERLESS_APP_ID ?? "tripwire",
    reasoningModel: env.METERLESS_REASONING_MODEL ?? "",
    smallModel: env.METERLESS_SMALL_MODEL ?? "",
    guardModel: env.METERLESS_GUARD_MODEL ?? "",
    timeoutMs: Number(env.METERLESS_TIMEOUT_MS ?? 180000),
  },
  nvidia: {
    baseUrl: env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: env.NVIDIA_API_KEY ?? "",
    reasoningModel: env.NVIDIA_REASONING_MODEL ?? "",
    smallModel: env.NVIDIA_SMALL_MODEL ?? "",
    guardModel: env.NVIDIA_GUARD_MODEL ?? "",
    timeoutMs: Number(env.MODEL_TIMEOUT_MS ?? 60000),
  },
  /** Live runs append every model call (with its receipt) here when set. */
  modelRecordFile: env.MODEL_RECORD_FILE ?? "",
  /** With no live model, recorded live answers are replayed from here (labelled as replays). MODEL_REPLAY=false turns it off. */
  modelReplayFile: env.MODEL_REPLAY_FILE ?? "data/recordings/nightshift.jsonl",
  modelReplay: env.MODEL_REPLAY !== "false",
  limits: {
    maxRoundsPerDecision: 3,
    maxRetriesPerQuery: 2,
    runTimeoutMs: Number(env.RUN_TIMEOUT_MS ?? 180000),
  },
};
