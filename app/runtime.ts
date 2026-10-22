// Picks adapters from config. Each sponsor is used live when configured and healthy; otherwise the bundled
// fallback is used and the choice is reported (never silently claimed as live).
import { join } from "node:path";
import { config } from "./config.js";
import { NemotronClient, RulesOnlyClient } from "./adapters/model.js";
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

  const model: ModelClient = config.useNemotron ? new NemotronClient() : new RulesOnlyClient();
  if (!config.useNemotron) notes.push("No NVIDIA_API_KEY (or SAMPLE_MODE=true); agents use rule-based fallbacks");

  let memory: MemoryStore = new LocalMemory(join(ledgerDir, "memory.json"));
  if (!config.sampleMode) {
    const Hmem = await optional<MemoryStore>("./adapters/hmem.js", "HmemMemoryStore");
    if (Hmem) {
      try {
        memory = new Hmem({ persistDir: process.env.HMEM_DIR ?? join(config.dataDir, "memory") });
      } catch (e) {
        notes.push(`H-MEM unavailable (${(e as Error).message}); using local lineage index`);
      }
    } else notes.push("H-MEM adapter not present; using local lineage index");
  }

  return {
    gateway, sample, model, memory,
    store: new DecisionStore(join(ledgerDir, "decisions_state.json")),
    modes: { data: gateway.name, model: config.useNemotron ? "nemotron" : "rules", memory: memory.name ?? "memory", notes },
  };
}
