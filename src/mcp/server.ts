#!/usr/bin/env bun
/**
 * SE MCP server — real tool binding for agent capabilities.
 *
 * Runs as a child process, communicating via JSON-RPC over stdio.
 * Register in .claude/settings.json:
 *   { "mcpServers": { "se": { "command": "bun", "args": ["run", "<path>/src/mcp/server.ts"] } } }
 *
 * Tools exposed:
 *   se_memory_read    — query project memory
 *   se_memory_write   — write a memory record
 *   se_task_create    — create a tracked task
 *   se_task_update    — update task status and evidence
 *   se_task_get       — get a task
 *   se_attempt_inc    — increment attempt counter; returns {count, escalate}
 *   se_escalate       — push to escalation queue
 *   se_dispatch       — route a query and return a hire payload
 */

import { createInterface } from "node:readline";
import { resolveProject, resolveMemoryLocation } from "../memory/project.ts";
import { MemoryStore } from "../memory/store.ts";
import { findCatalogueRoot, findProjectRoot } from "../util/paths.ts";
import { resolveRoles } from "../roles/resolve.ts";
import { route } from "../roles/route.ts";
import { hireOne } from "../render/hire.ts";
import {
  createTask, getTask, updateTask, listTasks,
  incrementAttempt, getAttemptCount,
  pushEscalation, listEscalations,
  type TaskStatus,
} from "./tasks.ts";

// ---------------------------------------------------------------------------
// MCP wire protocol (JSON-RPC 2.0 subset)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

function respond(id: string | number | null, result: unknown): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function error(id: string | number | null, code: number, message: string, data?: unknown): void {
  const msg: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

// ---------------------------------------------------------------------------
// Tool definitions (returned on tools/list)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "se_memory_read",
    description: "Query project memory records. Returns matching records newest-first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic or keywords to filter records (optional — omit to list all)." },
        scope: { type: "string", enum: ["session", "project", "role", "organization", "preference"], description: "Limit to one scope (optional)." },
        project_root: { type: "string", description: "Absolute path to the project (optional — defaults to cwd)." },
      },
    },
  },
  {
    name: "se_memory_write",
    description: "Write a memory record. Returns {accepted, record_id, revision} or {accepted: false, message}.",
    inputSchema: {
      type: "object",
      required: ["summary", "owner"],
      properties: {
        summary: { type: "string", description: "One-sentence summary of what was learned or decided." },
        body: { type: "string", description: "Extended detail (optional)." },
        type: { type: "string", description: "Record type, e.g. architecture-decision, bug-finding, acceptance-criteria." },
        scope: { type: "string", enum: ["session", "project"], description: "session (default) or project (requires evidence)." },
        source_path: { type: "string", description: "Repo-relative path the record is about (optional)." },
        evidence_cmd: { type: "string", description: "Command that produced evidence, e.g. 'bun test'." },
        evidence_exit: { type: "number", description: "Exit code of evidence_cmd." },
        owner: { type: "string", description: "Role id writing this record, e.g. backend-lead." },
        task_id: { type: "string", description: "Task this record belongs to (optional)." },
        project_root: { type: "string", description: "Absolute path to the project (optional — defaults to cwd)." },
      },
    },
  },
  {
    name: "se_task_create",
    description: "Create a tracked task. Returns {task_id}.",
    inputSchema: {
      type: "object",
      required: ["owner", "objective", "criteria"],
      properties: {
        task_id: { type: "string", description: "Explicit id (optional — generated if omitted)." },
        owner: { type: "string", description: "Role id accountable for this task." },
        objective: { type: "string", description: "What must be built or fixed." },
        criteria: { type: "string", description: "Acceptance criteria — something that can fail." },
        dependencies: { type: "array", items: { type: "string" }, description: "task_ids this depends on." },
        project_root: { type: "string", description: "Absolute path to the project (optional)." },
      },
    },
  },
  {
    name: "se_task_update",
    description: "Update a task's status. Returns {accepted, message}.",
    inputSchema: {
      type: "object",
      required: ["task_id", "status"],
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["queued", "running", "blocked", "completed", "escalated", "cancelled"] },
        evidence_cmd: { type: "string", description: "Command run to verify completion." },
        evidence_exit: { type: "number", description: "Exit code of evidence_cmd." },
        project_root: { type: "string" },
      },
    },
  },
  {
    name: "se_task_get",
    description: "Get a task by id. Returns the task object or null.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        project_root: { type: "string" },
      },
    },
  },
  {
    name: "se_attempt_inc",
    description: "Increment the attempt counter for (task_id, cause_id). Returns {count, escalate}. escalate=true when count reaches 2 — the two-attempt rule.",
    inputSchema: {
      type: "object",
      required: ["task_id", "cause_id"],
      properties: {
        task_id: { type: "string" },
        cause_id: { type: "string", description: "Identifier for the root cause being attempted, e.g. 'missing-idempotency-key'." },
        project_root: { type: "string" },
      },
    },
  },
  {
    name: "se_escalate",
    description: "Push a task to the escalation queue. Returns {id, position}. Call this when se_attempt_inc returns escalate=true, or on any irreversible/out-of-scope decision.",
    inputSchema: {
      type: "object",
      required: ["task_id", "reason", "from_role"],
      properties: {
        task_id: { type: "string" },
        reason: { type: "string", description: "Why this cannot proceed without operator input." },
        from_role: { type: "string", description: "The role escalating, e.g. backend-lead." },
        project_root: { type: "string" },
      },
    },
  },
  {
    name: "se_dispatch",
    description: "Route a task description and return a hire payload. Combines se route + se hire into one call. Returns {confidence, role_id, prompt, max_turns, isolation, tools, question}.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Plain-language task description." },
        catalogue_root: { type: "string", description: "Absolute path to the SE catalogue (optional — resolved from config)." },
        project_root: { type: "string", description: "Absolute path to the project being worked on (optional — defaults to cwd)." },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

