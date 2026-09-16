# Game Design Doc (Working Draft)

*Living document — updated as decisions are made. "OPEN" = still undecided.*

## Core Concept
2D, grid-based, single-player base-builder with an AI opponent that adapts to how you play. Endless/level-based progression. Score reflects how hard-fought the battle was against the AI, not just how far you got — leaderboard ranks by toughness of fight, not raw level reached.

## Game Structure

### Home Screen (between levels)
- Research tab: spend research points earned from completed levels
- Research affects future battles (stat boosts / unlocks) but cannot be touched mid-battle
- Leaderboard: ranks players by score (see Scoring below)

### Level / Match Flow
1. Map is randomly generated (mostly water, islands)
2. **Build phase**: both player and AI simultaneously build on the same map under the same rules (AI gets no special exceptions except being AI-controlled)
3. Territory must be conquered/claimed before building — claiming grants a fixed number of buildable squares around the claimed area
4. Units cross water via boats
5. Construction is not instant — workers must physically travel to build sites; village houses cap population/worker capacity
6. Combat is opportunistic, not wave-based — AI attacks when it has saved enough currency for "a good enough attack" (player can presumably do the same)
7. Combat resolution is stat-based (unit strength/health/etc.), not directly player-controlled

## Units

### City Units (economy, passive)
- Resource generators (mines, farms, etc.) — placement rules TBD per resource (e.g. mines need ground, others can be on water if attached to existing structures)
- Storage buildings
- Village houses (population/worker cap)
- Barracks — each type produces ONE specific troop type automatically (no manual per-unit selection)

### Battle Units (4 combat types + defensive structures)
1. **Frontline/Tank** — high health, low damage, absorbs hits, leads the push
2. **Ranged/Archer** — lower health, hits from a distance, weak up close
3. **Raider** — fast, good for a quick/surprise strike, weaker overall
4. **Siege** — slow, expensive, strong specifically against buildings/core — likely the primary win-condition unit

### Defensive-only Structures
- Walls — block/slow enemy paths; built with cheap, non-valuable resources (not iron/platinum-tier)
- Anti-siege defense — a defensive structure/unit specifically countering siege units (role/details TBD)
- OPEN: is a defensive tower/turret needed in addition to walls, or do walls + anti-siege cover it?

### Upgrades = Research
- Research points (earned per completed level) unlock tiered upgrades per unit, e.g. "Frontline Tier 2" = more health, "Archer Tier 2" = more range/damage, etc.
- Gives research a clear, concrete purpose beyond vague stat boosts

## Resources
- **Wood** — basic buildings
- **Stone** — walls/defensive structures
- **Iron** — weapons/troops
- **Platinum** — high-tier upgrades
- **Food** — troop upkeep/training
- More complex/valuable structures cost more of the relevant valuable resource
- Troop training costs mostly food + a little iron

## Anti-Siege
- Defensive structure (not a trainable unit) that deals bonus damage specifically to Siege units
- Keeps counter logic simple and readable: Siege beats buildings, Anti-siege beats Siege, everything else handled by normal unit stats/walls — no extra combat stat system needed

## The AI — Two Layers
1. **Global/shared layer**: server-side, periodically updated (like a patch), NOT live/real-time. This is where genuine learning/ML can live — since updates are batched (not real-time), there's room to actually train a lightweight model on aggregated player data between updates, then push out a smarter base strategy pool to everyone.
2. **Per-player layer**: client-side, runs in the browser save file. Heuristic/stat-tracking system (not formal ML) — tracks patterns about the individual player (timing, counter-unit logic, defensive tendencies, what beats them) and picks smarter pre-built responses based on those stats. Chosen over real-time ML because it needs to be fast, predictable, and tunable, and true learning algorithms are impractical to run live in a browser.
- AI must follow the same build/territory rules as the player.
- **Strategic tension (draft)**: winning a level fast starves the AI of data about you. The AI doesn't intentionally throw or stall fights — instead, this emerges naturally: in early matches it has nothing to lose (it expects to lose anyway), so it's freer to experiment/test how you defend against different things. In later matches, once it's actually competitive and has a real shot at winning, it commits to winning for real rather than experimenting. Not hardcoded as an explicit "stall the player" behavior.

## Scoring / Leaderboard
- Score reflects how hard the AI fought, not how far you got — a brutal loss to a highly-adapted AI can outrank an easy win on a later level
- Balanced formula: rewards BOTH endurance (surviving longer against a tougher AI) AND efficiency (high kill ratio, fast decisive damage) — not weighted toward one over the other
- Inputs: AI's adapted difficulty rating at time of match, time taken/survived, units lost on both sides (kill ratio)
- OPEN: precise formula/weighting between the two factors — can be tuned once we have real match data to test against

## Progression
- Only Research points and the AI's learned behavior carry over between levels
- Everything else (buildings, resources, territory) resets each new level

---

## Win / Loss & Phase Timing
- **Build phase**: fixed 1-minute build-only window at the start of every level — no attacks (from either side) can happen during this window
- After the 1 minute: combat becomes available, but doesn't have to start immediately — it's still opportunistic (AI attacks when it's saved enough currency for a good attack; same applies to the player)
- **Win condition**: destroy the AI's core (main building)
- **Loss condition**: your core is destroyed

## OPEN QUESTIONS (next to resolve)

1. Precise scoring formula weighting — best resolved once we have actual gameplay data to tune against, rather than guessing exact numbers now
