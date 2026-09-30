---
name: Paysync
description: M-Pesa reconciliation workspace; a bank ledger opened on a verification console.
colors:
  paper: "#ffffff"
  ink: "#000000"
  ink-quiet: "#595959"
  rule: "#e5e5e5"
  steel: "#ced3dc"
  navy: "#09234f"
  navy-hover: "#13306a"
  blue: "#384ce3"
  teal: "#1888a2"
  mint: "#eff5f0"
  sky: "#c4f0ff"
  danger: "#b3261e"
typography:
  figure:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "36px"
    fontWeight: 515
    lineHeight: 1.02
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Source Serif 4, Georgia, serif"
    fontSize: "36px"
    fontWeight: 515
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  section:
    fontFamily: "Uncut Sans, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Uncut Sans, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "0.02em"
  action:
    fontFamily: "Geist Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.02em"
rounded:
  none: "0px"
  control: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.paper}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.navy-hover}"
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 12px"
  workbench:
    backgroundColor: "{colors.mint}"
    rounded: "{rounded.none}"
    padding: "20px"
  tab:
    textColor: "{colors.ink-quiet}"
    typography: "{typography.action}"
    height: "52px"
---

# Design System: Paysync

## Overview

**Creative North Star: "The ledger and the console"**

Paysync is a bank ledger opened on a live verification console. Records sit on white, ruled paper: square, separated by 1px lines, never floating in cards. The day's position lives in one navy field at the top, with a faint grid of rules, like a console reading out the ledger. The world comes from the owner's chosen reference, Baselayer (styles.refero.design), adapted to a dense operations tool with free, self-hosted stand-in fonts.

It refuses the rounded-card SaaS dashboard: pill badges, stacks of shadowed cards, a filled accent button on every row, grey captions restating what the screen already says.

**Key Characteristics:**
- White paper canvas, ink text, one navy field (header and today's totals) with a 48px rule grid.
- Serif for figures and entry headings, sans for reading, mono uppercase for labels and actions.
- Square records and 1px rules; 4px corners only on controls.
- Status is a small square marker plus a mono word, never a pill.
- One navy filled button, only where something is committed (Allocate, Approve, Request).

## Colors

### Primary
- **Ledger Navy** (`#09234f`): the field (as a gradient to Registry Blue) and filled commit buttons. The active filter segment.
- **Registry Blue** (`#384ce3`): active signal only: the selected tab's underline, focus rings, counts, waiting status markers.

### Secondary
- **Network Teal** (`#1888a2`): done and verified status markers.
- **Danger** (`#b3261e`): failures, high-priority exceptions, money-moving requests, error text.

### Neutral
- **Paper** (`#ffffff`) canvas; **Ink** (`#000000`) text; **Ink Quiet** (`#595959`) secondary text (7:1 on paper).
- **Rule Gray** (`#e5e5e5`) row separators; **Steel** (`#ced3dc`) control and card borders.
- **Mint Paper** (`#eff5f0`) marks work in progress: open forms, the approval side panel, hovered rows.
- **Sky Paper** (`#c4f0ff`) quiet text on the navy field and text selection.

**The One Field Rule.** Navy owns exactly one region per screen (the masthead and totals, or the sign-in side). Everything else is paper.

## Typography

**Figure/heading:** Source Serif 4 at weight 515 (stand-in for Season). **Body:** Uncut Sans 400/500. **Labels and actions:** Geist Mono 500 uppercase (stand-in for Modern Era Mono). All three are OFL files in `src/fonts`, loaded with `next/font/local`; no font requests leave the app.

### Hierarchy
- **Figure** (36px/1.02, 24px on phones): today's totals. Currency as a small mono prefix.
- **Heading** (36px serif): the entry screens' form title; 28px for empty-state titles; the wordmark at 24px.
- **Section** (24px/500 sans): Settings and Security section heads, over a 1px ink rule.
- **Body** (16px/1.5): record titles at 17px, meta at 14px in Ink Quiet.
- **Label** (12px mono uppercase): table heads, field labels, console labels, status words.
- **Action** (13px mono uppercase): buttons, tabs, filters.

**The Figures Rule.** Money in tables is set in mono and right-aligned; money as a headline figure is serif. Never proportional sans for amounts in columns.

## Layout

Max width 1312px, 40px gutters (16px under 720px). A 4px base: 12px element gaps, 20px record padding, 32px panel padding, 48px between sections. Lists start with a 1px ink rule and separate rows with Rule Gray. Tables become two-column labelled records under 900px. Tabs scroll sideways on phones; filters do too. The current tab and approval filter live in the URL (`?view=`, `&status=`), so every view has a link and Back works.

## Elevation & Depth

Flat. No shadows anywhere. Depth comes from the navy field against paper, 1px lines, and Mint Paper behind work in progress.

**The Flat Ledger Rule.** If something needs to stand apart, give it a rule or a surface color, never a shadow.

## Shapes

Records, panels, request cards and tables are square (0px). Buttons, inputs, the account menu and filter groups take 4px. Status markers are 8px squares. Nothing is a pill.

## Components

### Buttons
- **Primary** (navy fill, paper text): commits only. Hover Navy Hover; active Registry Blue.
- **Default** (paper, Steel border, ink text): every other action. Hover darkens the border to ink.
- **Danger** (default with red text): revoking keys.
- **On field** (transparent, white rule): controls placed on the navy field.
- 40px tall, 44px on phones. Disabled at 50% with a not-allowed cursor; busy sets `aria-busy`.

### Inputs / Fields
Mono uppercase label above a 40px (44px on phones) input with a Steel border and 4px corners. Focus turns the border Registry Blue with a matching 1px outline.

### Navigation
The masthead holds the wordmark, "/ Organization" as the page's h1, and an account menu (name, role, switch organization, sign out). Below the field, a sticky paper tab rail: mono uppercase tabs, Registry Blue 2px underline on the current one, blue count chips for open exceptions and waiting approvals. Proper `tablist`/`tab`/`tabpanel` roles with arrow-key movement.

### Records (signature)
A three-column row: status (square marker and word), body (title, quiet meta with relative time, optional note), actions right-aligned. An open task (match, note, close, a guarded request) opens a Mint Paper workbench under the body.

### Request card (signature)
Two panes in one Steel frame. Left: status, action type, approvals counted, the summary, who asked and when it expires, extra reasons flagged in red, earlier decisions. Right on Mint Paper: "After approval" (or "Result") as a ruled key/value list of only the fields an approver needs, then Approve and Reject. A 2px danger top edge marks money-moving requests.

## Do's and Don'ts

### Do:
- **Do** keep records square and ruled; use Mint Paper for anything being edited.
- **Do** say a status as a marker plus one mono word ("Verified", "Waiting", "Part paid").
- **Do** show times relative ("2 days ago") with the exact East Africa time on hover.
- **Do** show payer-typed text in mono as plain data, and never in an approval's change list.
- **Do** keep copy to what the person needs to act: no captions that restate the screen.

### Don't:
- **Don't** use shadows, pills, rounded cards, or gradients outside the navy field.
- **Don't** put a filled button on every row; navy is for the commit.
- **Don't** use Registry Blue as a general button color; it marks the active thing.
- **Don't** put a label or kicker above a heading.
- **Don't** add a second navy region to a screen.
