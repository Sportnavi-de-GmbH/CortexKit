/**
 * Shared types. Stage modules import from here; nothing here has behaviour.
 */
import type { WorkflowConfig } from "../config/workflow.config";
import type { SupabaseBackend } from "../lib/reused/supabase";
import type { LlmPort } from "../lib/llm-port";

export interface WorkflowInput {
  query: string;
  homeCity?: string;
  sessionCities?: string[];
}

export type StageId = "detect-city" | "reformulate" | "nearby-cities" | "search" | "rerank" | "respond";

export type StageStatus = "ok" | "warning" | "error" | "skipped";

export interface StageRecord<I = unknown, O = unknown> {
  id: StageId;
  title: string;
  status: StageStatus;
  durationMs: number;
  input: I;
  output?: O;
  config: Record<string, unknown>;
  filters?: Record<string, unknown>;
  counts?: Record<string, number>;
  warnings: string[];
  error?: { message: string };
}

export interface StageResult<O> {
  output: O;
  config: Record<string, unknown>;
  filters?: Record<string, unknown>;
  counts?: Record<string, number>;
  warnings?: string[];
}

export interface StageContext {
  config: WorkflowConfig;
  deps: WorkflowDeps;
  signal: AbortSignal;
}

export interface WorkflowDeps {
  backend: SupabaseBackend;
  embed: (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>;
  llm: LlmPort;
}

export interface ResolvedCity {
  canonical: string;
  centroid: { lat: number; lng: number };
  confidence: number;
}

export interface CityAttempt {
  source: CitySource;
  mention: string;
  resolved: ResolvedCity | null;
  accepted: boolean;
  reason?: string;
}

export type CitySource = "override" | "explicit" | "home" | "session";

export interface DetectCityOutput {
  cityMention: string | null;
  target: (ResolvedCity & { source: CitySource; mention: string }) | null;
  attempts: CityAttempt[];
}

export interface ReformulateOutput {
  originalUserQuery: string;
  retrievalQuery: string;
  reformulated: boolean;
  model?: string;
}

export interface SearchCity {
  city: string;
  role: "target" | "nearby";
  distanceKm: number;
  partnerCount: number;
}

export interface NearbyCitiesOutput {
  cities: SearchCity[];
}

export interface Candidate {
  id: number;
  name: string;
  city: string;
  tags: string[];
  role: "target" | "nearby";
  sourceCity: string;
  distanceKm: number;
  similarity: number | null;
  rankInCity: number;
}

export interface CitySearchResult {
  city: string;
  role: "target" | "nearby";
  distanceKm: number;
  requested: number;
  returned: number;
  kept: number;
  failed?: string;
  results: Candidate[];
}

export interface SearchOutput {
  embedding: { model: string; dimensions: number; preview: number[] };
  retrievalQuery: string;
  perCity: CitySearchResult[];
  candidates: Candidate[];
}

export interface RankedRow {
  rank: number | null;
  id: number;
  name: string;
  city: string;
  role: "target" | "nearby";
  distanceKm: number;
  similarity: number | null;
  relevance: number;
  relevanceSource: "embedding" | "similarity" | "none";
  locationTerm: number;
  finalScore: number;
  kept: boolean;
  dropReason?: string;
}

export interface RerankOutput {
  reranker: string;
  rows: RankedRow[];
  kept: RankedRow[];
}

export interface Recommendation {
  rank: number;
  id: number;
  name: string;
  city: string;
  role: "target" | "nearby";
  distanceKm: number;
  finalScore: number;
  relevance: number;
  profile: string;
}

export interface RespondOutput {
  answer: string;
  recommendations: Recommendation[];
  profilesGiven: number;
  model?: string;
}

export type WorkflowStatus = "ok" | "needs_clarification" | "failed";

export interface WorkflowTrace {
  runId: string;
  startedAt: string;
  totalMs: number;
  status: WorkflowStatus;
  input: WorkflowInput;
  config: WorkflowConfig;
  stages: StageRecord[];
  answer?: string;
  recommendations?: Recommendation[];
  clarification?: string;
}
