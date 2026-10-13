import { esc, navBar, shell } from './theme.js';

/**
 * Tips & Tricks: the page every tool result links to beside the project link.
 *
 * It is for a manager who has just connected an assistant and wants to know what
 * to say to it, and for the people they bring in. So it is written in what to
 * say, not in what to call: every prompt is a sentence to paste into a chat, and
 * no tool name appears where a person would have to learn it.
 *
 * Everything on it describes behaviour the tools have today. Where something is
 * not automatic — nothing here updates on a timer — it says so rather than
 * implying it.
 *
 * It is for signed-in people only. The route sends anybody else through sign-in
 * and back here, so the link a tool hands over still lands on this page.
 */

const EXTRA_CSS = `
.hero { margin: 1.2rem 0 1.6rem; }
.hero h1 { margin-bottom: .4rem; }
.lede { font-size: 1.08rem; line-height: 1.55; }
.toc { display: flex; flex-wrap: wrap; gap: .4rem .9rem; margin: 1rem 0 1.6rem; font-size: .92rem; }
.tip-grid { display: grid; gap: .8rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin: .8rem 0; }
.tip-grid .card { margin: 0; }
.say { display: flex; gap: .5rem; align-items: flex-start; margin: .35rem 0; }
.say code { flex: 1; white-space: normal; display: block; padding: .5rem .65rem; line-height: 1.45; }
.say button { flex: none; }
.tree { white-space: pre; overflow-x: auto; line-height: 1.5; padding: .8rem 1rem; }
.faq details { border-top: 1px solid var(--border, rgba(127,127,127,.25)); padding: .7rem 0; }
.faq summary { cursor: pointer; font-weight: 600; }
.faq details p { margin: .5rem 0 0; }
h2 { margin-top: 2.2rem; }
`;

/** A sentence to say to the assistant, with a button to copy it. */
const say = (text) => `<div class="say"><code>${esc(text)}</code><button type="button" class="btn copy" data-say="${esc(text)}">Copy</button></div>`;

const faq = (q, a) => `<details><summary>${q}</summary><p>${a}</p></details>`;

const SCRIPT = `(function(){document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('button.copy');if(!b)return;
var t=b.getAttribute('data-say'),done=function(){var o=b.textContent;b.textContent='Copied';setTimeout(function(){b.textContent=o},1400)};
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){});}});}());`;

/**
 * @param {object} args
 * @param {object|null} args.user    the signed-in person, if any, for the nav bar
 * @param {string|null} args.projectUrl  where "back to my project" goes, when the link named a project
 * @param {string|null} args.project     that project as `owner/repo`
 */
