---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/app/sign-in/page.tsx"]
---

# Workspace (sign-in, dashboard, approvals)

Mode: Operate. Scope: every route in apps/web (sign-in, accept-invitation, workspace tabs).

Audience and task: office bookkeepers settling the exceptions queue at a desk, several times a day; approvers deciding pending actions, sometimes on a phone. Constraints: light theme only, self-hosted fonts, payer text shown as untrusted data, WCAG 2.2 AA.

## Direction contract

THESIS: The workspace is a bank ledger opened on a live verification console: white ruled paper for records, one navy console field for the day's position. Refuses the rounded-card SaaS dashboard (pill badges, a stack of floating cards, a green button on every row).

OWN-WORLD: Owner-pinned Baselayer. Paper white canvas; ink black text; Ledger Navy (#09234f to #384ce3) for the header and the totals console only; Registry Blue as active signal (current tab, focus, selection); 1px Rule Gray and Steel Rule lines; square records, 4px controls; serif figures (Source Serif 4 at 515), Uncut Sans body, Geist Mono uppercase for labels and actions. No shadows, no pills.

STORY: The bookkeeper sees today's position, then the next exception, settles it inline, and requests anything destructive with a reason; approvers read exactly what will change and decide.

FIRST VIEWPORT: Navy header bar (org, person, role menu); a navy console strip with four ruled cells (received, matched, unmatched, open exceptions) in serif figures; a mono tab rail; the exceptions ledger as ruled rows with a square status marker, summary, age, and quiet actions right-aligned; one navy filled button only where a commit happens.

FORM: Pinned by the owner (Baselayer); dealt seed ranked below the pin. Seed key 4ce86155. Raise from HyperCard stack (declined): every view is addressable, tabs and filters live in the URL.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
