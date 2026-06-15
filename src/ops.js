function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function newHow({ text, summary }, contributionId) {
  return { id: uid(), text: String(text ?? ''), sourceContributionIds: [contributionId], summary: String(summary ?? '') };
}

function newWhat({ text, summary, hows }, contributionId) {
  return {
    id: uid(), text: String(text ?? ''), sourceContributionIds: [contributionId], summary: String(summary ?? ''),
    hows: (hows || []).map(h => newHow(h, contributionId)),
  };
}

function newWhy({ text, summary, whats }, contributionId) {
  return {
    id: uid(), text: String(text ?? ''), sourceContributionIds: [contributionId], summary: String(summary ?? ''),
    whats: (whats || []).map(w => newWhat(w, contributionId)),
  };
}

function findStatement(workstream, id) {
  for (const why of workstream.whys) {
    if (why.id === id) return { node: why, tier: 'why' };
    for (const what of why.whats) {
      if (what.id === id) return { node: what, tier: 'what' };
      for (const how of what.hows) {
        if (how.id === id) return { node: how, tier: 'how' };
      }
    }
  }
  return null;
}

function appendContrib(stmt, contributionId) {
  return { ...stmt, sourceContributionIds: [...stmt.sourceContributionIds, contributionId] };
}

function applyAdd(workstream, op, contributionId) {
  if (op.type === 'addWhy') {
    return { ...workstream, whys: [...workstream.whys, newWhy(op, contributionId)] };
  }
  if (op.type === 'addWhat') {
    const idx = workstream.whys.findIndex(w => w.id === op.parentWhyId);
    if (idx === -1) return workstream;
    const why = workstream.whys[idx];
    return { ...workstream, whys: workstream.whys.map((w, i) => i === idx ? { ...why, whats: [...why.whats, newWhat(op, contributionId)] } : w) };
  }
  if (op.type === 'addHow') {
    let whyIdx = -1, whatIdx = -1;
    for (let wi = 0; wi < workstream.whys.length; wi++) {
      const ti = workstream.whys[wi].whats.findIndex(t => t.id === op.parentWhatId);
      if (ti !== -1) { whyIdx = wi; whatIdx = ti; break; }
    }
    if (whyIdx === -1) return workstream;
    const why = workstream.whys[whyIdx];
    const what = why.whats[whatIdx];
    const nextWhat = { ...what, hows: [...what.hows, newHow(op, contributionId)] };
    const nextWhy = { ...why, whats: why.whats.map((t, i) => i === whatIdx ? nextWhat : t) };
    return { ...workstream, whys: workstream.whys.map((w, i) => i === whyIdx ? nextWhy : w) };
  }
  return workstream;
}

function applyEdit(workstream, op, contributionId) {
  if (!findStatement(workstream, op.id)) return workstream;
  const updateNode = node => ({ ...appendContrib(node, contributionId), text: String(op.text ?? node.text), summary: String(op.summary ?? node.summary) });
  return {
    ...workstream,
    whys: workstream.whys.map(why => {
      if (why.id === op.id) return { ...updateNode(why), whats: why.whats };
      return {
        ...why,
        whats: why.whats.map(what => {
          if (what.id === op.id) return { ...updateNode(what), hows: what.hows };
          return { ...what, hows: what.hows.map(how => how.id === op.id ? updateNode(how) : how) };
        }),
      };
    }),
  };
}

function applyDelete(workstream, op) {
  return {
    ...workstream,
    whys: workstream.whys
      .filter(why => why.id !== op.id)
      .map(why => ({
        ...why,
        whats: why.whats
          .filter(what => what.id !== op.id)
          .map(what => ({ ...what, hows: what.hows.filter(how => how.id !== op.id) })),
      })),
  };
}

export function applyOps(workstream, ops, contributionId) {
  const adds = ops.filter(o => o.type === 'addWhy' || o.type === 'addWhat' || o.type === 'addHow');
  const edits = ops.filter(o => o.type === 'editStatement');
  const deletes = ops.filter(o => o.type === 'deleteStatement');
  let next = workstream;
  for (const op of adds) next = applyAdd(next, op, contributionId);
  for (const op of edits) next = applyEdit(next, op, contributionId);
  for (const op of deletes) next = applyDelete(next, op);
  return next;
}
