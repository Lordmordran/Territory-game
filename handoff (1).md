# Project Handoff — Territory/Base-Builder Game

This is a handoff from a design conversation in Claude (chat) to whoever picks this
up next (Claude Code or a human). It covers the game concept, what's already been
built and why, and what to do next. The full design doc and current prototype file
should be in this same folder — read those first, then this file for context on
*why* things are the way they are.

## Concept, one paragraph

A 2D grid-based base-builder where a single player builds an economy and defenses
on a randomly generated island map, and an AI opponent (not yet built) does the
same on its own island, then the two sides fight opportunistically once each has
enough saved up. Score is based on how hard-fought the match was against the AI
(not just how far the player got), feeding a leaderboard. Full mechanical detail
— resources, unit roster, research, win/loss conditions, scoring — is in
`game-design-doc.md` in this folder. That doc is the source of truth for game
rules; this file is about implementation status and process.

## Current state: Phase 1 prototype only

The only thing built so far is the **territory & economy loop** — no combat, no
AI opponent yet. File: `territory-prototype.jsx` (a self-contained React
component). What it does:

- Procedurally generated map: 3 islands (player's on the left half, a mirrored
  one on the right reserved for the future AI, one smaller neutral island in the
  middle) — see "Terrain generation" below for how.
- Claiming territory (costs wood, must border already-claimed land).
- Placing buildings from a bottom hotbar: House, Lumber Camp, Quarry, Iron Mine,
  Fishery (water-only, must connect to claimed land), Wall.
- Resource ticking (wood/stone/iron/food; platinum reserved for later, no
  gathering building for it yet — per design doc, it's meant to come from
  conquest/research, not basic gathering).
- Population cap (from Houses) gating how many worker-requiring buildings can be
  active.
- Construction takes real time (a progress bar), not instant.

## Design decisions made along the way (and why)

These came out of a lot of back-and-forth with the person on visual style — worth
knowing so you don't undo them without asking:

- **Flat checkerboard tile rendering, not smooth/blurred terrain.** Earlier
  iterations tried a smoothly-blended canvas-rendered terrain (looked more
  "realistic" but the person didn't like the blurriness) and a procedurally
  textured version with scattered tree/rock sprites (closer to a reference
  screenshot they shared from a game called Total Battle, but still not what
  they wanted). They explicitly asked to go back to flat colored squares with
  visible grid lines. **Don't reintroduce blur or canvas-based terrain rendering
  unless asked.**
- **Bottom hotbar for building selection, not a sidebar.** Also explicitly
  requested — a row of icon buttons along the bottom, with a semi-transparent
  "ghost" icon that follows the cursor to preview placement.
- **A "fading local grid" that used to follow the cursor was removed** once the
  checkerboard tiles came back, since it became redundant (the squares already
  show the grid). Just the cursor-follow ghost icon remains.
- **Performance matters — the person is on a lower-power Chromebook.** The
  biggest lag source was re-rendering the entire ~1,550-tile grid on every mouse
  move and every resource tick. Fixed by:
  - One mousemove/click handler on the whole map (computing which tile from
    cursor position) instead of a handler per tile.
  - The terrain grid is its own `React.memo`'d component that only re-renders
    when the map actually changes (claim/build/construction-complete), not on
    hover or resource ticks.
  - Each individual tile is also memoized, so even a grid update only
    re-renders the one tile that changed, not all 1,550.
  - **Keep this architecture.** If you add more interactive elements (unit
    sprites, AI base, etc.), follow the same pattern: isolate anything that
    updates frequently (hover, animation, ticking numbers) from anything large
    that rarely changes (the grid itself).

## Terrain generation (how the map is made)

Not simple circles — each of the 3 islands has a base radius that's modulated by
a sum of a few randomized sine waves as a function of angle from the island's
center, producing irregular lobes/bays/peninsulas instead of perfect circles.
Island *positions* are semi-randomized within constrained regions (left half /
right half / middle-top-or-bottom) so the left/right split stays consistent
while the exact shape and placement varies each generation. There's a retry loop
that regenerates the whole map if total land coverage comes out too sparse
(guards against a degenerate near-empty map). Grid is 50×31 tiles.

## Immediate next step

Per the design doc's own priority order, the next unbuilt piece is either:
1. **The AI opponent's side of the map** — mirroring the player's economy loop
   on the right-hand island (per-player heuristic AI layer per the design doc —
   NOT a live ML system; see design doc's "The AI" section for the
   client-side/server-side split), or
2. **Combat** — units, the opportunistic-attack timing, win/loss via core
   destruction.

The person hasn't picked which to tackle first yet — ask them, don't assume.

## Working style notes

- The person likes iterating by describing what's wrong/right about what they
  see rather than specifying exact technical requirements up front — expect a
  back-and-forth, visual-feedback-driven process, not a one-shot spec.
- They are not writing code themselves and don't want to; they're directing
  design and reacting to what gets built.
- They tend to say "let's revert to X" or "keep Y but change Z" — read recent
  turns carefully before making broad changes, since specific past decisions
  (like the ones listed above) were arrived at deliberately after trying
  alternatives.
