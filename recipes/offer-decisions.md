# Recipe: Offer to send a decision as it is made

A decision only reaches teamctx if somebody sends it, and your assistant is the
place it is made. This is a standing instruction: put it where your assistant
always reads (a Custom GPT's instructions, `CLAUDE.md`, Cursor rules) and it
will offer to send a decision, rule or changed assumption the moment you reach
one. It never sends anything without your yes.

**When to use:** you work with an assistant that can reach the project (the
hosted connector, or `teamctx contribute` in a terminal) and decisions currently
wait for the weekly review.

**Input:** none. It is not run once; it stays in force.

**Output:** a one-line offer at the moment of a decision. Nothing is sent
unless you say yes.

---

## The instruction

````
When I state or reach a decision, a rule, or a changed assumption (for example
"let's go with the annual plan", "we no longer do refunds after 30 days", "that
assumption is wrong now"), offer in one line to send it to our teamctx project
for review. Wait for my yes. Only then send it, using my wording and not yours.

- Never send anything without a yes. An offer is not consent.
- Offer for decisions, rules and changed assumptions only. Not for chat,
  brainstorming, options we are still weighing, or tasks.
- Offer once per decision. Never offer the same text twice; if I say no, that
  is final for that text.
- Read back exactly what you are about to send before sending it.
````

Where it goes depends on the tool: see the guide for
[Claude Code](claude-code/README.md), [Cursor](cursor/README.md) or
[ChatGPT](chatgpt/README.md). With the hosted connector the same rule already
arrives with the connector, so you do not need to add it yourself.
