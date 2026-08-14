/**
 * Who counts as the same person across two sessions.
 *
 * A reload gives the user a new session id, so session identity alone would
 * make an approval un-answerable the moment the tab is refreshed. What carries
 * across is the identity subject — the thing an IdP asserted and Keel verified.
 *
 * An anonymous session has no subject and so can never match a *different*
 * session. That is the point: anonymity means there is nothing to prove the
 * second visitor is the first one, and treating a guessed run id as proof would
 * hand one person's approval to another.
 *
 * Shared by the reattach and decide routes deliberately. Two ownership rules
 * that are meant to agree, written twice, eventually disagree.
 */

export type Owned = {
  readonly session_id: string;
  readonly subject: string | null;
};

export type Actor = {
  readonly id: string;
  readonly subject?: string;
};

export function sameActor(owned: Owned, actor: Actor): boolean {
  if (owned.session_id === actor.id) return true;
  return owned.subject !== null && owned.subject === actor.subject;
}
