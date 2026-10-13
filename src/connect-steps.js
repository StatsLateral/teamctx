/**
 * How to turn a project's connector on, for each chatbot.
 *
 * Said in two places from this one list: in the prompts, so an assistant that
 * finds it has no teamctx tools can tell the person exactly what to do in the
 * chatbot they are in, and on the page beside the buttons, before they click.
 *
 * Adding the connector is done once per chatbot; turning it on is done in each
 * new chat, which is the step a link cannot do for anybody. Menu names are the
 * chatbots' own and they move them, so the steps say what to look for and not
 * only where it is.
 */

export const CHATBOTS = [
  {
    id: 'claude',
    name: 'Claude',
    once: [
      'Open Customize, then Connectors.',
      'Click +, choose Add custom connector, and paste {address}.',
      'Click Add, then Connect, and sign in to teamctx. (On a Team or Enterprise plan an Owner adds it first, under Organization settings, then Connectors.)',
    ],
    each: ['Click + in the message box, choose Connectors, and turn teamctx on.'],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    once: [
      'Open Settings, then Apps (called Connectors in some versions), then Advanced settings, and turn on Developer mode.',
      'Back on that page, click Create. Give it a name such as teamctx, paste {address}, choose OAuth, tick the box that you trust it, and click Create.',
      'Sign in to teamctx when asked. (Developer mode needs a paid ChatGPT plan.)',
    ],
    each: ['Click + in the message box, choose More, then Developer mode, and turn the teamctx connector on.'],
  },
  {
    id: 'copilot',
    name: 'Copilot',
    once: [],
    each: ['Copilot at copilot.microsoft.com cannot add a custom connector. Use "Paste the context in" on the page instead.'],
  },
];

export const MENU_NOTE = 'Menu names change now and then. If you do not see one, look for Connectors or Apps in Settings.';

/** The address, or where to find it when this page was not given one. */
export const addressOr = (address) => address || 'the connector address shown under Settings on the project page';

/** One chatbot's steps as plain lines, numbered, with the address filled in. */
export function stepsFor(bot, address) {
  const once = bot.once.map((s, i) => `${i + 1}. ${s.replace('{address}', addressOr(address))}`);
  const each = bot.each.map(s => s);
  return { once, each };
}

/** The steps for every chatbot as prompt text, for the assistant to give only its own. */
export function stepsAsPromptText(address) {
  return CHATBOTS.map((bot) => {
    const { once, each } = stepsFor(bot, address);
    return [
      `${bot.name}:`,
      ...(once.length ? ['Once, to add the connector:', ...once] : []),
      ...(bot.id === 'copilot' ? each : ['Then, in each new chat:', ...each]),
    ].join(' ');
  }).join('\n');
}
