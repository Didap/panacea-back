import type { AuthenticatedUser } from '../types/authenticated-user';
import type { DelegationsService } from '../../modules/delegations/delegations.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns the user id whose data the actor is operating on right now.
 * If actingAs is unset, missing, or equal to actor.id, the actor is the subject.
 * Otherwise the actor must hold an active delegation FROM actingAs.
 */
export async function resolveSubject(
  actor: AuthenticatedUser,
  actingAs: string | null,
  delegations: DelegationsService,
): Promise<{ subjectUserId: string; viaDelegation: boolean }> {
  if (!actingAs || actingAs === actor.id) {
    return { subjectUserId: actor.id, viaDelegation: false };
  }
  if (!UUID_RE.test(actingAs)) {
    return { subjectUserId: actor.id, viaDelegation: false };
  }
  await delegations.requireActiveDelegation({ delegator: actingAs, delegate: actor.id });
  return { subjectUserId: actingAs, viaDelegation: true };
}
