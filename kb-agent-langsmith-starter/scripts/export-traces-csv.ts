// Export the Langfuse Tracing table to CSV, straight from the API.
//
//   npm run export:csv                       last 30 days → traces-export.csv
//   npm run export:csv -- out.csv 7          last 7 days
//
// WHY THIS EXISTS: the self-hosted instance's own "Export as CSV" button
// queues a batch-export job that FAILS ("An internal error occurred"), because
// batch export is disabled by default on self-hosted Langfuse — it needs
// LANGFUSE_S3_BATCH_EXPORT_ENABLED=true plus a bucket on the SERVER, which is
// infrastructure, not application config (see docs/FEEDBACK-SYSTEM.md §6).
// This script needs none of that: it reads the public API with the project
// keys already in .env.local and writes the file locally.
//
// Read-only. One row per observation (the same grain the UI calls "events"),
// with the columns a spreadsheet actually needs: timing, model, tokens, cost,
// level and the visitor's question/answer.
import "../lib/load-env.ts";

import { writeFileSync } from "node:fs";

import { langfuseBaseUrl, langfuseEnabled, langfuseHeaders } from "../lib/langfuse.ts";

if (!langfuseEnabled()) {
  console.error("Langfuse is not configured — nothing to export.");
  process.exit(3);
}

const out = process.argv[2] ?? "traces-export.csv";
const days = Math.max(1, Number(process.argv[3] ?? 30));
const from = new Date(Date.now() - days * 86_400_000).toISOString();
const base = langfuseBaseUrl();
const headers = langfuseHeaders();

interface Obs {
  id?: string;
  traceId?: string;
  traceName?: string | null;
  name?: string;
  type?: string;
  environment?: string;
  sessionId?: string;
  startTime?: string;
  endTime?: string;
  latency?: number;
  level?: string;
  statusMessage?: string;
  providedModelName?: string;
  usageDetails?: Record<string, number>;
  totalCost?: number;
  input?: unknown;
  output?: unknown;
}

/** Cursor-paged: v2/observations has no `page` param (a `page` is a 400). */
const rows: Obs[] = [];
let cursor: string | undefined;
for (let page = 0; page < 500; page++) {
  const qs = new URLSearchParams({
    limit: "100",
    fromStartTime: from,
    fields: "core,basic,time,io,model,usage,metrics,trace_context",
  });
  if (cursor) qs.set("cursor", cursor);
  const res = await fetch(`${base}/api/public/v2/observations?${qs}`, { headers });
  if (!res.ok) throw new Error(`v2/observations: ${res.status}`);
  const json = (await res.json()) as { data?: Obs[]; meta?: { cursor?: string | null } };
  rows.push(...(json.data ?? []));
  cursor = json.meta?.cursor ?? undefined;
  if (!cursor) break;
}

/** RFC-4180 quoting; newlines collapsed so one observation stays one row. */
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
};

const HEADER = [
  "startTime", "endTime", "latencySeconds", "traceId", "traceName", "observationId",
  "name", "type", "level", "statusMessage", "environment", "sessionId",
  "model", "inputTokens", "outputTokens", "cachedInputTokens", "totalTokens",
  "totalCostUSD", "input", "output",
];

const lines = [HEADER.join(",")];
for (const o of rows) {
  const u = o.usageDetails ?? {};
  lines.push(
    [
      o.startTime, o.endTime, o.latency, o.traceId, o.traceName, o.id,
      o.name, o.type, o.level, o.statusMessage, o.environment, o.sessionId,
      o.providedModelName, u.input, u.output, u.input_cached_tokens, u.total,
      o.totalCost, o.input, o.output,
    ].map(cell).join(","),
  );
}

// Leading BOM so Excel opens UTF-8 (German umlauts) correctly.
writeFileSync(out, `﻿${lines.join("\r\n")}\r\n`, "utf8");
const traces = new Set(rows.map((r) => r.traceId).filter(Boolean)).size;
const cost = rows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0);
console.log(
  `${rows.length} observations across ${traces} traces → ${out}\n` +
    `window: last ${days} days (from ${from.slice(0, 10)}) · total cost $${cost.toFixed(6)}`,
);
