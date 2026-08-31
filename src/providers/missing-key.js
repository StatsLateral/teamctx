import { getCurrentSession } from '../session-context.js';

/**
 * What to tell someone whose request has no AI key.
 *
 * The advice differs completely by surface, and giving the wrong one sends
 * people to fix the wrong thing. "Add it to your .env file" is right on a
 * laptop and meaningless to a member reaching the project through a chat
 * client — they have no file and no shell, and acting on it means asking
 * whoever runs the server to set a process-wide key, which would put every
 * project on one credential with no attribution.
 */
export function missingKeyMessage(envVar, provider = 'your AI provider') {
  if (!getCurrentSession()) {
    return `${envVar} not set. Add it to your .env file or shell environment.`;
  }
  return `No ${provider} key is available for this request. `
    + 'Either set your own at /settings on this deployment, or ask the project manager '
    + 'to share one with the project from that same page. '
    + `(A server-wide ${envVar} is not the fix — keys are per user and per project.)`;
}
