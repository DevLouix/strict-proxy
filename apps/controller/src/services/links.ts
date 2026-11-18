/**
 * Operator-published links backed by Gatekeeper-protected sites.
 *
 * The controller decides what an account may open from its effective plan, the
 * same plan the Gatekeeper enforces at the site. Locked links are still listed
 * (without a usable URL) because "upgrade to see more" is only meaningful if
 * the account can see that more exists.
 *
 * An unlocked link is returned with a short-lived `sp_ticket` query parameter.
 * A browser cannot set the `x-strict-proxy-entitlement` header the Gatekeeper
 * expects, and a standing token in a URL would be a credential that leaks
 * through history and shared links — a ticket per request keeps the exposure to
 * its own TTL.
 */
import type { SubscriptionTier } from '@strict-proxy/types';
import { TIER_RANK, tierSatisfies } from './tiers.js';

/** Plans a gated link can require. `free` is not a purchasable gate. */
export const LINK_TIERS = ['standard', 'pro'] as const;
export type LinkTier = (typeof LINK_TIERS)[number];

/** Query parameter carrying the short-lived gate ticket. */
export const LINK_TICKET_PARAM = 'sp_ticket';

/** Input the admin API accepts when creating or updating a link. */
export interface LinkInput {
  title: string;
  url: string;
  description: string | null;
  requiredTier: LinkTier;
  active: boolean;
  sortOrder: number;
}

/** A validation failure the route can turn into a 400. */
export class LinkValidationError extends Error {}

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 500;

/**
 * Normalises a URL and refuses anything that is not browsable http(s).
 *
 * `javascript:` and `data:` URLs are why this is an allowlist rather than a
 * deny-list: a link row is rendered as something a user taps.
 */
export function parseLinkUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Validates an admin payload.
 *
 * With `partial`, only the fields present are validated and returned, which is
 * what PATCH uses. `required` fields are enforced on create.
 */
export function normalizeLinkInput(
  input: unknown,
  opts: { partial?: boolean } = {},
): Partial<LinkInput> {
  const body = (input ?? {}) as Record<string, unknown>;
  const out: Partial<LinkInput> = {};

  if (body.title !== undefined || !opts.partial) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title.length === 0 || title.length > MAX_TITLE) {
      throw new LinkValidationError(`title is required (1-${MAX_TITLE} characters)`);
    }
    out.title = title;
  }

  if (body.url !== undefined || !opts.partial) {
    const url = typeof body.url === 'string' ? parseLinkUrl(body.url) : null;
    if (!url) throw new LinkValidationError('url must be an absolute http(s) URL');
    out.url = url;
  }

  if (body.requiredTier !== undefined || !opts.partial) {
    const tier = typeof body.requiredTier === 'string' ? body.requiredTier.trim().toLowerCase() : '';
    if (!LINK_TIERS.includes(tier as LinkTier)) {
      throw new LinkValidationError('requiredTier must be standard or pro');
    }
    out.requiredTier = tier as LinkTier;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new LinkValidationError('description must be text');
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length > MAX_DESCRIPTION) {
      throw new LinkValidationError(`description must be at most ${MAX_DESCRIPTION} characters`);
    }
    out.description = description.length === 0 ? null : description;
  }

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new LinkValidationError('active must be a boolean');
    out.active = body.active;
  }

  if (body.sortOrder !== undefined) {
    const order = Number(body.sortOrder);
    if (!Number.isInteger(order) || order < -10_000 || order > 10_000) {
      throw new LinkValidationError('sortOrder must be an integer between -10000 and 10000');
    }
    out.sortOrder = order;
  }

  return out;
}

/** True when a link's required plan is above the account's effective plan. */
export function linkLockedFor(requiredTier: string, tier: SubscriptionTier): boolean {
  // A value this build does not understand is locked for everyone: an
  // unexpected requirement must never be read as "no requirement".
  if (!LINK_TIERS.includes(requiredTier as LinkTier)) return true;
  return !tierSatisfies(tier, requiredTier as LinkTier as SubscriptionTier);
}

/** Appends the short-lived gate ticket, or returns null when there is none. */
export function linkAccessUrl(url: string, ticket: string | null): string | null {
  if (!ticket) return null;
  try {
    const target = new URL(url);
    target.searchParams.set(LINK_TICKET_PARAM, ticket);
    return target.toString();
  } catch {
    return null;
  }
}

export interface LinkView {
  id: string;
  title: string;
  url: string;
  description: string | null;
  requiredTier: string;
  locked: boolean;
  accessUrl: string | null;
}

export interface LinksCatalogView {
  links: LinkView[];
  counts: { total: number; accessible: number; locked: number };
  upgrade: { tier: string; lockedCount: number; message: string } | null;
}

/** Cheap tier label used in the upsell sentence the client renders verbatim. */
function tierLabel(tier: string): string {
  return tier === 'pro' ? 'Pro' : tier === 'standard' ? 'Standard' : 'Free';
}

/**
 * Shapes the account's link feed and the upgrade hint.
 *
 * The cheapest plan that reveals at least one locked link is named, because
 * telling a free account to buy Pro when Standard already opens the missing
 * link is an upsell the customer cannot act on.
 */
export function buildLinksCatalog(
  rows: Array<{
    id: string;
    title: string;
    url: string;
    description: string | null;
    requiredTier: string;
  }>,
  tier: SubscriptionTier,
  ticket: string | null,
): LinksCatalogView {
  const links: LinkView[] = rows.map((row) => {
    const locked = linkLockedFor(row.requiredTier, tier);
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      description: row.description,
      requiredTier: row.requiredTier,
      locked,
      accessUrl: locked ? null : linkAccessUrl(row.url, ticket),
    };
  });

  const accessible = links.filter((link) => !link.locked).length;
  const lockedLinks = links.filter((link) => link.locked);
  const nextTier = lockedLinks.some((link) => link.requiredTier === 'standard')
    ? 'standard'
    : lockedLinks.length > 0
      ? 'pro'
      : null;

  return {
    links,
    counts: { total: links.length, accessible, locked: lockedLinks.length },
    upgrade:
      nextTier === null
        ? null
        : {
            tier: nextTier,
            lockedCount: lockedLinks.length,
            message:
              accessible === 0
                ? `${tierLabel(nextTier)} unlocks ${lockedLinks.length} link${lockedLinks.length === 1 ? '' : 's'}.`
                : `You can see ${accessible} of ${links.length} links. ${tierLabel(nextTier)} unlocks ${lockedLinks.length} more.`,
          },
  };
}

/** Exposed for tests: the rank table is what makes the gate deterministic. */
export function linkTierRank(tier: string): number {
  return TIER_RANK[(tier as SubscriptionTier) in TIER_RANK ? (tier as SubscriptionTier) : 'free'];
}
