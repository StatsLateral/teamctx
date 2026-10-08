import { esc } from './theme.js';

/** Everybody whose contribution touched a statement, by name. */
export const whoTouched = (node, contributions) => [...new Set(
  (node.sourceContributionIds || []).map(id => contributions[id]?.author).filter(Boolean),
)];

/**
 * What to paste into a fresh chat.
 *
 * Four versions of this have been wrong, each in a smaller way than the last.
 * The one before this said the right things in the wrong voice: it opened with
 * "Using teamctx", numbered its checks ahead of the question, and named the
 * statement's ancestors "the What" and "the Why". What came back was written in
 * those words — headings, field names, a walk back up the tree — to somebody who
 * had asked about one line on a page and does not care how it is stored.
 *
 * So the question comes first, in the words the person would use out loud, and
 * everything the assistant has to do is below it under a heading addressed to
 * the assistant. The checks are unchanged; they are just no longer the first
 * thing anybody reads.
 *
 * It says what to talk about and nothing about how to lay it out. An earlier
 * draft banned headings and bullet lists, which is the wrong lever: the problem
 * was never the shape of the answer but its subject — an assistant explaining
 * the data model instead of the work — and telling a model how to format itself
 * costs it the formatting it would have chosen well.
 */
export function promptFor({ node, tier, where, isProject, owner, repo, link, parent, pending }) {
  const place = isProject
    ? "the project's own context (not one part of the work)"
    : `the part of the work called "${where}"`;

  // Where it hangs, said in plain English. The lineage has to be here — an
  // assistant left to find the parents reads the whole project, and then answers
  // with the whole project — but labelling them by tier taught it to answer in
  // those labels too. A goal is a goal, whatever the file calls it.
  const lineage = tier === 'exception' && parent
    ? `It is an allowed exception to the rule "${parent.text}".`
    : '';

  const line = (...lines) => lines.filter(Boolean).join('\n');

  return [
    `Tell me more about ${tier === 'task' && node.key ? `task ${node.key}: ` : ''}"${node.text}".`,
    [lineage,
      'Answer in plain language — I want the context that matters, not a tour of how the project is organised.',
    ].filter(Boolean).join(' '),
    line(
      'Instructions for the AI agent:',
      `- Confirm you are connected to the repository ${owner}/${repo}. get_connect_url returns a URL containing the owner and repo. If it is a different one, stop and tell me, rather than answering from the project you are connected to.`,
      `- Find this, quoted word for word, in ${pending ? 'the pending review queue for ' : ''}${place}: "${node.text}". If it is not there, say so plainly rather than answering about the closest thing you can find.`,
      '- Then tell me about that one thing, the way a colleague would: why it is there, what it requires, and what is still open for it.',
      '- Do not explain how the project stores any of this, do not walk me back up the structure it sits in, and do not name its parts. Where something has not been decided yet, say so and move on.',
      '- Keep to this one thing. Do not summarise the rest of the project, list its other goals or tasks, or report what is open elsewhere, unless I ask.',
      link ? `- The page it came from: ${link}` : '',
    ),
  ].filter(Boolean).join('\n\n');
}

/**
 * The prompt, inside an attribute, with its newlines intact.
 *
 * A raw newline in an attribute value survives parsing, but it also breaks the
 * generated HTML across lines for no reason. `&#10;` keeps the markup on one
 * line and decodes back to the newline the clipboard needs.
 */
export const escAttr = (v) => esc(v).replace(/\n/g, '&#10;');


/**
 * What to paste into a fresh chat to approve or reject a waiting contribution.
 *
 * In the same shape as `promptFor`: the request first, in the words a person
 * would use, then everything the assistant has to do under a heading addressed
 * to it. A bare "Approve 1.2" told a fresh chat nothing — which repository,
 * that it is a teamctx review, which item, which tool — so it is all written
 * here, and nothing is shortened: the page may clip what it shows, never what it
 * copies.
 *
 * The item is named by its id, which every queued contribution has, and quoted
 * by its summary so a person reading the prompt knows which one it is.
 */
export function decidePrompt({ action, id, summary, owner, repo, link }) {
  const line = (...lines) => lines.filter(Boolean).join('\n');
  const find = [
    `- Confirm you are connected to the repository ${owner}/${repo}. get_connect_url returns a URL containing the owner and repo. If it is a different one, stop and tell me.`,
    `- Find the contribution with id ${id} among the ones waiting for review (list_pending_reviews). If it is not there, it has already been decided: say so and stop.`,
  ];
  if (action === 'approve') {
    return [
      `Approve this contribution that is waiting for my review: "${summary}".`,
      line(
        'Instructions for the AI agent:',
        ...find,
        '- Before approving, tell me in plain words what it will change, and anything it should be checked against: a decision or rule it contradicts, evidence against an assumption, what rests on an assumption it breaks.',
        '- If it contradicts a decision or rule already in place, ask me which one it replaces before approving. Do not choose for me.',
        `- Then approve it with review_approve, id ${id}, and tell me what changed.`,
        link ? `- The page it came from: ${link}` : '',
      ),
    ].join('\n\n');
  }
  return [
    `Reject this contribution that is waiting for my review: "${summary}".`,
    'Reason: <write your reason here>',
    line(
      'Instructions for the AI agent:',
      ...find,
      '- If the reason above is still "<write your reason here>", ask me for it. Do not make one up.',
      `- Then reject it with review_reject, id ${id}, and that reason, and tell me it is done. Nothing in the team's context changes.`,
      link ? `- The page it came from: ${link}` : '',
    ),
  ].join('\n\n');
}
