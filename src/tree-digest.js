/**
 * What just went into a project's context, in a form a person can hear back.
 *
 * The founding contribution is usually a long conversation the manager pasted
 * in, and what comes back is a summary line and a list of typed operations —
 * neither of which says what the project's context now *is*. So the one person
 * who could correct it has no way to check it, at the one moment when checking
 * is cheap.
 *
 * This is the whole tree, trimmed: enough for an assistant to read back in a few
 * sentences, not so much that it repeats the conversation the manager just had.
 */

const LIMITS = { whys: 8, whats: 4, hows: 3, chars: 160 };

function trim(text, chars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > chars ? `${s.slice(0, chars - 1).trimEnd()}…` : s;
}

/**
 * `{ whys: [{ text, whats: [{ text, hows: [text] }] }], totals, more }`.
 *
 * `totals` counts everything, including what was left out, so the assistant can
 * say "and four more" rather than implying the list is the whole tree.
 */
export function digestTree(tree, limits = {}) {
  const { whys: maxWhys, whats: maxWhats, hows: maxHows, chars } = { ...LIMITS, ...limits };
  const allWhys = tree?.whys || [];

  const totals = { whys: allWhys.length, whats: 0, hows: 0 };
  for (const why of allWhys) {
    const whats = why?.whats || [];
    totals.whats += whats.length;
    for (const what of whats) totals.hows += (what?.hows || []).length;
  }

  const whys = allWhys.slice(0, maxWhys).map(why => ({
    text: trim(why?.text, chars),
    whats: (why?.whats || []).slice(0, maxWhats).map(what => ({
      text: trim(what?.text, chars),
      hows: (what?.hows || []).slice(0, maxHows).map(how => trim(how?.text, chars)),
    })),
  }));

  return {
    whys,
    totals,
    // True when anything was left out at any level, so a caller never presents a
    // trimmed list as the whole of it.
    more: totals.whys > whys.length
      || allWhys.some(why => (why?.whats || []).length > maxWhats
        || (why?.whats || []).some(what => (what?.hows || []).length > maxHows)),
  };
}