type Params = Record<string, unknown>;

function projectId(params: Params): { id: string; memRoot: string } {
  const root = typeof params["project_root"] === "string" ? params["project_root"] : findProjectRoot();
  const identity = resolveProject(root);
  const loc = resolveMemoryLocation(root);
  return { id: identity.id, memRoot: loc.root };
}

function handleMemoryRead(params: Params): unknown {
  const { id, memRoot } = projectId(params);
  const store = new MemoryStore({ memoryRoot: memRoot, projectId: id });
  const ids = store.listRecordIds();
  const records = ids
    .map((rid) => store.get(rid))
    .filter(Boolean)
    .filter((r) => {
      if (typeof params["scope"] === "string" && r!.scope !== params["scope"]) return false;
      if (typeof params["query"] === "string" && params["query"].length > 0) {
        const q = (params["query"] as string).toLowerCase();
        return (
          r!.summary.toLowerCase().includes(q) ||
          (r!.body ?? "").toLowerCase().includes(q) ||
          r!.type.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => b!.written_at.localeCompare(a!.written_at))
    .slice(0, 20);
  return { records, project_id: id, count: records.length };
}

function handleMemoryWrite(params: Params): unknown {
  const { id, memRoot } = projectId(params);
  const store = new MemoryStore({ memoryRoot: memRoot, projectId: id });

  const scope = typeof params["scope"] === "string" ? params["scope"] : "session";
  const needsEvidence = scope === "project";
  const hasEvidence =
    typeof params["evidence_cmd"] === "string" && typeof params["evidence_exit"] === "number";

  if (needsEvidence && !hasEvidence) {
    return {
      accepted: false,
      message: "scope=project requires evidence_cmd and evidence_exit. Provide the command and its exit code.",
    };
  }

  const summary = params["summary"] as string;
  const owner = params["owner"] as string;
  const phase = needsEvidence ? "outcome-recording" : "execution";

  const evidence = hasEvidence
    ? [{
        kind: "command" as const,
        detail: params["evidence_cmd"] as string,
        exit_code: params["evidence_exit"] as number,
        recorded_at: new Date().toISOString(),
      }]
    : [];

  const sourceRefs = typeof params["source_path"] === "string"
    ? [{ path: params["source_path"] as string, hash: "mcp-write" }]
    : [];

  const recordId = `${owner}-${Date.now()}`;
  const result = store.put(
    {
      record_id: recordId,
      scope: scope as "session" | "project",
      type: (typeof params["type"] === "string" ? params["type"] : "observation") as string,
      status: "active",
      summary,
      ...(typeof params["body"] === "string" ? { body: params["body"] } : {}),
      source_refs: sourceRefs,
      evidence,
      trust_tier: "derived",
      owner,
      expected_revision: 0,
      ...(typeof params["task_id"] === "string" ? { task_id: params["task_id"] } : {}),
    },
    {
      phase: phase as "execution" | "outcome-recording",
      write_targets: ["*"],
      scopes: [scope as "session" | "project"],
      owner,
    },
  );

  if (result.accepted) {
    return { accepted: true, record_id: result.record_id, revision: result.revision };
  }
  return { accepted: false, message: result.message, code: result.code, surfaced: result.surfaced };
}

function handleTaskCreate(params: Params): unknown {
  const { id } = projectId(params);
  const task = createTask(id, {
    owner: params["owner"] as string,
    objective: params["objective"] as string,
    criteria: params["criteria"] as string,
    dependencies: Array.isArray(params["dependencies"]) ? params["dependencies"] as string[] : [],
    ...(typeof params["task_id"] === "string" ? { task_id: params["task_id"] } : {}),
  });
  return { task_id: task.task_id, status: task.status, created_at: task.created_at };
}

function handleTaskUpdate(params: Params): unknown {
  const { id } = projectId(params);
  return updateTask(id, params["task_id"] as string, {
    status: params["status"] as TaskStatus,
    ...(typeof params["evidence_cmd"] === "string" ? { evidence_cmd: params["evidence_cmd"] } : {}),
    ...(typeof params["evidence_exit"] === "number" ? { evidence_exit: params["evidence_exit"] } : {}),
  });
}

function handleTaskGet(params: Params): unknown {
  const { id } = projectId(params);
  return getTask(id, params["task_id"] as string);
}

function handleAttemptInc(params: Params): unknown {
  const { id } = projectId(params);
  return incrementAttempt(id, params["task_id"] as string, params["cause_id"] as string);
}

function handleEscalate(params: Params): unknown {
  const { id } = projectId(params);
  return pushEscalation(id, params["task_id"] as string, params["reason"] as string, params["from_role"] as string);
}

function handleDispatch(params: Params): unknown {
  const catalogueRoot =
    typeof params["catalogue_root"] === "string"
      ? params["catalogue_root"]
      : findCatalogueRoot();

  if (!catalogueRoot) {
    return {
      confidence: "none",
      question: "SE catalogue not found. Run `se link` from inside the catalogue repository first.",
    };
  }

  const projectRoot =
    typeof params["project_root"] === "string" ? params["project_root"] : findProjectRoot();

  const registry = resolveRoles(catalogueRoot);
  const result = route(params["query"] as string, registry.byId);

  if (result.confidence !== "clear" || !result.owners[0]) {
    return {
      confidence: result.confidence,
      question: result.question,
      departments: result.departments,
      candidates: result.owners.slice(0, 4).map((o) => ({ role: o.role, department: o.departmentLabel, score: o.score })),
    };
  }

  const roleId = result.owners[0].role;
  const role = registry.byId.get(roleId);
  if (!role) {
    return { confidence: "none", question: `Role "${roleId}" found by routing but missing from registry.` };
  }

  const payload = hireOne(role, catalogueRoot, projectRoot);
  return {
    confidence: "clear",
    role_id: payload.role,
    name: payload.name,
    department: payload.department,
    prompt: payload.prompt,
    tools: payload.tools,
    max_turns: payload.max_turns,
    isolation: payload.isolation,
    escalates_to: payload.escalates_to,
    unmapped: payload.unmapped,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function handleCall(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Params;
  switch (method) {
    case "se_memory_read":  return handleMemoryRead(p);
    case "se_memory_write": return handleMemoryWrite(p);
    case "se_task_create":  return handleTaskCreate(p);
    case "se_task_update":  return handleTaskUpdate(p);
    case "se_task_get":     return handleTaskGet(p);
    case "se_attempt_inc":  return handleAttemptInc(p);
    case "se_escalate":     return handleEscalate(p);
    case "se_dispatch":     return handleDispatch(p);
    default: throw new Error(`Unknown tool: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch {
    error(null, -32700, "Parse error");
    return;
  }

  const { id, method, params } = req;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "se", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = (params ?? {}) as { name: string; arguments?: unknown };
    try {
      const result = handleCall(name, args);
      respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (cause) {
      error(id, -32603, (cause as Error).message);
    }
    return;
  }

  error(id, -32601, `Method not found: ${method}`);
});

rl.on("close", () => process.exit(0));

// Keep stderr clean — MCP clients interpret any stderr output as a protocol error on some hosts.
process.on("uncaughtException", (e) => {
  error(null, -32603, `Uncaught: ${e.message}`);
});
