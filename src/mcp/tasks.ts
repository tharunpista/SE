/**
 * Task, attempt counter, and escalation stores for the MCP runtime layer.
 *
 * Intentionally simpler than the memory store: tasks are mutable state that
 * belongs to the runtime (not the project record), and the phase/grant/CAS
 * machinery that protects durable memory records is too heavy for a counter
 * that increments once per attempt. Files are written atomically via rename;
 * reads are consistent within one process because Bun's fs is synchronous.
 */

import {
  existsSync, mkdirSync, readdirSync,
  readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { seHome } from "../util/paths.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function tasksDir(projectId: string): string {
  return join(seHome(), "tasks", projectId);
}

function attemptsDir(projectId: string): string {
  return join(seHome(), "attempts", projectId);
}

function escalationsDir(): string {
  return join(seHome(), "escalations");
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, data, { encoding: "utf8", flush: true });
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Task store
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "queued" | "running" | "blocked" | "completed" | "escalated" | "cancelled";

export interface TaskEvidence {
  readonly cmd: string;
  readonly exit_code: number;
  readonly recorded_at: string;
}

export interface Task {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly project_id: string;
  readonly owner: string;
  readonly objective: string;
  readonly criteria: string;
  readonly dependencies: readonly string[];
  readonly status: TaskStatus;
  readonly evidence: readonly TaskEvidence[];
  readonly blockers: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
}

export function createTask(
  projectId: string,
  opts: { owner: string; objective: string; criteria: string; dependencies?: string[]; task_id?: string },
): Task {
  const dir = tasksDir(projectId);
  mkdirSync(dir, { recursive: true });
  const task: Task = {
    schema_version: 1,
    task_id: opts.task_id ?? randomUUID(),
    project_id: projectId,
    owner: opts.owner,
    objective: opts.objective,
    criteria: opts.criteria,
    dependencies: opts.dependencies ?? [],
    status: "queued",
    evidence: [],
    blockers: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  atomicWrite(join(dir, `${task.task_id}.json`), JSON.stringify(task, null, 2));
  return task;
}

export function getTask(projectId: string, taskId: string): Task | null {
  const path = join(tasksDir(projectId), `${taskId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Task;
}

export function updateTask(
  projectId: string,
  taskId: string,
  opts: { status: TaskStatus; evidence_cmd?: string; evidence_exit?: number },
): { accepted: boolean; message: string; task?: Task } {
  const task = getTask(projectId, taskId);
  if (!task) return { accepted: false, message: `Task "${taskId}" not found.` };

  const evidence: TaskEvidence[] = [...task.evidence];
  if (opts.evidence_cmd !== undefined && opts.evidence_exit !== undefined) {
    evidence.push({ cmd: opts.evidence_cmd, exit_code: opts.evidence_exit, recorded_at: new Date().toISOString() });
  }

  const updated: Task = {
    ...task,
    status: opts.status,
    evidence,
    updated_at: new Date().toISOString(),
  };
  atomicWrite(join(tasksDir(projectId), `${taskId}.json`), JSON.stringify(updated, null, 2));
  return { accepted: true, message: "updated", task: updated };
}

export function listTasks(projectId: string): Task[] {
  const dir = tasksDir(projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Task)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ---------------------------------------------------------------------------
// Attempt counter
// ---------------------------------------------------------------------------

interface AttemptRecord {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly cause_id: string;
  count: number;
  readonly first_at: string;
  last_at: string;
}

/** Two-attempt rule: returns escalate=true when count reaches 2. */
export function incrementAttempt(
  projectId: string,
  taskId: string,
  causeId: string,
): { count: number; escalate: boolean } {
  const dir = attemptsDir(projectId);
  mkdirSync(dir, { recursive: true });
  const safe = `${taskId}--${causeId}`.replace(/[^a-z0-9\-]/gi, "_");
  const path = join(dir, `${safe}.json`);

  let rec: AttemptRecord;
  if (existsSync(path)) {
    rec = JSON.parse(readFileSync(path, "utf8")) as AttemptRecord;
    rec = { ...rec, count: rec.count + 1, last_at: new Date().toISOString() };
  } else {
    rec = {
      schema_version: 1,
      task_id: taskId,
      cause_id: causeId,
      count: 1,
      first_at: new Date().toISOString(),
      last_at: new Date().toISOString(),
    };
  }
  atomicWrite(path, JSON.stringify(rec, null, 2));
  return { count: rec.count, escalate: rec.count >= 2 };
}

export function getAttemptCount(projectId: string, taskId: string, causeId: string): number {
  const safe = `${taskId}--${causeId}`.replace(/[^a-z0-9\-]/gi, "_");
  const path = join(attemptsDir(projectId), `${safe}.json`);
  if (!existsSync(path)) return 0;
  return (JSON.parse(readFileSync(path, "utf8")) as AttemptRecord).count;
}

// ---------------------------------------------------------------------------
// Escalation queue
// ---------------------------------------------------------------------------

export interface EscalationRecord {
  readonly schema_version: 1;
  readonly id: string;
  readonly task_id: string;
  readonly reason: string;
  readonly from_role: string;
  readonly project_id: string;
  readonly created_at: string;
}

export function pushEscalation(
  projectId: string,
  taskId: string,
  reason: string,
  fromRole: string,
): { id: string; position: number } {
  const dir = escalationsDir();
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const rec: EscalationRecord = {
    schema_version: 1,
    id,
    task_id: taskId,
    reason,
    from_role: fromRole,
    project_id: projectId,
    created_at: new Date().toISOString(),
  };
  atomicWrite(join(dir, `${rec.created_at.replace(/[:.]/g, "-")}-${id}.json`), JSON.stringify(rec, null, 2));
  const all = listEscalations(projectId);
  return { id, position: all.findIndex((e) => e.id === id) + 1 };
}

export function listEscalations(projectId: string): EscalationRecord[] {
  const dir = escalationsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as EscalationRecord)
    .filter((e) => e.project_id === projectId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
