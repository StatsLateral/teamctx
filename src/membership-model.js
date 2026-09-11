/**
 * How a person's part in a workstream is expressed.
 *
 * Deliberately not a product decision. One manager runs a project as a task
 * list, where somebody's role *is* whatever is assigned to them; another gives
 * a person a whole workstream to own and expects them to decide what the work
 * is. Both are real ways to run a team, and picking one for everybody would be
 * the product overruling the person running it.
 *
 * So the AI proposes a model per workstream with a reason, and the manager
 * accepts, changes or ignores it. What is stored is a label on the workstream,
 * not an enforcement: nothing here gates anything. The gate is the manager, and
 * the scope (#77) is the boundary.
 */

export const MEMBERSHIP_MODELS = ['assigned-tasks', 'named-role', 'workstream-position'];

export const MEMBERSHIP_DESCRIPTIONS = {
  'assigned-tasks': 'a member\'s part is the tasks assigned to them, and nothing wider',
  'named-role': 'a member holds a named role with responsibilities, and picks up tasks within it',
  'workstream-position': 'a member owns the workstream and decides what the work in it is',
};

export const DEFAULT_MEMBERSHIP = 'assigned-tasks';

/**
 * Read a model back, refusing anything unrecognised.
 *
 * A model comes from a language model, so an invented one is a live
 * possibility. Falling back to the narrowest of the three is the safe
 * direction: it claims the least about how the team is run, and a manager who
 * wanted more will say so.
 */
export function membershipModel(value) {
  const v = String(value ?? '').trim();
  return MEMBERSHIP_MODELS.includes(v) ? v : DEFAULT_MEMBERSHIP;
}

export function isKnownMembership(value) {
  return MEMBERSHIP_MODELS.includes(String(value ?? '').trim());
}

/** What to say about a proposed model, in words a manager would use. */
export function describeMembership(value) {
  return MEMBERSHIP_DESCRIPTIONS[membershipModel(value)];
}