export const tipsPage = ({ user = null, projectUrl = null, project = null } = {}) => shell('Tips & Tricks', `
${navBar({ user, current: '/tips' })}
<div class="hero">
<h1>Lead a team of people and AI agents, from one source of truth</h1>
<p class="lede">Your team already works with AI. The problem is that every person's
assistant knows something different, and nobody can say what it was told.
teamctx gives you the one thing that fixes that: <strong>the decisions, rules and
assumptions you have approved</strong>, handed to every person's assistant and every
agent as the part their work needs. You set direction once. Everyone, human or AI,
starts from it, and nothing changes the team's context until you say so.</p>
${projectUrl ? `<p class="actions"><a class="btn" href="${esc(projectUrl)}">Back to ${esc(project)}</a></p>` : ''}
</div>

<nav class="toc" aria-label="On this page">
  <a href="#start">Start in a minute</a>
  <a href="#structure">How a project is built</a>
  <a href="#loop">The daily loop</a>
  <a href="#people">People</a>
  <a href="#agents">Agents</a>
  <a href="#fresh">Staying current</a>
  <a href="#tricks">Tips & tricks</a>
  <a href="#faq">FAQ</a>
</nav>

<h2 id="start">Get value in the first minute</h2>
<p class="muted">You do not need to learn anything. Say these to your assistant, in this order.</p>
<div class="card">
<ol style="line-height:1.7;padding-left:1.2rem;margin:0">
  <li><strong>Tell it what the project is for.</strong>
    ${say('Set up this project. The goal is to launch our new pricing by end of Q4, because our current plans lose us mid-size customers. Here is what we have decided so far: ...')}</li>
  <li><strong>Break the work into parts.</strong>
    ${say('Suggest how to organise this project into parts, then walk me through each one.')}</li>
  <li><strong>Give the work to someone.</strong>
    ${say('Add a task for Priya: draft the new pricing page copy, under the pricing part.')}</li>
  <li><strong>Bring your team in.</strong>
    ${say('Add priya@acme.com to the project, on the pricing part only, and give me the link to send her.')}</li>
</ol>
</div>
<p class="muted">Your first contribution is applied straight away, since nobody else could
review it. After that, what your team sends back waits for your approval.</p>

<h2 id="structure">How a project is built</h2>
<p>Three layers, and you can read the whole thing at a glance.</p>
<div class="card"><pre class="tree">Project                 the goal, and why it matters
│                       decisions, rules, exceptions, assumptions
│
├── 1  Pricing          a part of the work (a workstream)
│   │                   its own decisions and rules, on top of the project's
│   ├── 1.1  Packaging  parts can sit inside parts
│   │     └ tasks       who is doing what, and the brief to do it
│   └── tasks
│
└── 2  Launch
      └ tasks</pre></div>
<div class="tip-grid">
  <div class="card"><h3>The project</h3>
    <p class="muted">The goal and the reason for it, plus everything that holds for
    the whole team. Every part inherits it, so you say it once.</p></div>
  <div class="card"><h3>Workstreams</h3>
    <p class="muted">The parts of the work: a client, a product line, a campaign.
    Each holds only what is specific to it. Someone on a part sees everything
    inside it.</p></div>
  <div class="card"><h3>Tasks</h3>
    <p class="muted">Work with an owner. Every task can become a ready-to-use brief
    built from the context above it, so whoever picks it up, person or agent, starts informed.</p></div>
</div>
<p><strong>What the context is made of.</strong> What we <em>decided</em>, the
<em>rules</em> we work by, the <em>exceptions</em> allowed (always shown with the rule
they bend), and what we are <em>assuming</em>. When a new contribution would break an
assumption, you are told which decisions rest on it before you approve.</p>

<h2 id="loop">The daily loop</h2>
<div class="tip-grid">
  <div class="card"><h3>1. Your team asks</h3>
    ${say('What are my tasks?')}
    <p class="muted">The assistant reads their tasks and the context behind them together.</p></div>
  <div class="card"><h3>2. They get a brief and work</h3>
    ${say('Give me the prompt for task 1.1.')}
    <p class="muted">Done in their own AI, with the team's context already in it.</p></div>
  <div class="card"><h3>3. They send it back</h3>
    ${say('Here is what I found: ...')}
    <p class="muted">It goes to you for review. It does not change the shared context yet.</p></div>
  <div class="card"><h3>4. You approve</h3>
    ${say('What is waiting for my review?')}
    <p class="muted">Approve or reject each one. Approved work becomes context for everyone.</p></div>
</div>

<h2 id="people">Adding and removing people</h2>
<p>Everyone can work in the AI they already use. They do not need a GitHub account or to learn a new tool.</p>
<div class="card">
${say('Add priya@acme.com to the project.')}
${say('Add priya@acme.com, but only on the pricing part.')}
${say('Move Priya to the launch part instead.')}
${say('Mark Sam as an external advisor.')}
${say('Remove Sam from the project.')}
${say('Make jordan@acme.com a co-manager.')}
</div>
<ul style="line-height:1.7">
  <li><strong>After adding someone, ask for their link.</strong> They paste it into
    their assistant as a custom connector and sign in. That is the whole onboarding.</li>
  <li><strong>Limiting someone to parts of the project</strong> is enforced for people who
    sign in through teamctx. Someone with a clone of the repository can read all of it, so
    treat that as the exception and say who has one.</li>
  <li><strong>Removing someone takes them off the team.</strong> It does not remove their
    access to the GitHub repository. If they had it, withdraw it on GitHub too.</li>
  <li><strong>Co-managers</strong> approve exactly as you do. You can hand the project over entirely when you move on.</li>
  <li><strong>External people</strong> (advisors, contractors) are grouped apart on the team page. That changes how they are listed, not what they can reach.</li>
</ul>

<h2 id="agents">Running agents alongside people</h2>
<p>An agent is a job that works with nobody present, such as a nightly report or a
weekly competitor scan. It reads the same approved context as your people, so it
cannot drift from what you decided, and what it sends back is reviewed like anyone's.</p>
<ul style="line-height:1.7">
  <li><strong>Give it a token</strong> in <a href="/settings">Settings → Agents</a>: a name, the
    project, and optionally the parts of the work it may see. The token is shown once.</li>
  <li><strong>Keep it narrow.</strong> An agent limited to one part cannot read the rest.</li>
  <li><strong>It is capped.</strong> An agent can send 20 contributions a day, so a runaway job cannot flood your review queue.</li>
  <li><strong>Revoke it any time</strong> from the same page.</li>
</ul>

<h2 id="fresh">How the context stays current</h2>
<p>There is no timer and no hidden rewriting. Context changes when you approve something,
and everyone is on the new version the next time they ask.</p>
<ol style="line-height:1.7;padding-left:1.2rem">
  <li><strong>Work flows in.</strong> People and agents send what they learn. It waits for you.</li>
  <li><strong>You approve.</strong> The shared context updates, and each role's view is rebuilt from it.</li>
  <li><strong>Everyone is current.</strong> Assistants read the live context each time they start on a person's tasks, so nobody has to pull, refresh or be told.</li>
  <li><strong>Briefs follow.</strong> A task's brief is rebuilt when the context behind it has changed, and reused when it has not.</li>
</ol>
<div class="tip-grid">
  <div class="card"><h3>You choose how much waits</h3>
    <p class="muted">By default everything waits for you. You can let additions through and
    hold only edits and deletions. Say which, and the assistant will confirm the trade-off first.</p>
    ${say('Change my review setting so only edits and deletions wait for me.')}</div>
  <div class="card"><h3>Checkpoint before big changes</h3>
    <p class="muted">Freeze the whole project as a named version you can approve and go back to.</p>
    ${say('Create a snapshot called "before Q4 planning".')}</div>
  <div class="card"><h3>See how it is going</h3>
    <p class="muted">Contribution rhythm by person, how long reviews wait, which parts have gone stale, and how tasks flow.</p>
    ${say('Show me team stats. What is stalling?')}</div>
</div>

<h2 id="tricks">Tips & tricks</h2>
<div class="tip-grid">
  <div class="card"><h3>Ask before you decide</h3>
    <p class="muted">Answers come from your approved context, not the model's guesses.</p>
    ${say('What have we decided about discounts, and why?')}</div>
  <div class="card"><h3>Ask as a role</h3>
    ${say('How would the Head of Growth read this decision?')}</div>
  <div class="card"><h3>Show your working</h3>
    <p class="muted">Add the source of every statement to an answer.</p>
    ${say('What is our refund policy? Show the sources.')}</div>
  <div class="card"><h3>Hand over a decision with its reason</h3>
    ${say('Log this as a decision: we chose Postgres over Mongo because our data is relational.')}</div>
  <div class="card"><h3>Record an exception properly</h3>
    <p class="muted">Exceptions are always shown with the rule they bend.</p>
    ${say('Allow an exception to the 30-day payment rule for Acme, because of their fiscal year.')}</div>
  <div class="card"><h3>Park an assumption</h3>
    ${say('We are assuming the integration ships in March. Mark that as an assumption, owned by Priya.')}</div>
  <div class="card"><h3>Start every chat the same way</h3>
    <p class="muted">One question gives the assistant your tasks and the context behind them.</p>
    ${say('Where am I? What should I work on?')}</div>
  <div class="card"><h3>One project per chat</h3>
    <p class="muted">Each project is its own connector. Turn on only the one you mean in a given chat, and name each connector after its project.</p></div>
</div>

<h2 id="faq">Questions</h2>
<div class="faq">
${faq('Do my people need to learn teamctx?', 'No. They keep using Claude, ChatGPT or Copilot. They paste one link and sign in, then ask for their tasks in plain words.')}
${faq('Where does our data live?', 'In your own git repository. teamctx does not keep a copy of your team\'s context.')}
${faq('Can my team change the shared context without me?', 'Not by default. Everything they send waits for your approval. You can relax that for additions only, and the assistant will tell you what that means before it does.')}
${faq('What if two people send conflicting things?', 'Each one arrives as its own item for you to review, and you see what it touches. A contribution that would break an assumption says which decisions rest on it.')}
${faq('Does everyone need an AI key?', 'Only for the steps that call a model, such as asking questions or sending work back. Each person can add their own in Settings, or you can share the project\'s key. Reading tasks and context needs none.')}
${faq('I added a new project and the assistant is still on the old one.', 'Each project is a separate connector, and tools from several share the same names. Turn on the connector for the project you want in that chat, ideally only that one. Signing in to a link pasted into a message does not add a connector.')}
${faq('How do I undo an approval?', 'Everything is a commit in your repository, so any approval can be reverted there. Taking a snapshot before big changes gives you a clean point to return to.')}
${faq('Is it automatic?', 'The delivery is: once you approve, every assistant and agent reads the new version on its next start. The deciding is yours on purpose.')}
${faq('Can I remove someone completely?', 'Remove them from the project, then withdraw their access to the repository on GitHub if they had it. The first is done in a chat, the second only on GitHub.')}
</div>

<p class="muted" style="margin-top:2rem">${projectUrl ? `<a href="${esc(projectUrl)}">Back to ${esc(project)}</a> · ` : ''}<a href="/">What is teamctx</a></p>`, { extraCss: EXTRA_CSS, script: SCRIPT });
