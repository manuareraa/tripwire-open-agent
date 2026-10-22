// H-MEM reference implementation facade. Deterministic, zero runtime
// dependencies, in-memory with optional JSON persistence. This is the
// minimal runnable expression of AGENTS.md, not a production library.

import type { FeedbackKind, HMEMOptions, MemoryRecord, MiningEventType, QueryResult } from "./types.js";
import type { AddInput } from "./memoryStore.js";
import { MemoryStoreService } from "./memoryStore.js";
import { TrustLedgerService } from "./trustLedger.js";
import { MemoryMiningService } from "./memoryMining.js";
import { MemoryRetrievalService } from "./memoryRetrieval.js";
import { ConflictDetectionService } from "./conflictDetection.js";
import { SleepCycleService } from "./sleepCycle.js";
import { DreamingService } from "./dreaming.js";

export * from "./types.js";
export { MemoryStoreService } from "./memoryStore.js";
export { TrustLedgerService } from "./trustLedger.js";
export { MemoryMiningService, parseStrictJsonArray } from "./memoryMining.js";
export { MemoryRetrievalService } from "./memoryRetrieval.js";
export { ConflictDetectionService } from "./conflictDetection.js";
export { SleepCycleService } from "./sleepCycle.js";
export { DreamingService } from "./dreaming.js";
export { embed, cosine, tokenize, jaccard } from "./embeddings.js";

export class HMEM {
  readonly ledger: TrustLedgerService;
  readonly store: MemoryStoreService;
  readonly mining: MemoryMiningService;
  readonly retrieval: MemoryRetrievalService;
  readonly conflicts: ConflictDetectionService;
  readonly sleep: SleepCycleService;
  readonly dreaming: DreamingService;
  readonly clock: () => number;

  constructor(opts: HMEMOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    const actor = opts.actor ?? "system";
    this.ledger = new TrustLedgerService(this.clock, opts.persistDir);
    this.store = new MemoryStoreService(this.clock, this.ledger, actor, opts.persistDir);
    this.mining = new MemoryMiningService(this.store, this.clock, opts.minerFn);
    this.retrieval = new MemoryRetrievalService(this.store, this.ledger, this.clock, actor);
    this.conflicts = new ConflictDetectionService(this.store, this.ledger, this.clock, actor);
    this.sleep = new SleepCycleService(this.store, this.ledger, this.clock, actor);
    this.dreaming = new DreamingService(this.store, this.ledger, this.clock, actor);
  }

  // Convenience surface mirroring HOW_TO_USE_H-MEM.md.
  add(input: AddInput): MemoryRecord {
    return this.store.add(input);
  }
  mine(event: MiningEventType, text: string, opts?: { chatId?: string }): Promise<MemoryRecord[]> {
    return this.mining.mineInteraction(event, text, opts);
  }
  query(query: string, opts?: { topN?: number; threshold?: number; chatId?: string }): QueryResult {
    return this.retrieval.query(query, opts);
  }
  feedback(memoryId: string, kind: FeedbackKind): void {
    this.retrieval.feedback(memoryId, kind);
  }
}
