// Authorization (spec 9.1). User groups are resolved through Slack and cached briefly.
import type { AuthLists } from './config.js';

export interface GroupLookup {
  /** All members of a user group (all pages). Throws on any failure. */
  usergroupMembers(groupId: string): Promise<string[]>;
}

export type Action = 'start' | 'end' | 'list';

export interface AuthDecision {
  allowed: boolean;
  /** For the audit line only; never shown to the user (DWA-AUTH-004). */
  reason: 'user' | 'group' | 'not_listed' | 'group_lookup_failed';
}

const LIST_TTL_MS = 60_000;
const WRITE_TTL_MS = 10_000;

export class Authorizer {
  private readonly cache = new Map<string, { members: Set<string>; at: number }>();

  constructor(
    private readonly groups: GroupLookup,
    private readonly now: () => number = Date.now,
  ) {}

  async decide(lists: AuthLists, userId: string, action: Action): Promise<AuthDecision> {
    if (lists.allowUsers.includes(userId)) return { allowed: true, reason: 'user' };
    const ttl = action === 'list' ? LIST_TTL_MS : WRITE_TTL_MS;
    let lookupFailed = false;
    for (const group of lists.allowUsergroups) {
      const members = await this.members(group, ttl);
      if (members === undefined) {
        lookupFailed = true;
        continue;
      }
      if (members.has(userId)) return { allowed: true, reason: 'group' };
    }
    // Fail closed: a failed lookup denies unless allow_users already allowed (DWA-AUTH-002).
    return { allowed: false, reason: lookupFailed ? 'group_lookup_failed' : 'not_listed' };
  }

  private async members(group: string, ttl: number): Promise<Set<string> | undefined> {
    const hit = this.cache.get(group);
    if (hit && this.now() - hit.at < ttl) return hit.members;
    try {
      const members = new Set(await this.groups.usergroupMembers(group));
      this.cache.set(group, { members, at: this.now() });
      return members;
    } catch {
      // A failed refresh never reuses an expired entry.
      this.cache.delete(group);
      return undefined;
    }
  }

  clear(): void {
    this.cache.clear();
  }
}
