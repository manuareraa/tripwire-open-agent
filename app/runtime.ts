// Picks adapters from config. Each sponsor is used live when configured and healthy; otherwise the bundled
// fallback is used and the choice is reported (never silently claimed as live).
import { join } from "node:path";
import { config } from "./config.js";
import { FallbackModelClient, NemotronClient, NightshiftClient, RulesOnlyClient } from "./adapters/model.js";
import { RecordingModelClient, ReplayModelClient } from "./adapters/recording.js";
import { SampleDataGateway } from "./adapters/sample_data.js";
import { LocalMemory } from "./adapters/local_memory.js";
import { DecisionStore } from "./store.js";
import type { DataGateway, MemoryStore, ModelClient } from "./types.js";

export interface Runtime {
  gateway: DataGateway;
  sample: SampleDataGateway;
  model: ModelClient;
  memory: MemoryStore;
  store: DecisionStore;
  modes: { data: string; model: string; memory: string; notes: string[] };
}

/** Optional adapters from other streams are loaded by path so a missing one never breaks startup. */
async function optional<T>(path: string, exportName: string): Promise<(new (...a: any[]) => T) | undefined> {
  try {
    const mod = await import(path);
    return mod[exportName];
  } catch {
    return undefined;
  }
}

export async function buildRuntime(): Promise<Runtime> {
  const notes: string[] = [];
  const ledgerDir = join(config.dataDir, "ledger");
  const sample = new SampleDataGateway({ ledgerDir });

  let gateway: DataGateway = sample;
  if (config.useZetaris) {
    const Zetaris = await optional<DataGateway>("./adapters/zetaris.js", "ZetarisGateway");
    if (!Zetaris) notes.push("Zetaris adapter not present; using bundled sample data");
    else {
      const z = new Zetaris();
      const h = await z.health().catch((e: Error) => ({ ok: false, detail: e.message }));
      if (h.ok) gateway = z;
      else notes.push(`Zetaris unreachable (${h.detail}); using bundled sample data`);
    }
  }

  // Nightshift is the primary provider. Direct NVIDIA is a labelled backup for calls Nightshift cannot answer.
  let model: ModelClient = new RulesOnlyClient();
  let modelMode = "rules";
  let replay: ReplayModelClient | undefined;
  const direct = config.useNvidiaDirect ? new NemotronClient() : undefined;
  if (config.useNightshift) {
    const ns = new NightshiftClient();
    const d = await ns.discover();
    if (d.status === "online") {
      model = direct ? new FallbackModelClient(ns, direct) : ns;
      modelMode = direct ? "nightshift+nvidia-backup" : "nightshift";
    } else {
      notes.push(`Meterless Nightshift ${d.status} (${d.detail})${direct ? "; using NVIDIA direct as backup" : "; agents use rule-based fallbacks"}`);
      if (direct) {
        model = new FallbackModelClient(ns, direct);
        modelMode = "nvidia-backup";
      }
    }
  } else if (direct) {
    model = direct;
    modelMode = "nvidia-direct";
    notes.push("No METERLESS_RUNTIME_TOKEN: Nemotron is called on build.nvidia.com directly, not through Nightshift");
  } else if (config.modelReplay && (replay = new ReplayModelClient(config.modelReplayFile)).size > 0) {
    model = replay;
    modelMode = "replay";
    notes.push(`No live model: replaying ${replay.size} recorded live Nemotron answers from ${config.modelReplayFile}; prompts with no recording use rule-based fallbacks`);
  } else notes.push("No model provider (or SAMPLE_MODE=true); agents use rule-based fallbacks");
  if (config.modelRecordFile && model.enabled) {
    model = new RecordingModelClient(model, config.modelRecordFile);
    notes.push(`Recording every model call to ${config.modelRecordFile}`);
  }

  // H-MEM is in-process, so it runs in every mode (SAMPLE_MODE included); the JSON lineage file is only a fallback.
  let memory: MemoryStore | undefined;
  const Hmem = await optional<MemoryStore>("./adapters/hmem.js", "HmemMemoryStore");
  if (Hmem) {
    try {
      memory = new Hmem({ persistDir: process.env.HMEM_DIR ?? join(ledgerDir, "memory") });
    } catch (e) {
      notes.push(`H-MEM unavailable (${(e as Error).message}); using local lineage index`);
    }
  } else notes.push("H-MEM adapter not present; using local lineage index");
  memory ??= new LocalMemory(join(ledgerDir, "memory.json"));

  return {
    gateway, sample, model, memory,
    store: new DecisionStore(join(ledgerDir, "decisions_state.json")),
    modes: { data: gateway.name, model: modelMode, memory: memory.name ?? "memory", notes },
  };
}
