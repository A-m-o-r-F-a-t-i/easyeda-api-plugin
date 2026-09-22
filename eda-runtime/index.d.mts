export interface NormalizedPlan {
  target: { windowId?: string; projectUuid?: string; documentUuid: string };
  operations: Array<Record<string, unknown>>;
  options: { toleranceMil: number; batchSize: number; saveAfterBatch: boolean };
}
export function readRuntime(eda: unknown, request: Record<string, unknown>): Promise<unknown>;
export function batchRuntime(eda: unknown, job: Record<string, unknown>): Promise<{ok: boolean; results: Array<Record<string, unknown>>; error?: unknown}>;
export function textBatchRuntime(eda: unknown, job: Record<string, unknown>): Promise<{ok: boolean; results: Array<Record<string, unknown>>; error?: unknown}>;
export function validatePlan(plan: unknown): NormalizedPlan;
export function validateTextPlan(plan: unknown): NormalizedPlan;
export function pcbToolsRuntime(eda: unknown, request: Record<string, unknown>): Promise<Record<string, unknown>>;
export function constraintRuntime(eda: unknown, request: Record<string, unknown>): Promise<Record<string, unknown>>;
