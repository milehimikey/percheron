/**
 * FileLedger — percheron's runtime state as one committed JSON file.
 *
 * Single write path, write-through on every mutation, append-only events.
 * A fresh controller resumes from this file + the provider's own ledger +
 * the evidence archive; nothing lives only in memory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  Ledger,
  LedgerEvent,
  LedgerEventRecord,
  NodePipelineState,
} from "../contracts/ledger.js";

interface LedgerDoc {
  ledgerVersion: 1;
  nodes: Record<string, NodePipelineState>;
  events: LedgerEventRecord[];
}

const EMPTY: LedgerDoc = { ledgerVersion: 1, nodes: {}, events: [] };

export class FileLedger implements Ledger {
  constructor(private readonly path: string) {}

  async load(): Promise<{
    nodes: NodePipelineState[];
    events: LedgerEventRecord[];
  }> {
    const doc = await this.read();
    return { nodes: Object.values(doc.nodes), events: doc.events };
  }

  async setNodeState(state: NodePipelineState): Promise<void> {
    const doc = await this.read();
    doc.nodes[state.nodeKey] = state;
    await this.write(doc);
  }

  async append(event: LedgerEvent): Promise<void> {
    const doc = await this.read();
    doc.events.push({ at: new Date().toISOString(), event });
    await this.write(doc);
  }

  private async read(): Promise<LedgerDoc> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as LedgerDoc;
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private async write(doc: LedgerDoc): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(doc, null, 2));
  }
}
