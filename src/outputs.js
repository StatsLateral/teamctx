/**
 * What has been produced on a task, and where each piece stands (#197).
 *
 * Pure: the caller reads the files and says who is looking. An output is
 * written once and never changed, so where it stands is read off what exists
 * rather than stored on it.
 */

/**
 * `state` for each output: accepted once an approval names it, submitted while
 * a waiting item names it, otherwise working — which is also where a rejected
 * one goes back to, so it can be worked on and sent again.
 */
export function outputStates(saved, { approvals = {}, waiting = new Set() } = {}) {
  const accepted = new Set(Object.values(approvals || {}).flatMap(a => (Array.isArray(a?.outputs) ? a.outputs : [])));
  return saved.map(o => ({
    ...o,
    state: accepted.has(o.id) ? 'accepted' : waiting.has(o.id) ? 'submitted' : 'working',
  }));
}

/**
 * The outputs on one task as a particular reader may see them, newest first.
 *
 * Everyone who can see the task sees its outputs. A name nobody on the roster
 * answers to is shown as "someone", as in the task history. The reason a
 * submission was turned down is the author's and the manager's: it is
 * feedback on one person's work, and is shown only while the output is back to
 * working, not once it has been sent again or accepted. Whoever the task is
 * assigned to reads it too, whatever the source of the work: they are the one
 * who carries it on.
 */
/** The most recent time this output was sent back, or null. */
export function latestRejection(rejected, outputId) {
  return (rejected || [])
    .filter(r => Array.isArray(r?.outputs) && r.outputs.includes(outputId))
    .sort((a, b) => String(b.rejectedAt || '').localeCompare(String(a.rejectedAt || '')))[0] || null;
}

export function outputsForReader({ outputs, rejected = [], actorKeys = [], isManager = false, assigned = false, canSee = () => true }) {
  const mine = new Set((actorKeys || []).filter(Boolean));
  const latestReason = (id) => latestRejection(rejected, id);
  return [...outputs]
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || b.id.localeCompare(a.id))
    .map(o => {
      const own = Boolean(o.author?.key && mine.has(o.author.key));
      const name = o.author?.name || null;
      const r = o.state === 'working' && (isManager || assigned || own) ? latestReason(o.id) : null;
      return {
        id: o.id,
        title: o.title,
        body: o.body,
        notes: o.notes || null,
        prompt: o.prompt || null,
        basedOn: o.basedOn || null,
        at: o.at || null,
        state: o.state,
        author: isManager || (name && canSee(name)) ? name : 'someone',
        mine: own,
        turnedDown: r ? { reason: r.reason || null, at: r.rejectedAt || null } : null,
      };
    });
}
