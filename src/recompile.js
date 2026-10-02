import { listWorkstreamIds, readWorkstream, writeWorkstreamMd } from './storage.js';
import { serializeToMd } from './context.js';
import { ancestorsOf, numberWorkstreams } from './model.js';

export function chainFor({ config, id, teamctxDir }) {
  const nums = numberWorkstreams(config);
  const named = (wid) => (config.workstreams || []).find(w => w.id === wid)?.name;
  return [...ancestorsOf(config, id), id].map(wid => {
    const ws = readWorkstream(wid, teamctxDir);
    return { ...ws, name: named(wid) || ws.name || wid, number: nums.get(wid) };
  });
}

export function recompileInheritors({ project, config, contributions = [], teamctxDir } = {}) {
  const ids = listWorkstreamIds(teamctxDir);
  for (const id of ids) {
    const chain = chainFor({ config, id, teamctxDir });
    const self = chain[chain.length - 1];
    writeWorkstreamMd(id, serializeToMd(self, self.name, '', contributions, { project, chain }), teamctxDir);
  }
  return ids;
}
