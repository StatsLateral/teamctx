# Assistant actions as icons: Claude, ChatGPT, Copilot and copy

**Date:** 2026-10-07
**Status:** Design confirmed in the demo conversation (UI fix 9 of a series); spec pending review
**Builds on:** the "Work on this in your assistant" design in the [agent-first project view spec](2026-10-04-agent-first-project-view-design.md) (section 6), [context in the assistant](2026-10-07-context-in-the-assistant-design.md)
**Prototype:** the internal prototype (synthetic data)
**Scope:** presentation only. What each action does is unchanged.

## Problem

The assistant block in a drawer showed four wide buttons: "Open in Claude", "Open in
ChatGPT", "Copy, then open Copilot" and "Copy full prompt". Three solid green buttons plus
one outlined button, each a sentence long, dominate a drawer whose main content is the task.
The same block now appears in the task drawer, the project drawer and every workstream
drawer, so the weight repeats.

## Goal

One compact row of recognisable icons that does exactly what the four buttons did, with the
label available on hover and to screen readers.

## Non-goals

- Changing any behaviour: the prompts, the deep links, the copy rules, the connected / paste
  switch and "See the prompt first" are as specified in the agent-first spec (section 6).
- Adding more assistants. Others are reached with the copy icon ("works in any chatbot").
- Changing the text of the prompts.

## Design

### 1. The row

Inside the existing assistant block, below the connected / paste switch:

```
Open in  [ Claude ] [ ChatGPT ] [ Copilot ]  |  [ copy ]
```

- A small caption **"Open in"**, then three icon buttons, a thin divider, then the copy icon.
- **Claude, ChatGPT and Copilot** use the assistants' own marks. ChatGPT uses the OpenAI
  mark. Claude and Copilot keep their brand colours; the OpenAI mark follows the page's text
  colour so it stays visible in dark mode.
- **Copy** is a plain two-sheets glyph in the page's text colour.
- Each button is a 42px rounded square with a thin border on the card colour. Hover and
  keyboard focus show the accent border and a soft accent ring.
- The row wraps on narrow screens; icons keep their size.

### 2. Names, tooltips and accessibility

| Icon | Tooltip and accessible name | Does (unchanged) |
|------|-----------------------------|------------------|
| Claude | "Open in Claude" | Opens Claude with the short prompt prefilled (connected mode), or copies the full prompt and opens Claude (paste mode) |
| ChatGPT | "Open in ChatGPT" | Same for ChatGPT |
| Copilot | "Copy the prompt, then open Copilot" | Copies, then opens Copilot (Copilot cannot be prefilled by link) |
| Copy | "Copy full prompt" with tooltip "Copy the full prompt (works in any chatbot)" | Copies the full prompt |

- Every control is a real `<button>` with an `aria-label`; the icon itself is decorative.
- Focus order is left to right; Enter and Space activate. The tooltip is the browser `title`
  (no tooltip library).
- A toast confirms a copy ("Prompt copied. Paste it into Copilot.") exactly as today. The
  note under the row says "Copilot cannot be prefilled by link, so its icon copies the
  prompt first", so the one non-obvious behaviour is still stated in words.

### 3. Where it appears

Every drawer that has the assistant block: the task drawer, the project drawer and each
workstream drawer, so the three look and behave the same.

### 4. Why icons

- A person who uses an assistant recognises its mark faster than a sentence, and the row
  takes a fraction of the height, so the task details stay in view.
- The mark sits next to a label on hover, so nothing is lost for someone unfamiliar with it.
- It scales: if another assistant is added later, it is one more icon, not another wide button.

### 5. Logos and brand terms

The demo uses the marks from two public icon sets: simple-icons (Claude and OpenAI) and
the LobeHub icon set (the Microsoft Copilot mark, which simple-icons does not carry). They
are embedded as inline SVG, with no runtime request to a third party.

Before shipping beyond a demo, check each company's brand guidelines for use of its logo as a
link to its product. Using a logo to mean "open this product" is the common use, but terms
differ and some ask for a specific colour or clear space. If a guideline is not met, fall
back to the product's name as text beside a neutral icon for that assistant only.

## Existing open source first

- **Marks:** use the maintained public icon sets named above (simple-icons, LobeHub icons)
  rather than redrawing logos by hand. Embed only the three SVGs needed, not the packages.
- **Icon library:** an icon system (Lucide, Heroicons) is not needed for one copy glyph; add
  one only if the page grows many icons.
- **Tooltips:** the browser `title` is enough for this; a tooltip library is not.

## Changes

- `src/views/project.js` and its drawer markup: replace the four buttons with the icon row;
  inline the three SVG marks and the copy glyph; keep the `data-go` actions and their handlers.
- CSS: `.chatico` (button), the divider and the row's wrap rules, in light and dark themes.
- No change to the prompt builders, deep-link construction, scope handling or connector.

## Testing

- View test: each assistant block renders three assistant icon buttons and a copy button, each
  with the labels in the table, and no text buttons for these actions.
- Behaviour test (DOM): clicking each icon, including its inner SVG, triggers the same action
  as the old button: Claude and ChatGPT open the right URL (connected mode: short prompt;
  paste mode: full prompt copied first), Copilot copies then opens, copy copies the full prompt.
- Accessibility check: every control is focusable, has an accessible name, and activates with
  Enter and Space.
- Theme check: the row is legible in light and dark mode (the OpenAI mark uses the text colour).
- Layout check: at phone width the row wraps without clipping.
- Regression: the connected / paste switch, the note and "See the prompt first" are unchanged.

## Open questions

1. Is an "Open in" caption needed, or are the marks self-explanatory? The prototype keeps the
   caption for clarity; it is easy to drop.
2. Should the user be able to choose a preferred assistant once and see only that icon
   (plus copy)? Deferred; the row is small enough not to need it.
