/**
 * The identity to record against something a person did — who added a member,
 * for instance.
 *
 * Their verified address where one is known, as `git:<email>`: the one form a
 * clone, a GitHub sign-in and a Google sign-in all share, and the form managers
 * are identified by. A GitHub id means nothing to anyone reading the roster, and
 * the same person arriving through Google would not match it. The actor's own
 * key is the fallback for a sign-in that revealed no address.
 */
export function recordedKey(actor) {
  const email = String(actor?.email || '').trim().toLowerCase();
  return email ? `git:${email}` : (actor?.key || null);
}
