/**
 * What the Connected sources drawer shows while a project has no references
 * recorded yet (#168).
 *
 * Nothing here is read from a project. It is a picture of what the drawer holds
 * once an assistant or `teamctx import` records where context came from, in the
 * same shape: a source, what came from it, and the tasks it feeds. The names are
 * made up, and the drawer says so.
 */
export const ISSUES_URL = 'https://github.com/StatsLateral/teamctx/issues';

export const SAMPLE_SOURCES = [
  {
    name: 'Slack', mark: 'S', about: 'Channel threads worth keeping, summarised',
    items: [
      { title: '#launch-planning: pricing thread, Oct 6', meta: 'Slack · 12 messages · 10-06', tasks: ['1.1', '1.2'], context: 2 },
      { title: '#customers: renewal questions', meta: 'Slack · 7 messages · 10-04', tasks: ['2.3'], context: 1 },
    ],
  },
  {
    name: 'Notion', mark: 'N', about: 'Team pages stay theirs to edit; the summary here is refreshed when they change',
    items: [
      { title: 'Launch checklist', meta: 'Pages · 10-03', tasks: ['1.3', '1.4'], context: 2 },
      { title: 'Interview notes, September', meta: 'Pages · 09-29', tasks: ['2.1'], context: 1 },
    ],
  },
  {
    name: 'Google Drive', mark: 'G', about: 'Documents and decks the team already works in',
    items: [
      { title: 'Pricing one-pager (draft)', meta: 'Docs · 10-05', tasks: ['1.2'], context: 1 },
      { title: 'Customer research summary', meta: 'Slides · 10-01', tasks: ['2.1', '2.2'], context: 3 },
    ],
  },
  {
    name: 'Microsoft SharePoint', mark: 'M', about: 'A Microsoft 365 library: security pack, release notes',
    items: [
      { title: 'Security and compliance pack', meta: '/Sales/Security · 10-06', tasks: ['2.3'], context: 1 },
    ],
  },
];
