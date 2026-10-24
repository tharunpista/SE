/**
 * Topics: roles grouped by the job an operator arrives with.
 *
 * A department is where a role reports. A topic is what someone types. The two
 * are different axes and only one of them is useful for routing: "auth" needs
 * `security-architect`, `identity-access-integration-engineer`,
 * `authorization-model-engineer`, `cryptography-key-management-engineer` and
 * `privacy-engineer` -- five roles from three departments. No department
 * selection reaches that set, and an operator asking about login does not know
 * which department owns it. That is the whole reason this exists.
 *
 * Membership is explicit, declared in `schemas/topics.json`, and validated
 * against the catalogue. It is deliberately not derived from artifact kinds or
 * from matching words in role names: a derived group is clever right up until
 * it is wrong, and a wrong group silently omits the role that owns the
 * decision, which is the failure this project exists to prevent.
 */

import topicData from "../../schemas/topics.json" with { type: "json" };
import type { Diagnostics } from "../util/diagnostics.ts";
import type { Role } from "./types.ts";
import { nearest } from "./vocabulary.ts";

export interface Topic {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  /** What an operator actually says, including the words they use instead of the right ones. */
  readonly keywords: readonly string[];
  readonly roles: readonly string[];
}

export const TOPICS: readonly Topic[] = topicData.topics as readonly Topic[];

export function findTopic(id: string): Topic | undefined {
  return TOPICS.find((t) => t.id === id);
}

export function topicIds(): string[] {
  return TOPICS.map((t) => t.id).sort();
}

/** Suggest the nearest topic id, for an unknown `--topic`. */
export function suggestTopic(value: string): string {
  const n = nearest(value, topicIds());
  return n ? ` Did you mean "${n}"?` : ` Known topics: ${topicIds().join(", ")}.`;
}

/**
 * The roles a topic names, resolved against the catalogue.
 *
 * Unresolvable ids are returned rather than dropped. A topic that quietly
 * shrinks because a role was renamed is a topic that stops reaching the role
 * that owns the decision, and nothing would report it.
 */
export function resolveTopic(
  topic: Topic,
  byId: ReadonlyMap<string, Role>,
): { roles: Role[]; missing: string[] } {
  const roles: Role[] = [];
  const missing: string[] = [];
  for (const id of topic.roles) {
    const role = byId.get(id);
    if (role) roles.push(role);
    else missing.push(id);
  }
  return { roles, missing };
}

/**
 * Active roles that no topic names, and so cannot be reached by keyword.
 *
 * Reported by `se topics`, not by `se validate`. Coverage is a question an
 * author asks, not a defect: a specialist nobody arrives looking for by name is
 * legitimately keyword-unreachable, and emitting a warning per such role would
 * bury the findings that do mean something.
 */
export function uncoveredRoles(byId: ReadonlyMap<string, Role>): string[] {
  const covered = new Set(TOPICS.flatMap((t) => t.roles));
  return [...byId.values()]
    .filter((r) => r.enabled && r.status === "active" && !covered.has(r.id))
    .map((r) => r.id)
    .sort();
}

/**
 * Catalogue-wide topic integrity. Every finding is an error: a topic that names
 * a role which does not exist would route work to a receiver the host cannot
 * reach, and a keyword claimed twice resolves by declaration order, which is
 * not a decision anyone made.
 */
export function checkTopics(byId: ReadonlyMap<string, Role>, diags: Diagnostics): void {
  const file = "schemas/topics.json";
  const seenIds = new Set<string>();
  const keywordOwner = new Map<string, string>();
  const covered = new Set<string>();

  for (const topic of TOPICS) {
    if (seenIds.has(topic.id)) {
      diags.error({
        code: "topic/duplicate-id", file, key: topic.id,
        message: `Topic id "${topic.id}" is declared more than once.`,
      });
    }
    seenIds.add(topic.id);

    if (topic.roles.length === 0) {
      diags.error({
        code: "topic/empty", file, key: topic.id,
        message: `Topic "${topic.id}" names no roles, so selecting it installs nothing.`,
      });
    }

    const { missing } = resolveTopic(topic, byId);
    for (const id of missing) {
      diags.error({
        code: "topic/unknown-role", file, key: topic.id,
        message: `Topic "${topic.id}" names role "${id}", which does not exist.`,
        hint:
          "A topic that silently shrinks stops reaching the role that owns the decision. " +
          "Update the topic when a role is renamed or retired.",
      });
    }
    for (const id of topic.roles) covered.add(id);

    const duplicateMembers = topic.roles.filter((id, i) => topic.roles.indexOf(id) !== i);
    for (const id of new Set(duplicateMembers)) {
      diags.error({
        code: "topic/duplicate-member", file, key: topic.id,
        message: `Topic "${topic.id}" names role "${id}" twice.`,
      });
    }

    if (topic.keywords.length === 0) {
      diags.error({
        code: "topic/no-keywords", file, key: topic.id,
        message: `Topic "${topic.id}" has no keywords, so nothing an operator types can reach it.`,
      });
    }

    /*
     * A keyword must identify one topic. Two topics claiming "token" would make
     * the routing ambiguous at exactly the moment it is needed, and the
     * resolution would depend on declaration order -- which is not a decision
     * anyone made.
     */
    for (const raw of topic.keywords) {
      const keyword = raw.toLowerCase().trim();
      const owner = keywordOwner.get(keyword);
      if (owner !== undefined && owner !== topic.id) {
        diags.error({
          code: "topic/ambiguous-keyword", file, key: keyword,
          message: `Keyword "${keyword}" is claimed by both "${owner}" and "${topic.id}".`,
          hint:
            "A keyword must resolve to one topic. Give the shared concern its own topic, " +
            "or make each keyword specific to the job it names.",
        });
      }
      keywordOwner.set(keyword, topic.id);
    }
  }

}
