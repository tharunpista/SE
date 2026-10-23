/**
 * A single write, killed at a named point in the protocol (Part XX 81.1).
 *
 * This runs as a real child process and dies with an uncatchable `process.exit`,
 * because the states the crash table describes last microseconds and cannot be
 * observed by a test that stays inside the writing process.
 *
 * argv: <memoryRoot> <projectId> <faultPoint|none> <recordId> <summary> <expectedRevision>
 */

import { MemoryStore, type FaultPoint } from "../../../src/memory/store.ts";
import type { WriteGrant, WriteRequest } from "../../../src/memory/types.ts";

const [memoryRoot, projectId, fault, recordId, summary, expectedRevision] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

const CRASH_EXIT = 42;

const store = new MemoryStore({
  memoryRoot,
  projectId,
  ...(fault === "none"
    ? {}
    : {
        faultHook: (point: FaultPoint) => {
          if (point === fault) process.exit(CRASH_EXIT);
        },
      }),
});

const grant: WriteGrant = {
  phase: "outcome-recording",
  write_targets: ["*"],
  scopes: ["project"],
  owner: "crash-test",
};

const request: WriteRequest = {
  record_id: recordId,
  scope: "project",
  type: "decision",
  status: "active",
  summary,
  owner: "crash-test",
  evidence: [{ kind: "command", detail: "crash test", exit_code: 0, recorded_at: new Date().toISOString() }],
  expected_revision: Number(expectedRevision),
};

const result = store.put(request, grant);
// Only reached when no fault fired. The parent asserts on this.
process.stdout.write(JSON.stringify(result));
process.exit(result.accepted ? 0 : 1);
