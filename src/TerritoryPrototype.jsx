import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Trees, Mountain, Pickaxe, Wheat, Gem, Users, Home, Anchor, Flag, X, RotateCcw, LandPlot,
  Swords, Hourglass, Trophy, Skull, Ship, Tent, Lock, Check, Map,
} from "lucide-react";
import { submitMatchTelemetry } from "./supabaseClient.js";

// Bumped by hand on any change to the shape of a telemetry row — lets the
// aggregation side (once it exists) filter out rows from a schema that no
// longer matches, instead of silently mis-reading them.
const APP_VERSION = "0.1.0";

/* ---------------------------------------------------------------------- */
/* Tokens                                                                  */
/* ---------------------------------------------------------------------- */

const INK = "#2E2A1F";
const INK_MUTED = "#6B6250";
const PAGE_BG = "#EFE6D0";
const PANEL_BG = "#F7F1E1";
const PANEL_BORDER = "#C9B98E";
const WATER = "#6C8B93";
const WATER_DEEP = "#5A7981";
const LAND = "#9CA66B";
const LAND_DEEP = "#8B965A";
const CLAIM_TINT = "rgba(193, 120, 23, 0.22)";
const CLAIM_EDGE = "#C17817";
const RUST = "#8B3A2F";
const ENEMY_TINT = "rgba(139, 58, 47, 0.24)";
const FOREST = "#4C6B3E";

const SERIF = "'Spectral', Georgia, 'Times New Roman', serif";
const SANS = "'Inter', -apple-system, 'Segoe UI', sans-serif";

const GRID_COLS = 50;
const GRID_ROWS = 31;
const TILE_MIN = 6;
const TILE_MAX = 46;
const VIEW_GUTTER = 12;       // px kept clear around the map at the edges
const TC_COL = 5;
const TC_ROW = Math.floor(GRID_ROWS / 2);
const ENEMY_COL = GRID_COLS - 1 - TC_COL;   // mirror of the home core
const ENEMY_ROW = TC_ROW;

/* Match structure ----------------------------------------------------- */
const BUILD_PHASE_MS = 60000;   // build-only window at the start of every match
const CORE_MAX_HP = 100;

/* Combat tuning --------------------------------------------------------
   Numbers are first-pass guesses, not final — the design doc calls exact
   balance an open question to tune once there's real match data. */
const STEP_MS = 450;             // how long a sent army takes to cross one tile of its route
const AI_ATTACK_THRESHOLD = 30;  // total army power the AI wants before it commits
const FIELD_DAMAGE_SCALE = 0.25; // overall core-damage multiplier — deliberately weak; a few troops shouldn't take a keep down

// Floating HUD chip — solid enough to read over any terrain, no full-width strip
const CHIP = {
  background: PANEL_BG,
  border: `1px solid ${PANEL_BORDER}`,
  boxShadow: "0 1px 5px rgba(0,0,0,0.28)",
  pointerEvents: "auto",
};

/* ---------------------------------------------------------------------- */
/* Building + resource definitions                                        */
/* ---------------------------------------------------------------------- */

const BUILDING_DEFS = {
  house: {
    id: "house", name: "House", terrain: "land",
    cost: { wood: 20, stone: 10 }, buildMs: 4000, popBonus: 5,
    icon: Home, desc: "Shelters your workers. +5 population capacity.",
  },
  lumberCamp: {
    id: "lumberCamp", name: "Lumber Camp", terrain: "land",
    cost: { stone: 15 }, buildMs: 5000, produces: { resource: "wood", rate: 0.5 }, requiresWorker: true,
    icon: Trees, desc: "Gathers timber from the land. +0.5 wood/sec.",
  },
  quarry: {
    id: "quarry", name: "Quarry", terrain: "land",
    cost: { wood: 15 }, buildMs: 5000, produces: { resource: "stone", rate: 0.5 }, requiresWorker: true,
    icon: Mountain, desc: "Cuts stone from the ground. +0.5 stone/sec.",
  },
  ironMine: {
    id: "ironMine", name: "Iron Mine", terrain: "land",
    cost: { wood: 20, stone: 20 }, buildMs: 7000, produces: { resource: "iron", rate: 0.25 }, requiresWorker: true,
    icon: Pickaxe, desc: "Digs iron ore from the hills. +0.25 iron/sec.",
  },
  fishery: {
    id: "fishery", name: "Fishery", terrain: "water",
    cost: { wood: 20 }, buildMs: 6000, produces: { resource: "food", rate: 0.5 }, requiresWorker: true,
    icon: Anchor, desc: "Fishes the shallows. Must connect to your territory. +0.5 food/sec.",
  },
  // One barracks building, trainable for any troop type — which one is a
  // per-tile choice (tile.building.trains), not fixed by the def. Defaults to
  // Frontline on placement; click a built barracks to change it (see the
  // tp-troop-menu popup in the map render). Iron pays for the building itself
  // — the infrastructure — not for running it; see UNIT_DEFS below for why.
  barracks: {
    id: "barracks", name: "Barracks", terrain: "land",
    cost: { wood: 45, stone: 25, iron: 15 }, buildMs: 8000, trainable: true,
    icon: Tent, desc: "Trains troops — click it after building to choose which type.",
  },
};

// Combat units. Not tile-placeable — a barracks (BUILDING_DEFS.barracks)
// produces whichever of these it's currently set to train.
// Unit upkeep is food-only — iron pays for the barracks building itself, not
// per-troop. Keeping training on a single shared resource means one fishery's
// output is the only thing barracks compete over; splitting the cost across
// two resources (tried first) let a unit that's uniquely expensive on
// whichever one is scarce lock itself out entirely — see the
// training-fairness note on the game tick below either way, since even one
// shared resource still needs fair scheduling across multiple barracks.
const UNIT_DEFS = {
  tank: {
    id: "tank", name: "Frontline", hp: 40, power: 6,
    cost: { food: 11 }, trainMs: 6000,
    icon: SpearIcon, desc: "High health, leads the push, weak damage.",
  },
  archer: {
    id: "archer", name: "Archer", hp: 20, power: 8,
    cost: { food: 10 }, trainMs: 5000,
    icon: BowIcon, desc: "Hits hard from range, fragile up close.",
  },
  raider: {
    id: "raider", name: "Raider", hp: 15, power: 5,
    cost: { food: 8 }, trainMs: 4000,
    icon: HorseIcon, desc: "Fast and cheap, weakest one-on-one.",
  },
};

/* Economy tuning ------------------------------------------------------- */
const CLAIM_COST = 10;        // wood to claim one tile

const RESOURCE_META = {
  wood: { icon: Trees, label: "Wood", color: "#5C7A3A" },
  stone: { icon: Mountain, label: "Stone", color: "#7A7267" },
  iron: { icon: Pickaxe, label: "Iron", color: "#6B5B4A" },
  platinum: { icon: Gem, label: "Platinum", color: "#7C8FA6" },
  food: { icon: Wheat, label: "Food", color: "#B08927" },
};

const START_RESOURCES = { wood: 60, stone: 40, iron: 0, platinum: 0, food: 20 };

/* ---------------------------------------------------------------------- */
/* Map generation                                                         */
/* ---------------------------------------------------------------------- */

function generateTerrain() {
  const tiles = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill("water"));

  const jig = (n) => (Math.random() - 0.5) * n;

  // Mirrored layout: home + one outer island on the left, their mirror images on
  // the right, and one contested island in the middle. Kept well spaced so the
  // islands never merge into one landmass.
  // Outer islands hug the top/bottom edge and sit clear of the tall main islands.
  const outerY = (Math.random() < 0.5 ? 4 : GRID_ROWS - 5) + jig(1.5);
  const outerX = 12 + jig(2);
  const outerR = 2.9 + jig(0.6);

  // The two main islands are stretched vertically (rx < ry) so each player has a
  // long strip of coastline to build along; the rest stay roughly circular.
  const blobs = [
    { cx: TC_COL, cy: TC_ROW, rx: 3.6, ry: 8 },               // home island (left-centre)
    { cx: GRID_COLS - 1 - TC_COL, cy: TC_ROW, rx: 3.6, ry: 8 }, // rival island (right-centre)
    { cx: outerX, cy: outerY, rx: outerR, ry: outerR },       // left outer
    { cx: GRID_COLS - 1 - outerX, cy: GRID_ROWS - 1 - outerY, rx: outerR, ry: outerR }, // right outer (point mirror)
    { cx: GRID_COLS / 2 + jig(2.5), cy: TC_ROW + jig(6), rx: 3.3 + jig(0.7), ry: 3.3 + jig(0.7) }, // middle
  ];

  for (let y = 0; y < GRID_ROWS; y++) {
    for (let x = 0; x < GRID_COLS; x++) {
      for (const b of blobs) {
        const dx = (x - b.cx) / b.rx, dy = (y - b.cy) / b.ry;
        const jitter = (Math.random() - 0.5) * 0.14;
        if (Math.sqrt(dx * dx + dy * dy) + jitter < 1) {
          tiles[y][x] = "land";
          break;
        }
      }
    }
  }
  tiles[TC_ROW][TC_COL] = "land";       // safety net — home core
  tiles[ENEMY_ROW][ENEMY_COL] = "land"; // safety net — enemy core
  return tiles;
}

function neighbors8(r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      out.push([r + dr, c + dc]);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- */
/* Pathfinding — used to route a sent army from its own shore, around      */
/* whatever islands are in the way, to the enemy's flag.                   */
/* ---------------------------------------------------------------------- */

function octile(r1, c1, r2, c2) {
  const dx = Math.abs(c1 - c2), dy = Math.abs(r1 - r2);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

// Plain A*, 8-directional.
function aStarSearch(grid, start, end, isNavigable) {
  const [sr, sc] = start;
  const endKey = `${end[0]},${end[1]}`;
  const startKey = `${sr},${sc}`;
  const gScore = new Map([[startKey, 0]]);
  const fScore = new Map([[startKey, octile(sr, sc, end[0], end[1])]]);
  const cameFrom = new Map();
  const open = new Map([[startKey, [sr, sc]]]);
  const closed = new Set();

  while (open.size > 0) {
    let curKey = null, curPos = null, bestF = Infinity;
    for (const [k, pos] of open) {
      const f = fScore.get(k) ?? Infinity;
      if (f < bestF) { bestF = f; curKey = k; curPos = pos; }
    }
    open.delete(curKey);
    if (curKey === endKey) {
      const path = [curPos];
      let k = curKey;
      while (cameFrom.has(k)) {
        k = cameFrom.get(k);
        path.unshift(k.split(",").map(Number));
      }
      return path;
    }
    closed.add(curKey);
    const [r, c] = curPos;
    for (const [nr, nc] of neighbors8(r, c)) {
      if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
      const nKey = `${nr},${nc}`;
      if (closed.has(nKey)) continue;
      const tile = grid[nr][nc];
      if (!isNavigable(tile)) continue;
      const diagonal = r !== nr && c !== nc;
      const cost = diagonal ? Math.SQRT2 : 1;
      const tentativeG = (gScore.get(curKey) ?? Infinity) + cost;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, curKey);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + octile(nr, nc, end[0], end[1]));
        if (!open.has(nKey)) open.set(nKey, [nr, nc]);
      }
    }
  }
  return null;
}

function findPath(grid, start, end, isNavigable) {
  const path = aStarSearch(grid, start, end, isNavigable);
  return path ? { path } : null;
}

// Breadth-first search outward from `from` for the closest tiles matching
// `predicate` (by hop count, not true path distance — good enough for
// picking candidate dock/landing spots, which the real A* then validates).
function findCandidateTiles(grid, from, predicate, limit) {
  const [sr, sc] = from;
  const seen = new Set([`${sr},${sc}`]);
  let frontier = [[sr, sc]];
  const found = [];
  if (predicate(grid[sr][sc], sr, sc)) found.push([sr, sc]);
  while (frontier.length > 0 && found.length < limit) {
    const next = [];
    for (const [r, c] of frontier) {
      for (const [nr, nc] of neighbors8(r, c)) {
        if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
        const key = `${nr},${nc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (predicate(grid[nr][nc], nr, nc)) found.push([nr, nc]);
        next.push([nr, nc]);
      }
    }
    frontier = next;
  }
  return found;
}

// The full journey for one side's attack: home keep -> nearest own shore ->
// (sail, routing around any island in the way) -> nearest enemy shore ->
// (march straight to the flag, flattening any building in the way) ->
// enemy flag. Returns null if genuinely no route exists.
function computeAttackRoute(grid, attackerOwner) {
  const defenderOwner = attackerOwner === "player" ? "enemy" : "player";
  const homeCore = attackerOwner === "player" ? [TC_ROW, TC_COL] : [ENEMY_ROW, ENEMY_COL];
  const enemyCore = attackerOwner === "player" ? [ENEMY_ROW, ENEMY_COL] : [TC_ROW, TC_COL];

  // A "shore" tile just needs to touch land, full stop — NOT specifically
  // claimed/owned land. Early in a match only a small patch around the core
  // is actually claimed, nowhere near the coastline, so requiring the
  // neighbor to be owned finds no shore at all. Searching outward from each
  // side's own core naturally lands on that side's own island's coastline
  // anyway (the islands are never touching — see generateTerrain).
  const isShore = (t, r, c) => t.terrain === "water" && neighbors8(r, c).some(([nr, nc]) => grid[nr]?.[nc]?.terrain === "land");
  const isWater = (t) => t.terrain === "water";
  const isLand = (t) => t.terrain === "land";

  const dockCandidates = findCandidateTiles(grid, homeCore, isShore, 4);
  const landingWaterCandidates = findCandidateTiles(grid, enemyCore, isShore, 6);
  if (dockCandidates.length === 0 || landingWaterCandidates.length === 0) return null;

  // A dock is a water tile — need the land tile right next to it (on home
  // soil) where the boat actually launches from, and a real walked path from
  // the keep to get there (a dock a few tiles from the keep isn't adjacent to
  // it, so this can't just be prepended — it has to be pathed like anything
  // else, or the marker would visibly teleport).
  let muster = null, sea = null, embarkPoint = null, landingWater = null;
  outer:
  for (const dock of dockCandidates) {
    const embark = neighbors8(dock[0], dock[1]).find(([r, c]) => grid[r]?.[c]?.terrain === "land");
    if (!embark) continue;
    const musterAttempt = findPath(grid, homeCore, embark, isLand);
    if (!musterAttempt) continue;
    for (const lw of landingWaterCandidates) {
      const seaAttempt = findPath(grid, dock, lw, isWater);
      if (seaAttempt) { muster = musterAttempt; sea = seaAttempt; embarkPoint = embark; landingWater = lw; break outer; }
    }
  }
  if (!sea) return null;

  const landingSpot = neighbors8(landingWater[0], landingWater[1])
    .find(([r, c]) => grid[r]?.[c]?.terrain === "land");
  if (!landingSpot) return null;

  const land = findPath(grid, landingSpot, enemyCore, isLand);
  if (!land) return null;

  const route = [...muster.path, ...sea.path, ...land.path];
  const legBreak = muster.path.length + sea.path.length; // index in `route` where the enemy land leg begins
  // A plain array, not a Set — this object gets JSON-round-tripped through
  // the autosave (see saveMatch), and Set doesn't survive that (JSON.stringify
  // silently turns it into "{}", which then crashes stepAttack's .has() call
  // the next time an in-flight attack ticks after a reload).
  const buildingTiles = [];
  for (const [r, c] of land.path) {
    const t = grid[r][c];
    const isFlag = r === enemyCore[0] && c === enemyCore[1];
    if (t.building && !isFlag) buildingTiles.push(`${r},${c}`);
  }

  return { route, legBreak, buildingTiles };
}

function clearBuildingAt(grid, r, c) {
  const next = grid.map((row) => row.slice());
  next[r][c] = { ...next[r][c], building: null };
  return next;
}

function seedBase(grid, r, c, owner, defId) {
  grid[r][c].claimed = true;
  grid[r][c].owner = owner;
  grid[r][c].building = { defId, status: "active" };
  for (const [nr, nc] of neighbors8(r, c)) {
    if (grid[nr]?.[nc]?.terrain === "land") {
      grid[nr][nc].claimed = true;
      grid[nr][nc].owner = owner;
    }
  }
}

function buildInitialGrid() {
  const terrain = generateTerrain();
  const grid = terrain.map((row) =>
    row.map((t) => ({ terrain: t, claimed: false, owner: null, building: null }))
  );
  seedBase(grid, TC_ROW, TC_COL, "player", "townCenter");
  seedBase(grid, ENEMY_ROW, ENEMY_COL, "enemy", "enemyCore");
  return grid;
}

/* ---------------------------------------------------------------------- */
/* Claim/build rules — shared by the player's click handler and the AI    */
/* ---------------------------------------------------------------------- */

// Every tile a given owner could legally claim or build `tool` on right now.
// `tool` is a BUILDING_DEFS id, or the literal "claim".
function computeValidTiles(grid, owner, tool) {
  const valid = new Set();
  if (!tool) return valid;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const tile = grid[r][c];
      if (tool === "claim") {
        if (tile.terrain === "land" && !tile.claimed &&
            neighbors8(r, c).some(([nr, nc]) => grid[nr]?.[nc]?.owner === owner)) {
          valid.add(`${r},${c}`);
        }
        continue;
      }
      const def = BUILDING_DEFS[tool];
      if (!def) continue;
      if (tile.building) continue;
      if (def.terrain === "land") {
        // land buildings go on the owner's own claimed land
        if (tile.terrain !== "land" || tile.owner !== owner) continue;
      } else if (def.terrain === "water") {
        // water buildings go on open water touching the owner's territory
        // (water can't be claimed directly)
        if (tile.terrain !== "water") continue;
        const attached = neighbors8(r, c).some(([nr, nc]) => grid[nr]?.[nc]?.owner === owner);
        if (!attached) continue;
      }
      valid.add(`${r},${c}`);
    }
  }
  return valid;
}

function withClaimedTile(grid, r, c, owner) {
  const next = grid.map((row) => row.slice());
  next[r][c] = { ...next[r][c], claimed: true, owner };
  return next;
}

function withBuiltTile(grid, r, c, owner, def, trains) {
  const next = grid.map((row) => row.slice());
  next[r][c] = {
    ...next[r][c],
    claimed: true, owner, // a built tile becomes part of the owner's territory (matters for water)
    building: {
      defId: def.id, status: "building", startTime: Date.now(), buildMs: def.buildMs,
      ...(trains ? { trains } : {}), // which troop type a barracks starts set to (changeable later)
    },
  };
  return next;
}

function keyToRC(key) {
  const [r, c] = key.split(",").map(Number);
  return [r, c];
}

function pickRandom(set) {
  if (set.size === 0) return null;
  const items = Array.from(set);
  return items[Math.floor(Math.random() * items.length)];
}

// Claim compactly — the tile touching the most already-claimed neighbours —
// instead of a random point on the frontier. Purely random claiming spreads
// thin along the whole border and leaves territory full of gaps; greedily
// filling in the most-surrounded ones first grows it as a solid blob instead.
function pickClaimSpot(grid, owner, claimSpots) {
  let best = [], bestScore = -1;
  for (const key of claimSpots) {
    const [r, c] = keyToRC(key);
    const score = neighbors8(r, c).filter(([nr, nc]) => grid[nr]?.[nc]?.owner === owner).length;
    if (score > bestScore) { bestScore = score; best = [key]; }
    else if (score === bestScore) best.push(key);
  }
  return best[Math.floor(Math.random() * best.length)];
}

/* ---------------------------------------------------------------------- */
/* AI opponent — client-side heuristic, not live ML (see game-design-doc) */
/* ---------------------------------------------------------------------- */

const AI_TICK_MS = 1600;             // how often the AI reconsiders its next move, normally
const AI_CATCHUP_TICK_MS = 500;      // ...and how often while behind the player's own historical pace (see aiTargetsRef)
const AI_CLAIM_GROWTH_CHANCE = 0.3;  // chance it grabs land even when it could build instead
const AI_CLAIM_WOOD_BUFFER = CLAIM_COST * 3; // wood it likes to keep in reserve before "just growing"
// A barracks running flat out eats ~1.9 food/sec on average across the 4
// troop types (cost/trainMs) but one fishery only makes 0.5/sec — so several
// fisheries per barracks are needed just to keep training at a decent clip,
// not merely to avoid outright stalling. 5 was verified by simulation
// (see combat-system memory) to keep a barracks fed near its own pace
// instead of leaving it mostly idle waiting on food.
const AI_FISHERY_PER_BARRACKS = 5;
// Fallback targets for a brand-new player profile (no match history yet) —
// same numbers the AI used unconditionally before this existed.
const DEFAULT_TARGET_FIRST_BARRACKS_MS = 180000; // 3 minutes
const DEFAULT_TARGET_ATTACK_POWER = AI_ATTACK_THRESHOLD;

function countAIBuildings(grid) {
  const counts = {};
  let popCap = 5, popUsed = 0; // 5 = core base, matches the player's town-center base
  for (const row of grid) for (const tile of row) {
    if (tile.owner !== "enemy" || !tile.building) continue;
    const def = BUILDING_DEFS[tile.building.defId];
    counts[tile.building.defId] = (counts[tile.building.defId] ?? 0) + 1;
    if (!def) continue; // enemyCore isn't a BUILDING_DEFS entry
    if (tile.building.status === "active" && def.popBonus) popCap += def.popBonus;
    if (def.requiresWorker) popUsed += 1;
  }
  return { counts, popCap, popUsed };
}

// How many of the AI's own barracks are currently set to train each troop
// type — since barracks are now one generic building, "how many do I have of
// X" is a per-tile trains-assignment tally, not a building-def count.
function countAITrainsAssignments(grid) {
  const counts = { tank: 0, archer: 0, raider: 0 };
  for (const row of grid) for (const tile of row) {
    if (tile.owner === "enemy" && tile.building?.defId === "barracks" && tile.building.trains) {
      counts[tile.building.trains] += 1;
    }
  }
  return counts;
}

// Balance across the 3 troop types: whichever has the fewest barracks
// assigned to it gets the next one.
function pickAITrainType(trainsCounts) {
  const order = ["tank", "archer", "raider"];
  return order.reduce((a, b) => (trainsCounts[a] ?? 0) <= (trainsCounts[b] ?? 0) ? a : b);
}

function pickAIBuildSpot(spots) {
  const pool = Array.from(spots);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Simple, tunable priority order: keep population ahead of workers, get a
// second lumber camp going before anything else (wood feeds every other cost
// AND all claiming, so a single camp starves the rest of the build order),
// get a basic economy (2 of each gatherer) going, then get a first barracks
// up early rather than dead last — so it isn't sitting on economy for
// minutes before it can field anything — then round the economy out, then
// keep growing barracks and the fisheries that feed them in step with the
// core economy for the rest of the match, instead of hard-capping either
// and leaving the rest of the growth with nothing productive to do.
function pickAIBuilding(counts, popCap, popUsed) {
  if (popUsed >= popCap - 1) return "house";
  if ((counts.lumberCamp ?? 0) < 2) return "lumberCamp";
  const core = ["lumberCamp", "quarry", "ironMine"];
  const lowest = core.reduce((a, b) => (counts[a] ?? 0) <= (counts[b] ?? 0) ? a : b);
  if ((counts[lowest] ?? 0) < 2) return lowest;
  if ((counts.barracks ?? 0) < 1) return "barracks";
  if ((counts[lowest] ?? 0) < 3) return lowest;
  if ((counts.fishery ?? 0) < 1) return "fishery";

  // No more fixed cap from here on — barracks and the fisheries that feed
  // them keep growing in proportion to the core economy for as long as the
  // match runs, instead of plateauing while the rest of the economy (and
  // its wood/stone/iron) has nothing left to spend on. Fishery comes first
  // each round: a barracks with nothing to feed it just sits mostly idle
  // waiting on food (see UNIT_DEFS — troops are food-only), so it's not
  // worth adding another one until the existing ones can actually train at
  // a decent clip.
  const barracksCount = counts.barracks ?? 0;
  if ((counts.fishery ?? 0) < barracksCount * AI_FISHERY_PER_BARRACKS) return "fishery";
  if (barracksCount < Math.ceil((counts[lowest] ?? 0) / 2)) return "barracks";
  return lowest; // basics + military covered this round — keep growing the economy
}

// Pure decision function: given the current board + the AI's own resources,
// returns the one action it wants to take this tick, or null (saving up / stuck).
function decideAIAction(grid, resources, catchingUp) {
  const claimSpots = computeValidTiles(grid, "enemy", "claim");

  // Occasionally prioritize territory over building so the AI doesn't pack its
  // starting patch solid before ever expanding — skipped while it's behind
  // the player's own historical pace (see the AI catch-up section), since
  // every tick should go toward the actual bottleneck then, not a detour.
  if (!catchingUp && claimSpots.size > 0 && resources.wood >= AI_CLAIM_WOOD_BUFFER && Math.random() < AI_CLAIM_GROWTH_CHANCE) {
    const [r, c] = keyToRC(pickClaimSpot(grid, "enemy", claimSpots));
    return { type: "claim", r, c };
  }

  const { counts, popCap, popUsed } = countAIBuildings(grid);
  const defId = pickAIBuilding(counts, popCap, popUsed);
  const def = BUILDING_DEFS[defId];
  const spots = computeValidTiles(grid, "enemy", defId);
  const affordable = Object.entries(def.cost).every(([res, amt]) => resources[res] >= amt);
  if (affordable && spots.size > 0) {
    const [r, c] = keyToRC(pickAIBuildSpot(spots));
    const trains = def.trainable ? pickAITrainType(countAITrainsAssignments(grid)) : undefined;
    return { type: "build", defId, trains, r, c };
  }

  // Only claim as a fallback when it's actually out of room for the building it
  // wants — not just because it can't afford it yet. Otherwise the AI nibbles
  // away at the wood it's trying to save up, and never catches up.
  if (spots.size === 0 && claimSpots.size > 0 && resources.wood >= CLAIM_COST) {
    const [r, c] = keyToRC(pickClaimSpot(grid, "enemy", claimSpots));
    return { type: "claim", r, c };
  }
  return null; // nothing affordable/available this tick — let resources build up
}

/* ---------------------------------------------------------------------- */
/* Combat — armies are a per-side pool of trained units, not tied to a     */
/* tile. Sending an attack empties the pool, plots a route (computeAttack- */
/* Route above), and marches it: a defending garrison must be beaten at    */
/* the landing before anything else happens; every other building along    */
/* the way to the flag is just destroyed in passing. See the game tick's   */
/* attack-stepping effects for how a route actually gets walked.           */
/* ---------------------------------------------------------------------- */

function zeroArmy() {
  return { tank: 0, archer: 0, raider: 0 };
}

function armyPower(army) {
  let power = 0;
  for (const unitId of Object.keys(army)) power += (army[unitId] ?? 0) * UNIT_DEFS[unitId].power;
  return power;
}

function armyTotal(army) {
  return Object.values(army).reduce((a, b) => a + b, 0);
}

// The landing clash: whichever side has more raw army power holds the beach.
function armyClashWon(attackerArmy, defenderArmy) {
  return armyPower(attackerArmy) > armyPower(defenderArmy);
}

// Damage dealt when the march reaches the flag, from whatever the attacker
// has left. FIELD_DAMAGE_SCALE is deliberately weak — a small handful of
// troops shouldn't be able to take a keep down at all.
function finalAssaultDamage(army) {
  return Math.round(armyPower(army) * FIELD_DAMAGE_SCALE);
}

// Opportunistic, per the design doc: attack once there's "enough saved up" for
// a real attempt, not on a timer or a wave schedule. `threshold` defaults to
// the fixed guess but is normally the player-profile-derived one computed
// once per match — see aiTargetsRef.
function shouldAIAttack(army, threshold = AI_ATTACK_THRESHOLD) {
  return armyPower(army) >= threshold;
}

/* ---------------------------------------------------------------------- */
/* Save/load — keeps a match alive across a closed lid or a discarded tab.  */
/* One slot; a new match just overwrites it. All timestamps saved are      */
/* absolute (Date.now()-based), so time that passes while the tab is       */
/* asleep counts normally on reload — a build phase that should've ended   */
/* by now just ends the moment the clock ticks again, an attack mid-route  */
/* just keeps marching from where it was, nothing "catches up" instantly.  */
/* ---------------------------------------------------------------------- */

// v2, 2026-09-17: wall/anti-siege buildings and the siege unit were removed.
// A v1 save could still reference those defIds (a wall tile, an antiSiege
// count, a nonzero armies.*.siege) — those defs no longer exist in
// BUILDING_DEFS/UNIT_DEFS, so reading an old save back in would crash rather
// than just render wrong.
// v3, same day: found a real, separate bug the v2 bump didn't cover —
// computeAttackRoute's `buildingTiles` was a Set, and Set doesn't survive
// the JSON round-trip through localStorage (JSON.stringify silently turns
// it into "{}"), so any save written *while an attack was in flight*
// crashed on the very next load the moment stepAttack tried to call
// .has() on it (the reported bug: "screen turns white every time I try to
// resume"). Fixed by switching buildingTiles to a plain array (see
// computeAttackRoute/stepAttack), but any save already written with the
// broken Set-turned-{} shape needed discarding too, not just future ones —
// hence the second bump right behind the first.
const SAVE_KEY = "territory-game-save-v3";
let cachedSave; // memoized so mount-time lazy initializers don't each re-parse it

function loadSavedMatch() {
  if (cachedSave !== undefined) return cachedSave;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    cachedSave = parsed && parsed.grid && parsed.resources ? parsed : null;
  } catch {
    cachedSave = null; // corrupted save, private browsing, storage disabled, etc.
  }
  return cachedSave;
}

function saveMatch(snapshot) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
  } catch {
    // quota exceeded / storage unavailable — losing autosave isn't worth crashing over
  }
}

function clearSavedMatch() {
  cachedSave = null;
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignored, same as above
  }
}

/* ---------------------------------------------------------------------- */
/* Player profile — the "fast, client-side, per-player" layer from the     */
/* design doc's two-layer AI section. This is the part that's actually     */
/* buildable here: a genuine ML layer trained on data aggregated across    */
/* players needs a server and a training pipeline, neither of which exist  */
/* in this project (there's no backend at all — it's a static client-side  */
/* app). What this IS: a running record of how fast/strong *this* player   */
/* has played across their past matches, which the AI reads once per match */
/* to calibrate its own pace and aggression against a real human baseline  */
/* instead of a fixed guess — see the AI section below for how it's used.  */
/* ---------------------------------------------------------------------- */

const PROFILE_KEY = "territory-game-profile-v1";

function emptyProfileStat() {
  return { count: 0, avg: null, best: null };
}

function emptyPlayerProfile() {
  return {
    matchesPlayed: 0,
    firstBarracksMs: emptyProfileStat(),   // how long until the player's first barracks goes active
    firstAttackMs: emptyProfileStat(),     // how long until the player's first launched attack
    firstAttackPower: emptyProfileStat(),  // how much army power that first attack carried
  };
}

// Rolling mean + best-ever, updated incrementally so we never need to store
// every past sample — just the running count and average. `better` picks the
// "best" direction: Math.min for a timing (faster is better), Math.max for a
// power/strength number (more is better).
function recordProfileStat(stat, value, better) {
  const count = stat.count + 1;
  const avg = stat.avg == null ? value : stat.avg + (value - stat.avg) / count;
  const best = stat.best == null ? value : better(stat.best, value);
  return { count, avg, best };
}

function loadPlayerProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    // merge over the empty shape so an older/partial profile (or one from a
    // version of this file that tracked fewer stats) never crashes a reader
    // that expects a field it doesn't have
    return parsed && typeof parsed === "object" ? { ...emptyPlayerProfile(), ...parsed } : emptyPlayerProfile();
  } catch {
    return emptyPlayerProfile();
  }
}

function savePlayerProfile(profile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // same story as saveMatch — not worth crashing over
  }
}

// Called from both the home screen (starting the very first/a fresh match)
// and Match's own newMatch() (restarting mid-session) — the one shared spot
// that means "a new match is beginning," so matchesPlayed only ever counts
// actual new matches, never a resumed one.
function recordNewMatchStarted() {
  const profile = loadPlayerProfile();
  profile.matchesPlayed += 1;
  savePlayerProfile(profile);
}

/* ---------------------------------------------------------------------- */
/* Level progress — a simple linear campaign shown on the home screen.     */
/* Every level plays identically for now (same AI heuristic, same random   */
/* map generation) — this is purely a progression/unlock wrapper around    */
/* the existing single match type, not a per-level difficulty or map       */
/* system yet. Tyler's explicit call: add the map/levels first, tune       */
/* per-level difficulty later.                                             */
/* ---------------------------------------------------------------------- */
const LEVELS_KEY = "territory-game-levels-v1";
const LEVEL_COUNT = 5;

function emptyLevelProgress() {
  return { unlocked: 1 }; // highest level the player can currently play
}

function loadLevelProgress() {
  try {
    const raw = localStorage.getItem(LEVELS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? { ...emptyLevelProgress(), ...parsed } : emptyLevelProgress();
  } catch {
    return emptyLevelProgress();
  }
}

function saveLevelProgress(progress) {
  try {
    localStorage.setItem(LEVELS_KEY, JSON.stringify(progress));
  } catch {
    // not worth crashing over, same as the match/profile saves above
  }
}

// Only advances `unlocked` if the level just won WAS the current frontier —
// replaying an already-cleared level can't skip further ahead than one.
function recordLevelWon(level) {
  const progress = loadLevelProgress();
  if (level >= progress.unlocked && progress.unlocked < LEVEL_COUNT) {
    saveLevelProgress({ ...progress, unlocked: Math.min(LEVEL_COUNT, level + 1) });
  }
}

/* ---------------------------------------------------------------------- */
/* Small presentational pieces                                            */
/* ---------------------------------------------------------------------- */

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Remaining steps in an in-progress attack's route, converted to a rough ETA.
function attackEtaMs(attack) {
  return Math.max(0, attack.route.length - 1 - attack.stepIndex) * STEP_MS;
}

// "sailing" vs "marching" just follows the terrain under the force's current
// step — the muster walk and the final march are both on foot with one sea
// crossing in between, so there's no separate stage field to track.
function attackPhaseLabel(attack, grid) {
  const [r, c] = attack.route[attack.stepIndex];
  return grid[r][c].terrain === "water" ? "sailing" : "marching";
}

function CoreBar({ label, hp, color, align = "left" }) {
  const pct = Math.max(0, Math.min(1, hp / CORE_MAX_HP));
  return (
    <div style={{ ...CHIP, padding: "5px 10px", minWidth: 128, textAlign: align }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: align === "right" ? "flex-end" : "flex-start" }}>
        <Flag size={12} color={color} strokeWidth={2.5} />
        <span style={{ fontSize: 10.5, fontWeight: 600, color: INK, letterSpacing: 0.02 }}>{label}</span>
        <span style={{ fontSize: 10, color: INK_MUTED, fontVariantNumeric: "tabular-nums" }}>{Math.ceil(hp)}</span>
      </div>
      <div style={{ marginTop: 4, height: 5, background: "rgba(0,0,0,0.14)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color, transition: "width .3s ease" }} />
      </div>
    </div>
  );
}

function ResourcePill({ resId, amount, rate }) {
  const meta = RESOURCE_META[resId];
  const Icon = meta.icon;
  return (
    <div className="flex items-center gap-2" style={{ minWidth: 92 }}>
      <Icon size={15} color={meta.color} strokeWidth={2.25} />
      <div style={{ fontFamily: SANS, lineHeight: 1.1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
          {Math.floor(amount)}
        </div>
        {rate > 0 && (
          <div style={{ fontSize: 10, color: INK_MUTED }}>+{rate.toFixed(rate % 1 ? 1 : 0)}/s</div>
        )}
      </div>
    </div>
  );
}

function ArmyPill({ unitId, count }) {
  const def = UNIT_DEFS[unitId];
  const Icon = def.icon;
  return (
    <div className="flex items-center gap-2" title={def.name} style={{ opacity: count > 0 ? 1 : 0.4 }}>
      <Icon size={14} color={INK} strokeWidth={2.25} />
      <span style={{ fontSize: 12.5, fontWeight: 600, color: INK, fontVariantNumeric: "tabular-nums" }}>{count}</span>
    </div>
  );
}

const TROOPS_PER_SQUARE = 3;   // roughly "one square per 2-5 troops"
const MAX_SQUARES = 20;        // keeps a huge army cheap to render — it's an abstraction either way
const GRID_GAP = 1;             // matches the tile grid's own `gap`
const GRID_BORDER = 1;         // matches the tile grid's own `border`

// Pixel position of tile (r,c) within the map wrapper — used to place attack
// markers as plain absolutely-positioned overlays *outside* the CSS grid
// (not grid items with gridRowStart/gridColumnStart). Being a grid item
// forced Chromium's scroll-anchoring to fire on every step (see the note on
// the map wrapper below); this also means position can now animate smoothly
// via a CSS transition on left/top, since actual pixel values interpolate
// where grid-line integers never could.
function tilePixelPos(r, c, tileSize) {
  return { left: GRID_BORDER + c * (tileSize + GRID_GAP), top: GRID_BORDER + r * (tileSize + GRID_GAP) };
}

/* Unit icons — lucide doesn't have a spear/bow/cavalry, so these are small
   flat inline shapes instead, matching the same plain-silhouette style as
   BoatIcon below. Same size/color/strokeWidth props as a lucide icon so
   they drop straight into the existing call sites (strokeWidth is unused,
   just harmlessly ignored). */

function SpearIcon({ size, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <g transform="rotate(-45 12 12)">
        <rect x="11" y="5" width="2" height="15" fill={color} />
        <path d="M12 2 L15.5 9 L8.5 9 Z" fill={color} />
      </g>
    </svg>
  );
}

function BowIcon({ size, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M7 3 Q17 12 7 21" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <line x1="7" y1="3" x2="7" y2="21" stroke={color} strokeWidth="1.3" />
      <line x1="4" y1="12" x2="19" y2="12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function HorseIcon({ size, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <ellipse cx="11" cy="15" rx="6" ry="3.2" />
      <rect x="6.5" y="16.5" width="1.6" height="5" />
      <rect x="9.5" y="17" width="1.6" height="5" />
      <rect x="13" y="17" width="1.6" height="5" />
      <rect x="15.5" y="16.5" width="1.6" height="5" />
      <path d="M15 13 L20 6 L21.5 7 L18 14 Z" />
      <rect x="9.5" y="8" width="2.4" height="6" rx="1" />
      <circle cx="10.7" cy="6.5" r="1.6" />
    </svg>
  );
}

// A plain, simple boat silhouette — a hull + a sail, nothing more detailed
// than that. `accent` tints the sail so the two sides read as different at a
// glance; the hull stays a neutral wood tone either way.
function BoatIcon({ size, accent }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.4))" }}>
      <path d="M3 15 L21 15 L18 20 L6 20 Z" fill="#6B4A2F" />
      <rect x="11.3" y="4" width="1.4" height="11" fill="#3D2A1A" />
      <path d="M12.7 5 L19 14 L12.7 14 Z" fill={accent} />
    </svg>
  );
}

// However many troops a force has, shown as a small cluster of plain black
// squares — one per TROOPS_PER_SQUARE, capped so a huge army stays cheap to
// render (it's an abstraction regardless of the real count).
function SquadSquares({ total, tileSize }) {
  const n = Math.max(1, Math.min(MAX_SQUARES, Math.ceil(total / TROOPS_PER_SQUARE)));
  const sq = Math.max(2, Math.min(5, Math.round(tileSize * 0.14)));
  return (
    <div style={{
      display: "flex", flexWrap: "wrap", gap: 1,
      width: Math.min(tileSize * 0.85, (sq + 1) * 5), justifyContent: "center", alignItems: "center",
    }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{ width: sq, height: sq, background: INK, flexShrink: 0 }} />
      ))}
    </div>
  );
}

// One force's position on the map: a plain absolutely-positioned overlay,
// NOT a grid item — sits in a `position: relative` wrapper alongside the
// tile grid instead of inside it (see `tilePixelPos`). Left/top are real
// pixel values, so they can transition smoothly between steps instead of
// jumping tile to tile. A boat while it's currently over water, a little
// cluster of squares while on foot — muster-to-dock walks and the final
// march are both on foot, with a sea crossing in between, so "which one to
// show" just follows the terrain under the current step.
function AttackMarker({ attack, grid, side, tileSize }) {
  if (!attack) return null;
  const [r, c] = attack.route[attack.stepIndex];
  const { left, top } = tilePixelPos(r, c, tileSize);
  const onFoot = grid[r][c].terrain === "land";
  const accent = side === "player" ? CLAIM_EDGE : RUST;
  return (
    <div style={{
      position: "absolute", left, top, width: tileSize, height: tileSize,
      display: "flex", alignItems: "center", justifyContent: "center",
      pointerEvents: "none", zIndex: 5,
      transition: "left 0.4s ease, top 0.4s ease",
    }}>
      {onFoot
        ? <SquadSquares total={armyTotal(attack.army)} tileSize={tileSize} />
        : <BoatIcon size={Math.max(12, tileSize * 0.85)} accent={accent} />}
    </div>
  );
}

// A standing garrison, sitting at the keep — same square-cluster look as a
// marching force, just stationary. Only shown while that side is actually
// under attack (an enemy force is currently en route to them) — otherwise a
// garrison sitting idle at home would show all the time, which reads as "is
// that an attack or not?" It never boards a boat or moves on its own;
// garrisons only ever defend, and disappear only because that side actually
// sent them out (which empties the pool).
function GarrisonMarker({ visible, total, corePos, tileSize }) {
  if (!visible || total <= 0) return null;
  const [r, c] = corePos;
  const { left, top } = tilePixelPos(r, c, tileSize);
  return (
    <div style={{
      position: "absolute", left: left + tileSize * 0.35, top: top + tileSize * 0.35,
      width: tileSize, height: tileSize,
      display: "flex", alignItems: "flex-end", justifyContent: "flex-end",
      pointerEvents: "none", zIndex: 4,
    }}>
      <SquadSquares total={total} tileSize={tileSize} />
    </div>
  );
}

function ToolbarButton({ icon: Icon, label, cost, active, affordable, onClick, title }) {
  return (
    <button
      onClick={onClick}
      disabled={!affordable}
      title={title}
      className={`tp-tool${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-label={label}
    >
      <Icon size={20} color={active ? "#FBF6E8" : INK} strokeWidth={2} />
      <span className="tp-tool-pop">
        <span className="tp-tool-label">{label}</span>
        {cost && Object.keys(cost).length > 0 && (
          <span className="tp-tool-cost">
            {Object.entries(cost).map(([res, amt]) => {
              const m = RESOURCE_META[res];
              const RIcon = m.icon;
              return (
                <span key={res}>
                  <RIcon size={10} color={m.color} strokeWidth={2.25} /> {amt}
                </span>
              );
            })}
          </span>
        )}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/* Main component                                                         */
/* ---------------------------------------------------------------------- */

function Match({ level, onExit }) {
  const [grid, setGrid] = useState(() => loadSavedMatch()?.grid ?? buildInitialGrid());
  const [resources, setResources] = useState(() => loadSavedMatch()?.resources ?? START_RESOURCES);
  const [aiResources, setAiResources] = useState(() => loadSavedMatch()?.aiResources ?? START_RESOURCES); // AI gets no special exceptions
  const [selectedTool, setSelectedTool] = useState(null); // building id | "claim" | null
  const [message, setMessage] = useState(null);
  const msgTimer = useRef(null);
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  /* ---- match state ---- */
  const [phase, setPhase] = useState(() => loadSavedMatch()?.phase ?? "build"); // build | battle | won | lost
  const [matchStart, setMatchStart] = useState(() => loadSavedMatch()?.matchStart ?? Date.now());
  const [clock, setClock] = useState(() => Date.now()); // ticking wall-clock for the countdown
  const [coreHp, setCoreHp] = useState(() => loadSavedMatch()?.coreHp ?? { player: CORE_MAX_HP, enemy: CORE_MAX_HP });
  const [endedAt, setEndedAt] = useState(() => loadSavedMatch()?.endedAt ?? null);

  /* ---- armies: trained by barracks, spent on a one-way "expedition" when sent
     (see computeAttackRoute/stepAttack). Not tied to a tile — a per-side pool. ---- */
  const [armies, setArmies] = useState(() => loadSavedMatch()?.armies ?? { player: zeroArmy(), enemy: zeroArmy() });
  const [playerAttack, setPlayerAttack] = useState(() => loadSavedMatch()?.playerAttack ?? null);
  const [enemyAttack, setEnemyAttack] = useState(() => loadSavedMatch()?.enemyAttack ?? null);

  // This match's own milestone values (null until reached) — both feed the
  // player-profile running stats when first recorded, AND get sent along
  // with the end-of-match telemetry row (see submitMatchTelemetry). Storing
  // the actual value rather than just a recorded-yes/no flag means match-end
  // doesn't need to re-derive it from the profile's aggregated avg/best,
  // which couldn't tell you "this specific match's" number anyway. Saved as
  // part of the match itself so resuming never double-counts a milestone
  // already hit in an earlier session.
  const [firstBarracksMs, setFirstBarracksMs] = useState(() => loadSavedMatch()?.firstBarracksMs ?? null);
  const [firstAttackMs, setFirstAttackMs] = useState(() => loadSavedMatch()?.firstAttackMs ?? null);
  const [firstAttackPower, setFirstAttackPower] = useState(() => loadSavedMatch()?.firstAttackPower ?? null);

  // Every successful player placement this match (builds AND claims), not
  // just the three milestones above — a ref, not state: it only needs to be
  // read at autosave/match-end, never drives a render on its own, and a ref
  // avoids reconstructing the whole array (and re-rendering) on every single
  // click. `{ t, kind, defId, r, c }[]`; t is ms since matchStart, so it's
  // comparable across matches regardless of wall-clock time.
  const buildLogRef = useRef(loadSavedMatch()?.buildLog ?? []);

  // Which of your own barracks currently has its troop-type picker open.
  const [barracksMenu, setBarracksMenu] = useState(null); // { r, c } | null

  const over = phase === "won" || phase === "lost";
  const buildMsLeft = phase === "build" ? Math.max(0, BUILD_PHASE_MS - (clock - matchStart)) : 0;

  // Refs mirroring the state the ticking effects below need to read without
  // being recreated on every change (see the AI section for why).
  const gridRef = useRef(grid);
  useEffect(() => { gridRef.current = grid; }, [grid]);
  const resourcesRef = useRef(resources);
  useEffect(() => { resourcesRef.current = resources; }, [resources]);
  const aiResRef = useRef(aiResources);
  useEffect(() => { aiResRef.current = aiResources; }, [aiResources]);
  // matchStart never actually changes mid-match (only newMatch() resets it),
  // but the AI decision effect below has a stable `[over]` dependency array
  // so it doesn't recreate itself every tick — without a ref it would keep a
  // stale closure over whatever matchStart was when the match began.
  const matchStartRef = useRef(matchStart);
  useEffect(() => { matchStartRef.current = matchStart; }, [matchStart]);
  // When the game tick last actually ran — used to scale production by real
  // elapsed time instead of a fixed per-firing amount, so a throttled or
  // backgrounded tab (browsers slow down setInterval a lot when a tab isn't
  // focused) catches back up instead of silently running in slow motion.
  const lastTickRef = useRef(Date.now());

  // The AI's pace/aggression targets for this match, derived once from the
  // player's own profile (their best-ever numbers, falling back to a fixed
  // default until there's real history) — this is the whole point of
  // tracking the profile: the AI calibrates itself against what a real human
  // has actually managed, not an arbitrary guess. Computed once (lazy-ref
  // pattern: only runs the first time `.current` is null) rather than every
  // render, since it shouldn't drift mid-match.
  const aiTargetsRef = useRef(null);
  if (aiTargetsRef.current === null) {
    const profile = loadPlayerProfile();
    const barracksStat = profile.firstBarracksMs;
    const attackPowerStat = profile.firstAttackPower;
    aiTargetsRef.current = {
      // fastest the player has ever gotten a barracks up — that's the bar
      firstBarracksMs: barracksStat.best ?? barracksStat.avg ?? DEFAULT_TARGET_FIRST_BARRACKS_MS,
      // roughly match the scale of force the player typically opens with,
      // rather than a fixed number that might be way under or over their level
      attackThreshold: attackPowerStat.avg != null
        ? Math.max(15, Math.round(attackPowerStat.avg * 0.8))
        : DEFAULT_TARGET_ATTACK_POWER,
    };
  }

  /* ---- autosave: survive a closed lid or a tab Chrome OS discards to save
     memory. One ref, refreshed after every render (no deps array), so the
     save interval/handlers below always see the latest committed state
     without needing a separate ref per field. ---- */
  const saveSnapshotRef = useRef(null);
  useEffect(() => {
    saveSnapshotRef.current = {
      grid, resources, aiResources, phase, matchStart, coreHp, endedAt,
      armies, playerAttack, enemyAttack, firstBarracksMs, firstAttackMs, firstAttackPower,
      buildLog: buildLogRef.current, level,
    };
  });

  useEffect(() => {
    const id = setInterval(() => {
      if (saveSnapshotRef.current) saveMatch(saveSnapshotRef.current);
    }, 3000);
    // also save right away whenever the tab is about to be backgrounded —
    // covers a closed lid or a tab switch, which don't reliably fire a clean
    // unload event the way a normal page navigation does
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && saveSnapshotRef.current) {
        saveMatch(saveSnapshotRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
    };
  }, []);

  /* ---- player-profile milestone: first barracks active. The attack-side
     milestones (firstAttackMs/firstAttackPower) are recorded directly inside
     launchAttack() instead, since that's a one-shot user action rather than
     something to detect by watching state. ---- */
  useEffect(() => {
    if (firstBarracksMs !== null) return;
    const hasBarracks = grid.some((row) => row.some((t) =>
      t.owner === "player" && t.building?.defId === "barracks" && t.building.status === "active"));
    if (!hasBarracks) return;
    const elapsed = Date.now() - matchStart;
    const profile = loadPlayerProfile();
    profile.firstBarracksMs = recordProfileStat(profile.firstBarracksMs, elapsed, Math.min);
    savePlayerProfile(profile);
    setFirstBarracksMs(elapsed);
  }, [grid, matchStart, firstBarracksMs]);

  /* ---- keep the map sized to the window ---- */
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const tileSize = Math.max(TILE_MIN, Math.min(TILE_MAX, Math.floor(Math.min(
    (viewport.w - VIEW_GUTTER * 2 - GRID_COLS) / GRID_COLS,
    (viewport.h - VIEW_GUTTER * 2 - GRID_ROWS) / GRID_ROWS,
  ))));
  const tileIcon = Math.max(7, Math.round(tileSize * 0.6));

  const flash = useCallback((text, tone = "error") => {
    setMessage({ text, tone });
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMessage(null), 2600);
  }, []);

  /* ---- match clock + phase transitions ---- */
  useEffect(() => {
    if (over) return;
    const id = setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(id);
  }, [over]);

  useEffect(() => {
    if (phase === "build" && clock - matchStart >= BUILD_PHASE_MS) {
      setPhase("battle");
      flash("Build phase over — combat unlocked.", "success");
    }
  }, [clock, phase, matchStart, flash]);

  useEffect(() => {
    if (over) return;
    if (coreHp.enemy <= 0 || coreHp.player <= 0) {
      const outcome = coreHp.enemy <= 0 ? "won" : "lost";
      const endedAt = Date.now();
      setPhase(outcome);
      setEndedAt(endedAt);
      if (outcome === "won") recordLevelWon(level);
      // anonymous, best-effort — see supabaseClient.js. Fires exactly once
      // per match, right here, since this whole branch only runs the one
      // tick `over` actually flips (the guard above skips every run after).
      submitMatchTelemetry({
        outcome,
        match_length_ms: endedAt - matchStart,
        first_barracks_ms: firstBarracksMs,
        first_attack_ms: firstAttackMs,
        first_attack_power: firstAttackPower,
        build_log: buildLogRef.current,
        app_version: APP_VERSION,
      });
    }
  }, [coreHp, over, matchStart, firstBarracksMs, firstAttackMs, firstAttackPower, level]);

  const damageCore = useCallback((side, amount) => {
    setCoreHp((p) => ({ ...p, [side]: Math.max(0, p[side] - amount) }));
  }, []);

  /* ---- game tick: construction progress, resource production, and barracks
     training — one grid pass, reading refs so the interval's own cadence
     doesn't reset every time grid/resources change (they change most ticks).
     Production is scaled by real elapsed time (not a fixed per-firing amount)
     and training can catch up several cycles in one firing — both matter
     because a backgrounded/throttled tab makes setInterval fire far less
     often than every 500ms, and this way it still ends up in the same place
     it would have if it had never been throttled at all, instead of quietly
     running in slow motion the whole time it wasn't focused. */
  useEffect(() => {
    if (over) return;
    lastTickRef.current = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.max(0, (now - lastTickRef.current) / 1000);
      lastTickRef.current = now;
      let playerRes = resourcesRef.current;
      let aiRes = aiResRef.current;
      let gridChanged = false;

      const readyToTrain = []; // [r, c] of barracks that want to train this tick
      const nextGrid = gridRef.current.map((row, r) => row.map((tile, c) => {
        if (!tile.building) return tile;
        let t = tile;
        const bdef = BUILDING_DEFS[t.building.defId];

        // construction finishing this tick
        if (t.building.status === "building" && now >= t.building.startTime + t.building.buildMs) {
          gridChanged = true;
          const patch = { status: "active" };
          if (bdef?.trainable) patch.trainReadyAt = now + UNIT_DEFS[t.building.trains].trainMs;
          t = { ...t, building: { ...t.building, ...patch } };
        }

        if (t.building.status !== "active" || !t.owner) return t;

        // resource production, scaled by however long it's actually been
        if (bdef?.produces) {
          const res = bdef.produces.resource;
          const gain = bdef.produces.rate * elapsedSec;
          if (t.owner === "player") playerRes = { ...playerRes, [res]: playerRes[res] + gain };
          else if (t.owner === "enemy") aiRes = { ...aiRes, [res]: aiRes[res] + gain };
        }

        if (bdef?.trainable && t.building.trains && now >= (t.building.trainReadyAt ?? Infinity)) readyToTrain.push([r, c]);
        return t;
      }));

      // Barracks that have been ready-but-unaffordable the longest go first —
      // several barracks (each set to train something different) share one
      // food pool, and without this a cheap, frequent unit (raider) always
      // wins the race over a pricier one (tank) even though both are "due".
      // trainReadyAt only moves forward on a successful buy, so the
      // longest-stalled one sorts first and gets served the instant there's
      // enough to go around.
      readyToTrain.sort((a, b) => nextGrid[a[0]][a[1]].building.trainReadyAt - nextGrid[b[0]][b[1]].building.trainReadyAt);
      for (const [r, c] of readyToTrain) {
        const t = nextGrid[r][c];
        const owner = t.owner;
        const unit = UNIT_DEFS[t.building.trains];
        let pool = owner === "player" ? playerRes : owner === "enemy" ? aiRes : null;
        if (!pool) continue;
        let trainReadyAt = t.building.trainReadyAt;
        let trained = 0;
        // catch up as many cycles as elapsed time + resources allow, so a
        // barracks that missed several of its own cycles while throttled
        // doesn't just permanently lose that output
        while (now >= trainReadyAt && Object.entries(unit.cost).every(([res, amt]) => pool[res] >= amt)) {
          const spent = { ...pool };
          for (const [res, amt] of Object.entries(unit.cost)) spent[res] -= amt;
          pool = spent;
          trainReadyAt += unit.trainMs;
          trained += 1;
        }
        if (trained === 0) continue;
        if (owner === "player") playerRes = pool; else aiRes = pool;
        const trainedType = t.building.trains;
        setArmies((p) => ({ ...p, [owner]: { ...p[owner], [trainedType]: p[owner][trainedType] + trained } }));
        gridChanged = true;
        nextGrid[r] = [...nextGrid[r]];
        nextGrid[r][c] = { ...t, building: { ...t.building, trainReadyAt } };
      }

      if (gridChanged) setGrid(nextGrid);
      setResources(playerRes);
      setAiResources(aiRes);
    }, 500);
    return () => clearInterval(id);
  }, [over]);

  /* ---- AI opponent: same claim/build rules as the player, decided by a simple
     heuristic (see decideAIAction). Reads the latest grid/resources via refs so
     its own tick cadence doesn't reset every time the board changes.
     Self-reschedules with setTimeout (instead of a fixed setInterval) so its
     own pace can speed up while it's behind the player's historical pace to
     first barracks (aiTargetsRef) — this is the "smarter AI" lever: it
     doesn't get free resources or cheat the build rules, it just thinks
     faster when it's falling behind a real human benchmark. ---- */
  useEffect(() => {
    if (over) return;
    let timeoutId;
    const tick = () => {
      const g = gridRef.current;
      const hasBarracks = g.some((row) => row.some((t) =>
        t.owner === "enemy" && t.building?.defId === "barracks" && t.building.status === "active"));
      const behind = !hasBarracks && (Date.now() - matchStartRef.current) > aiTargetsRef.current.firstBarracksMs;

      const action = decideAIAction(g, aiResRef.current, behind);
      if (action) {
        if (action.type === "claim") {
          setAiResources((p) => ({ ...p, wood: p.wood - CLAIM_COST }));
          setGrid((prev) => withClaimedTile(prev, action.r, action.c, "enemy"));
        } else {
          const def = BUILDING_DEFS[action.defId];
          setAiResources((p) => {
            const next = { ...p };
            for (const [res, amt] of Object.entries(def.cost)) next[res] -= amt;
            return next;
          });
          setGrid((prev) => withBuiltTile(prev, action.r, action.c, "enemy", def, action.trains));
        }
      }
      timeoutId = setTimeout(tick, behind ? AI_CATCHUP_TICK_MS : AI_TICK_MS);
    };
    timeoutId = setTimeout(tick, AI_TICK_MS);
    return () => clearTimeout(timeoutId);
  }, [over]);

  /* ---- derived values ---- */
  const populationCap = useMemo(() => {
    let cap = 5; // town center base
    for (const row of grid) for (const t of row) {
      if (t.owner === "player" && t.building?.status === "active" && BUILDING_DEFS[t.building.defId]?.popBonus) {
        cap += BUILDING_DEFS[t.building.defId].popBonus;
      }
    }
    return cap;
  }, [grid]);

  const populationUsed = useMemo(() => {
    let used = 0;
    for (const row of grid) for (const t of row) {
      if (t.owner === "player" && t.building && BUILDING_DEFS[t.building.defId]?.requiresWorker) used += 1;
    }
    return used;
  }, [grid]);

  const productionRates = useMemo(() => {
    const rates = { wood: 0, stone: 0, iron: 0, platinum: 0, food: 0 };
    for (const row of grid) for (const t of row) {
      if (t.owner === "player" && t.building?.status === "active") {
        const def = BUILDING_DEFS[t.building.defId];
        if (def?.produces) rates[def.produces.resource] += def.produces.rate;
      }
    }
    return rates;
  }, [grid]);

  const validTiles = useMemo(
    () => (selectedTool ? computeValidTiles(grid, "player", selectedTool) : null),
    [selectedTool, grid],
  );

  /* ---- handlers ---- */
  function handleTileClick(r, c) {
    if (!selectedTool) return;
    const key = `${r},${c}`;
    if (!validTiles?.has(key)) {
      flash(
        selectedTool === "claim"
          ? "You can only claim land bordering your territory."
          : "Can't build here — check terrain and territory.",
      );
      return;
    }

    if (selectedTool === "claim") {
      if (resources.wood < CLAIM_COST) return flash("Not enough wood to claim this land.");
      setResources((p) => ({ ...p, wood: p.wood - CLAIM_COST }));
      setGrid((prev) => withClaimedTile(prev, r, c, "player"));
      buildLogRef.current.push({ t: Date.now() - matchStart, kind: "claim", defId: null, r, c });
      flash("Land claimed.", "success");
      return;
    }

    const def = BUILDING_DEFS[selectedTool];
    for (const [res, amt] of Object.entries(def.cost)) {
      if (resources[res] < amt) return flash(`Not enough ${RESOURCE_META[res].label.toLowerCase()}.`);
    }
    if (def.requiresWorker && populationUsed >= populationCap) {
      return flash("Not enough population capacity — build a House.");
    }

    setResources((p) => {
      const next = { ...p };
      for (const [res, amt] of Object.entries(def.cost)) next[res] -= amt;
      return next;
    });
    setGrid((prev) => withBuiltTile(prev, r, c, "player", def, def.trainable ? "tank" : undefined));
    buildLogRef.current.push({ t: Date.now() - matchStart, kind: "build", defId: selectedTool, r, c });
    flash(`${def.name} under construction.`, "success");
  }

  function launchAttack() {
    if (phase !== "battle" || playerAttack) return;
    if (armyTotal(armies.player) === 0) return;
    const route = computeAttackRoute(grid, "player");
    if (!route) return flash("No route to the enemy keep right now.");
    if (firstAttackMs === null) {
      const elapsed = Date.now() - matchStart;
      const power = armyPower(armies.player);
      const profile = loadPlayerProfile();
      profile.firstAttackMs = recordProfileStat(profile.firstAttackMs, elapsed, Math.min);
      profile.firstAttackPower = recordProfileStat(profile.firstAttackPower, power, Math.max);
      savePlayerProfile(profile);
      setFirstAttackMs(elapsed);
      setFirstAttackPower(power);
    }
    setArmies((p) => ({ ...p, player: zeroArmy() }));
    setPlayerAttack({ army: armies.player, ...route, stepIndex: 0, nextStepAt: clock + STEP_MS });
    flash("Your army sets out across the water...", "success");
  }

  // Walks one attack's route forward by one step per tick: muster to the
  // dock, sail (routed around any island in the way), land — clashing with
  // the defender's standing army first if it has one, the only real win/lose
  // gate — then march to the flag, flattening any building it happens to
  // cross, finally dealing damage from whatever's left once it reaches the
  // flag. Shared by both directions — `owner`/`enemyOwner` just pick which
  // side is attacking.
  function stepAttack(attack, setAttack, owner, enemyOwner, enemyArmy) {
    const nextIndex = attack.stepIndex + 1;

    if (nextIndex >= attack.route.length) {
      const coreDamage = finalAssaultDamage(attack.army);
      damageCore(enemyOwner, coreDamage);
      flash(`${owner === "player" ? "Your" : "The enemy's"} army reaches the flag — ${coreDamage} damage to the keep!`, owner === "player" ? "success" : "error");
      setAttack(null);
      return;
    }

    // Exactly the tick where the march steps off the boat and onto the
    // enemy's island — this is the one and only place a standing garrison
    // gets a say.
    const crossingIntoEnemyLand = attack.stepIndex < attack.legBreak && nextIndex >= attack.legBreak;
    if (crossingIntoEnemyLand && armyTotal(enemyArmy) > 0) {
      if (!armyClashWon(attack.army, enemyArmy)) {
        flash(
          owner === "player" ? "Your army was wiped out storming the beach." : "The enemy's landing force was wiped out on your shore.",
          owner === "player" ? "error" : "success",
        );
        setAttack(null);
        return;
      }
      setArmies((p) => ({ ...p, [enemyOwner]: zeroArmy() }));
      flash(
        owner === "player" ? "Your army clears the beach and pushes inland." : "The enemy clears your shore and pushes inland.",
        owner === "player" ? "success" : "error",
      );
    }

    const [r, c] = attack.route[nextIndex];
    const posKey = `${r},${c}`;
    const onEnemyLand = nextIndex >= attack.legBreak;
    if (onEnemyLand && attack.buildingTiles.includes(posKey)) {
      setGrid((prev) => clearBuildingAt(prev, r, c));
    }

    setAttack({ ...attack, stepIndex: nextIndex, nextStepAt: clock + STEP_MS });
  }

  useEffect(() => {
    if (over || !playerAttack || clock < playerAttack.nextStepAt) return;
    stepAttack(playerAttack, setPlayerAttack, "player", "enemy", armies.enemy);
  }, [clock, playerAttack, armies.enemy, over]);

  useEffect(() => {
    if (over || !enemyAttack || clock < enemyAttack.nextStepAt) return;
    stepAttack(enemyAttack, setEnemyAttack, "enemy", "player", armies.player);
  }, [clock, enemyAttack, armies.player, over]);

  // The AI's own decision to attack: opportunistic, once its army is "good
  // enough" (see shouldAIAttack) — not on a timer or a wave schedule. The
  // threshold itself comes from aiTargetsRef (the player's own historical
  // attack strength), not a fixed guess.
  useEffect(() => {
    if (over || phase !== "battle" || enemyAttack) return;
    if (!shouldAIAttack(armies.enemy, aiTargetsRef.current.attackThreshold)) return;
    const route = computeAttackRoute(gridRef.current, "enemy");
    if (!route) return;
    setArmies((p) => ({ ...p, enemy: zeroArmy() }));
    setEnemyAttack({ army: armies.enemy, ...route, stepIndex: 0, nextStepAt: clock + STEP_MS });
    flash("Enemy forces are on the move!");
  }, [clock, armies.enemy, enemyAttack, phase, over, flash]);

  function newMatch() {
    const fresh = {
      grid: buildInitialGrid(),
      resources: START_RESOURCES,
      aiResources: START_RESOURCES,
      coreHp: { player: CORE_MAX_HP, enemy: CORE_MAX_HP },
      endedAt: null,
      armies: { player: zeroArmy(), enemy: zeroArmy() },
      playerAttack: null,
      enemyAttack: null,
      matchStart: Date.now(),
      phase: "build",
      firstBarracksMs: null,
      firstAttackMs: null,
      firstAttackPower: null,
      buildLog: [],
      level,
    };
    buildLogRef.current = fresh.buildLog;
    setGrid(fresh.grid);
    setResources(fresh.resources);
    setAiResources(fresh.aiResources);
    setSelectedTool(null);
    setCoreHp(fresh.coreHp);
    setEndedAt(fresh.endedAt);
    setArmies(fresh.armies);
    setPlayerAttack(fresh.playerAttack);
    setEnemyAttack(fresh.enemyAttack);
    setBarracksMenu(null);
    setMatchStart(fresh.matchStart);
    setClock(fresh.matchStart);
    setPhase(fresh.phase);
    setFirstBarracksMs(fresh.firstBarracksMs);
    setFirstAttackMs(fresh.firstAttackMs);
    setFirstAttackPower(fresh.firstAttackPower);
    // re-derive the AI's pace/aggression targets from the (possibly just-
    // updated, if the last match recorded a new milestone) profile, instead
    // of keeping whatever was calibrated when this component first mounted
    aiTargetsRef.current = null;
    recordNewMatchStarted();
    saveMatch(fresh); // overwrite the old save immediately, don't wait for the next autosave tick
  }

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: PAGE_BG, fontFamily: SANS }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=Inter:wght@400;500;600&display=swap');
        @keyframes tp-pulse { 0%,100% { opacity: 0.28; } 50% { opacity: 0.5; } }

        .tp-tool {
          position: relative;
          display: flex; align-items: center; justify-content: center;
          width: 42px; height: 42px;
          background: transparent;
          border: none;
          border-radius: 11px;
          cursor: pointer;
          font-family: ${SANS};
          color: ${INK};
          pointer-events: auto;
          -webkit-tap-highlight-color: transparent;
          transition: transform .12s ease, background .12s ease;
        }
        .tp-tool svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4)); transition: filter .12s ease; }
        .tp-tool:hover:not(:disabled) { background: rgba(46,42,31,0.10); transform: translateY(-1px); }
        .tp-tool:active:not(:disabled) { transform: translateY(0); }
        .tp-tool:focus-visible { outline: 2px solid ${CLAIM_EDGE}; outline-offset: 2px; }
        .tp-tool:disabled { cursor: not-allowed; opacity: 0.32; }
        .tp-tool.is-active { background: ${CLAIM_EDGE}; }
        .tp-tool.is-active svg { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.25)); }

        .tp-tool-pop {
          position: absolute;
          bottom: calc(100% + 9px);
          left: 50%;
          display: flex; flex-direction: column; align-items: center; gap: 3px;
          padding: 6px 10px;
          background: ${PANEL_BG};
          border: 1px solid ${PANEL_BORDER};
          border-radius: 8px;
          box-shadow: 0 4px 14px rgba(0,0,0,0.28);
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transform: translate(-50%, 4px);
          transition: opacity .12s ease, transform .12s ease;
          z-index: 6;
        }
        .tp-tool-pop::after {
          content: ""; position: absolute; top: 100%; left: 50%;
          width: 8px; height: 8px; margin-left: -4px; margin-top: -4px;
          background: ${PANEL_BG};
          border-right: 1px solid ${PANEL_BORDER};
          border-bottom: 1px solid ${PANEL_BORDER};
          transform: rotate(45deg);
        }
        .tp-tool:hover .tp-tool-pop,
        .tp-tool:focus-visible .tp-tool-pop {
          opacity: 1;
          transform: translate(-50%, 0);
        }

        .tp-tool-label { font-size: 11px; font-weight: 600; letter-spacing: 0.01em; color: ${INK}; }

        .tp-tool-cost { display: flex; gap: 6px; }
        .tp-tool-cost > span {
          display: flex; align-items: center; gap: 2px;
          font-size: 10px; color: ${INK_MUTED};
          font-variant-numeric: tabular-nums;
        }

        /* Per-tile popup for picking what a barracks trains — click, not hover,
           since it changes state rather than just previewing it. */
        .tp-troop-menu {
          position: absolute;
          bottom: calc(100% + 6px);
          left: 50%;
          transform: translateX(-50%);
          display: flex; gap: 3px;
          padding: 4px;
          background: ${PANEL_BG};
          border: 1px solid ${PANEL_BORDER};
          border-radius: 8px;
          box-shadow: 0 4px 14px rgba(0,0,0,0.3);
          z-index: 8;
        }
        .tp-troop-opt {
          width: 26px; height: 26px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center;
          background: transparent; border: none; border-radius: 6px;
          cursor: pointer;
        }
        .tp-troop-opt:hover { background: rgba(46,42,31,0.12); }
        .tp-troop-opt.is-active { background: ${CLAIM_EDGE}; }
      `}</style>

      {/* Map — sized to fill the window */}
      <div style={{ position: "absolute", inset: 0, display: "flex", overflow: "auto", overflowAnchor: "none" }}>
        {/* Plain positioning wrapper (not a grid) so the attack/garrison
            markers below can be absolutely-positioned siblings of the tile
            grid instead of grid items inside it — see tilePixelPos. */}
        <div style={{ position: "relative", flexShrink: 0, margin: "auto" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${GRID_COLS}, ${tileSize}px)`,
            gap: 1,
            background: WATER_DEEP,
            border: `1px solid ${INK}`,
          }}
        >
          {grid.map((row, r) => row.map((tile, c) => {
                const key = `${r},${c}`;
                const isValid = validTiles?.has(key);
                const isPlayerCore = r === TC_ROW && c === TC_COL;
                const isEnemyCore = r === ENEMY_ROW && c === ENEMY_COL;
                const isCore = isPlayerCore || isEnemyCore;
                const def = tile.building && !isCore ? BUILDING_DEFS[tile.building.defId] : null;
                // A barracks shows whichever troop it's currently set to train,
                // not a fixed building icon, so you can tell at a glance.
                const trainedUnit = def?.trainable && tile.building.trains ? UNIT_DEFS[tile.building.trains] : null;
                const Icon = trainedUnit?.icon ?? def?.icon;
                const isOwnBarracks = tile.owner === "player" && tile.building?.status === "active" && def?.trainable;
                const menuOpen = barracksMenu?.r === r && barracksMenu?.c === c;
                const bg = tile.terrain === "water"
                  ? ((r + c) % 2 === 0 ? WATER : WATER_DEEP)
                  : ((r + c) % 2 === 0 ? LAND : LAND_DEEP);
                const progress = tile.building?.status === "building"
                  ? Math.min(1, (Date.now() - tile.building.startTime) / tile.building.buildMs)
                  : null;

                return (
                  <div
                    key={key}
                    onClick={() => {
                      if (isOwnBarracks && !selectedTool) {
                        setBarracksMenu((m) => (m && m.r === r && m.c === c ? null : { r, c }));
                        return;
                      }
                      if (barracksMenu) setBarracksMenu(null);
                      handleTileClick(r, c);
                    }}
                    style={{
                      width: tileSize, height: tileSize, position: "relative",
                      background: bg,
                      boxShadow: tile.owner === "player" ? `inset 0 0 0 1000px ${CLAIM_TINT}`
                        : tile.owner === "enemy" ? `inset 0 0 0 1000px ${ENEMY_TINT}`
                        : "none",
                      outline: isValid ? `2px solid ${CLAIM_EDGE}` : "none",
                      outlineOffset: -2,
                      cursor: selectedTool ? (isValid ? "pointer" : "not-allowed") : isOwnBarracks ? "pointer" : "default",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                    title={`${tile.terrain}${tile.owner ? ` · ${tile.owner} territory` : ""}${isPlayerCore ? " · your keep" : isEnemyCore ? " · enemy keep" : trainedUnit ? ` · Barracks (${trainedUnit.name})` : def ? " · " + def.name : ""}`}
                  >
                    {isPlayerCore && <Flag size={tileIcon} color={INK} strokeWidth={2.5} />}
                    {isEnemyCore && <Flag size={tileIcon} color={RUST} strokeWidth={2.5} />}
                    {!isCore && Icon && (
                      <Icon size={tileIcon} color={def.terrain === "water" ? "#F7F1E1" : INK} strokeWidth={2.25} />
                    )}
                    {progress !== null && (
                      <>
                        <div style={{ position: "absolute", inset: 0, background: INK, opacity: 0.3, animation: "tp-pulse 1.4s ease-in-out infinite" }} />
                        <div style={{ position: "absolute", left: 2, right: 2, bottom: 2, height: Math.max(2, Math.round(tileSize / 9)), background: "rgba(0,0,0,0.25)" }}>
                          <div style={{ width: `${progress * 100}%`, height: "100%", background: CLAIM_EDGE }} />
                        </div>
                      </>
                    )}
                    {menuOpen && (
                      <div className="tp-troop-menu" onClick={(e) => e.stopPropagation()}>
                        {Object.keys(UNIT_DEFS).map((unitId) => {
                          const u = UNIT_DEFS[unitId];
                          const UIcon = u.icon;
                          const isActive = tile.building.trains === unitId;
                          return (
                            <button
                              key={unitId}
                              className={`tp-troop-opt${isActive ? " is-active" : ""}`}
                              title={u.name}
                              onClick={() => {
                                setGrid((prev) => {
                                  const next = prev.map((row2) => row2.slice());
                                  next[r][c] = { ...next[r][c], building: { ...next[r][c].building, trains: unitId } };
                                  return next;
                                });
                                setBarracksMenu(null);
                              }}
                            >
                              <UIcon size={15} color={isActive ? "#FBF6E8" : INK} strokeWidth={2.25} />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
          }))}
        </div>
        <AttackMarker attack={playerAttack} grid={grid} side="player" tileSize={tileSize} />
        <AttackMarker attack={enemyAttack} grid={grid} side="enemy" tileSize={tileSize} />
        <GarrisonMarker visible={!!enemyAttack} total={armyTotal(armies.player)} corePos={[TC_ROW, TC_COL]} tileSize={tileSize} />
        <GarrisonMarker visible={!!playerAttack} total={armyTotal(armies.enemy)} corePos={[ENEMY_ROW, ENEMY_COL]} tileSize={tileSize} />
        </div>
      </div>

      {/* Top-left: title + your keep */}
      <div style={{ position: "absolute", top: 10, left: 12, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
        <div style={{ ...CHIP, pointerEvents: "none", padding: "5px 11px", display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontFamily: SERIF, fontSize: 15, fontWeight: 600, color: INK }}>Territory &amp; Economy</span>
          <span style={{ fontSize: 10.5, fontWeight: 600, color: INK_MUTED }}>Level {level}</span>
        </div>
        <CoreBar label="Your keep" hp={coreHp.player} color={CLAIM_EDGE} align="left" />
        {enemyAttack && (
          <div style={{ ...CHIP, pointerEvents: "none", display: "flex", alignItems: "center", gap: 5, padding: "4px 9px", color: RUST }}>
            <Ship size={11} strokeWidth={2.25} />
            <span style={{ fontSize: 10.5, fontWeight: 600 }}>
              Incoming ({attackPhaseLabel(enemyAttack, grid)}) — ETA {fmtClock(attackEtaMs(enemyAttack))}
            </span>
          </div>
        )}
      </div>

      {/* Top-right: level map + new match + enemy keep */}
      <div style={{ position: "absolute", top: 10, right: 12, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onExit}
            style={{
              ...CHIP, display: "flex", alignItems: "center", gap: 6,
              fontSize: 11.5, color: INK, padding: "6px 10px", cursor: "pointer", fontFamily: SANS,
            }}
          >
            <Map size={12} /> Level map
          </button>
          <button
            onClick={newMatch}
            style={{
              ...CHIP, display: "flex", alignItems: "center", gap: 6,
              fontSize: 11.5, color: INK, padding: "6px 10px", cursor: "pointer", fontFamily: SANS,
            }}
          >
            <RotateCcw size={12} /> New match
          </button>
        </div>
        <CoreBar label="Enemy keep" hp={coreHp.enemy} color={RUST} align="right" />
        {playerAttack && (
          <div style={{ ...CHIP, pointerEvents: "none", display: "flex", alignItems: "center", gap: 5, padding: "4px 9px", color: CLAIM_EDGE }}>
            <Ship size={11} strokeWidth={2.25} />
            <span style={{ fontSize: 10.5, fontWeight: 600 }}>
              Your army ({attackPhaseLabel(playerAttack, grid)}) — ETA {fmtClock(attackEtaMs(playerAttack))}
            </span>
          </div>
        )}
      </div>

      {/* Phase banner (top-centre, below the resource bar) */}
      <div style={{
        ...CHIP, pointerEvents: "none",
        position: "absolute", top: 54, left: "50%", transform: "translateX(-50%)",
        display: "flex", alignItems: "center", gap: 8, padding: "5px 13px",
      }}>
        {phase === "build" ? (
          <>
            <Hourglass size={13} color={CLAIM_EDGE} strokeWidth={2.25} />
            <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Build phase</span>
            <span style={{ fontSize: 12, color: INK_MUTED, fontVariantNumeric: "tabular-nums" }}>
              {fmtClock(buildMsLeft)} · combat locked
            </span>
          </>
        ) : (
          <>
            <Swords size={13} color={RUST} strokeWidth={2.25} />
            <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>Battle phase</span>
            <span style={{ fontSize: 12, color: INK_MUTED }}>combat unlocked</span>
          </>
        )}
      </div>

      {/* Resource bar (top-center) */}
      <div style={{
        position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
        display: "flex", justifyContent: "center", maxWidth: "calc(100% - 260px)",
        pointerEvents: "none",
      }}>
        <div style={{ ...CHIP, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", justifyContent: "center", padding: "6px 13px" }}>
          {Object.keys(RESOURCE_META).map((res) => (
            <ResourcePill key={res} resId={res} amount={resources[res]} rate={productionRates[res]} />
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Users size={15} color={INK_MUTED} strokeWidth={2.25} />
            <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{populationUsed}/{populationCap}</span>
          </div>
        </div>
      </div>

      {/* Flash message (below the phase banner) */}
      {message && (
        <div style={{
          ...CHIP, pointerEvents: "none",
          position: "absolute", top: 90, left: "50%", transform: "translateX(-50%)",
          padding: "6px 14px", fontSize: 12, fontFamily: SANS, maxWidth: "70%", textAlign: "center",
          color: message.tone === "error" ? RUST : FOREST,
        }}>
          {message.text}
        </div>
      )}

      {/* Bottom HUD — resources + tools floating over the map, no strip behind */}
      <div style={{
        position: "absolute", left: 0, right: 0, bottom: 0,
        padding: "0 12px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
        pointerEvents: "none",
      }}>
        {/* army + attack */}
        <div style={{ ...CHIP, display: "flex", alignItems: "center", gap: 12, padding: "6px 13px" }}>
          {Object.keys(UNIT_DEFS).map((unitId) => (
            <ArmyPill key={unitId} unitId={unitId} count={armies.player[unitId]} />
          ))}
          <button
            onClick={launchAttack}
            disabled={phase !== "battle" || !!playerAttack || armyTotal(armies.player) === 0}
            title={
              phase !== "battle" ? "Combat is locked until the build phase ends"
              : playerAttack ? "Your army is already en route"
              : armyTotal(armies.player) === 0 ? "Train some troops first — build a barracks"
              : "Send your whole army at the enemy keep"
            }
            style={{
              display: "flex", alignItems: "center", gap: 6,
              background: RUST, color: "#FBF6E8", border: "none", borderRadius: 8,
              padding: "6px 12px", fontFamily: SANS, fontSize: 11.5, fontWeight: 600,
              cursor: phase === "battle" && !playerAttack && armyTotal(armies.player) > 0 ? "pointer" : "not-allowed",
              opacity: phase === "battle" && !playerAttack && armyTotal(armies.player) > 0 ? 1 : 0.4,
            }}
          >
            <Ship size={13} strokeWidth={2.25} /> Attack
          </button>
        </div>

        {/* tools */}
        <div style={{ display: "flex", gap: 3, alignItems: "center", flexWrap: "wrap", justifyContent: "center", maxWidth: "100%" }}>
          <ToolbarButton
            icon={LandPlot}
            label="Claim"
            cost={{ wood: CLAIM_COST }}
            active={selectedTool === "claim"}
            affordable={resources.wood >= CLAIM_COST}
            onClick={() => setSelectedTool((t) => (t === "claim" ? null : "claim"))}
            title={`Claim land bordering your territory — ${CLAIM_COST} wood`}
          />
          {Object.values(BUILDING_DEFS).map((def) => (
            <ToolbarButton
              key={def.id}
              icon={def.icon}
              label={def.name}
              cost={def.cost}
              active={selectedTool === def.id}
              affordable={Object.entries(def.cost).every(([res, amt]) => resources[res] >= amt)}
              onClick={() => setSelectedTool((t) => (t === def.id ? null : def.id))}
              title={def.desc}
            />
          ))}
          {selectedTool && (
            <button
              onClick={() => setSelectedTool(null)}
              className="tp-tool"
              aria-label="Cancel"
            >
              <X size={20} color={INK_MUTED} strokeWidth={2} />
              <span className="tp-tool-pop">
                <span className="tp-tool-label">Cancel</span>
              </span>
            </button>
          )}
        </div>
      </div>

      {/* End-of-match overlay */}
      {over && (
        <div style={{
          position: "absolute", inset: 0, pointerEvents: "auto",
          background: "rgba(46,42,31,0.42)", backdropFilter: "blur(2px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            ...CHIP, boxShadow: "0 10px 40px rgba(0,0,0,0.4)",
            padding: "24px 30px", maxWidth: 340, textAlign: "center",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
          }}>
            {phase === "won"
              ? <Trophy size={30} color={FOREST} strokeWidth={2} />
              : <Skull size={30} color={RUST} strokeWidth={2} />}
            <div style={{ fontFamily: SERIF, fontSize: 24, fontWeight: 600, color: phase === "won" ? FOREST : RUST }}>
              {phase === "won" ? "Victory" : "Defeat"}
            </div>
            <div style={{ fontSize: 12.5, color: INK_MUTED, lineHeight: 1.5 }}>
              {phase === "won"
                ? "You razed the enemy keep."
                : "Your keep has fallen."}
              <br />
              Match length {fmtClock((endedAt ?? Date.now()) - matchStart)}
              {phase === "won" && level < LEVEL_COUNT && (
                <>
                  <br />
                  <span style={{ color: FOREST, fontWeight: 600 }}>Level {level + 1} unlocked!</span>
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                onClick={onExit}
                style={{
                  ...CHIP, display: "flex", alignItems: "center", gap: 6,
                  fontSize: 12.5, fontWeight: 600, color: INK, padding: "8px 16px",
                  cursor: "pointer", fontFamily: SANS,
                }}
              >
                <Map size={13} /> Level map
              </button>
              <button
                onClick={newMatch}
                style={{
                  ...CHIP, display: "flex", alignItems: "center", gap: 6,
                  fontSize: 12.5, fontWeight: 600, color: INK, padding: "8px 16px",
                  cursor: "pointer", fontFamily: SANS,
                }}
              >
                <RotateCcw size={13} /> New match
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Home screen                                                             */
/* ---------------------------------------------------------------------- */

function homeButtonStyle(primary) {
  return {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    padding: "11px 18px", borderRadius: 8, fontFamily: SANS, fontSize: 13.5, fontWeight: 600,
    cursor: "pointer", border: primary ? "none" : `1px solid ${PANEL_BORDER}`,
    background: primary ? CLAIM_EDGE : "transparent",
    color: primary ? "#FBF6E8" : INK,
  };
}

function HomeScreen({ savedMatch, onStart, onContinue }) {
  const profile = loadPlayerProfile();
  const hasStats = profile.matchesPlayed > 0;
  const savedPhase = savedMatch?.phase;
  const levelProgress = loadLevelProgress();
  const savedLevel = savedMatch?.level ?? null;
  const [selectedLevel, setSelectedLevel] = useState(savedLevel ?? levelProgress.unlocked);
  const isSavedLevel = savedMatch != null && selectedLevel === savedLevel;

  return (
    <div style={{
      position: "fixed", inset: 0, background: PAGE_BG, fontFamily: SANS,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Spectral:wght@500;600&family=Inter:wght@400;500;600&display=swap');`}</style>
      <div style={{
        ...CHIP, width: "100%", maxWidth: 420, padding: "34px 28px",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 18, textAlign: "center",
      }}>
        <Flag size={30} color={CLAIM_EDGE} strokeWidth={2.25} />
        <div>
          <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, color: INK }}>Territory &amp; Economy</div>
          <div style={{ fontSize: 12.5, color: INK_MUTED, marginTop: 6, lineHeight: 1.5 }}>
            Claim land, build an economy, and take the enemy's flag before they take yours.
          </div>
        </div>

        {hasStats && (
          <div style={{
            width: "100%", padding: "12px 14px", background: "#FBF6E8",
            border: `1px solid ${PANEL_BORDER}`, borderRadius: 6, textAlign: "left",
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 5, letterSpacing: 0.02 }}>
              Your record
            </div>
            <div style={{ fontSize: 11.5, color: INK_MUTED, lineHeight: 1.8 }}>
              <div>Matches played: {profile.matchesPlayed}</div>
              {profile.firstBarracksMs.best != null && (
                <div>Fastest to first barracks: {fmtClock(profile.firstBarracksMs.best)}</div>
              )}
              {profile.firstAttackMs.best != null && (
                <div>Fastest to first attack: {fmtClock(profile.firstAttackMs.best)}</div>
              )}
              {profile.firstAttackPower.best != null && (
                <div>Strongest opening attack: {Math.round(profile.firstAttackPower.best)} power</div>
              )}
            </div>
          </div>
        )}

        {/* Campaign map — a simple winding trail of level nodes. Every level
            plays identically right now (same AI, same random map) — this is
            just the progression/unlock layer; per-level tuning comes later. */}
        <div style={{ width: "100%", textAlign: "left" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: INK, marginBottom: 10, letterSpacing: 0.02 }}>
            Campaign
          </div>
          <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" }}>
            <div style={{
              position: "absolute", left: "50%", top: 4, bottom: 4, width: 2,
              background: PANEL_BORDER, transform: "translateX(-1px)", zIndex: 0,
            }} />
            {Array.from({ length: LEVEL_COUNT }, (_, i) => i + 1).map((lvl) => {
              const locked = lvl > levelProgress.unlocked;
              const completed = lvl < levelProgress.unlocked;
              const isSelected = lvl === selectedLevel;
              const alignRight = lvl % 2 === 0;
              return (
                <div key={lvl} style={{ display: "flex", justifyContent: alignRight ? "flex-end" : "flex-start", zIndex: 1 }}>
                  <button
                    onClick={() => !locked && setSelectedLevel(lvl)}
                    disabled={locked}
                    title={locked ? "Beat the previous level to unlock" : `Level ${lvl}`}
                    style={{
                      width: 44, height: 44, borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      border: `2px solid ${locked ? PANEL_BORDER : isSelected ? CLAIM_EDGE : completed ? FOREST : PANEL_BORDER}`,
                      background: locked ? PANEL_BG : isSelected ? CLAIM_TINT : completed ? "rgba(76,107,62,0.14)" : PANEL_BG,
                      color: locked ? INK_MUTED : completed ? FOREST : INK,
                      cursor: locked ? "not-allowed" : "pointer",
                      fontFamily: SERIF, fontWeight: 600, fontSize: 15,
                      boxShadow: isSelected ? "0 0 0 3px rgba(193,120,23,0.18)" : "none",
                    }}
                  >
                    {locked ? <Lock size={15} /> : completed ? <Check size={18} /> : lvl}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%" }}>
          {isSavedLevel && (
            <button onClick={onContinue} style={homeButtonStyle(true)}>
              Continue Level {selectedLevel}
              {savedPhase === "won" ? " — victory!" : savedPhase === "lost" ? " — defeat" : ""}
            </button>
          )}
          <button onClick={() => onStart(selectedLevel)} style={homeButtonStyle(!isSavedLevel)}>
            {isSavedLevel ? "Restart level" : `Start Level ${selectedLevel}`}
          </button>
        </div>

        {hasStats && (
          <div style={{ fontSize: 10, color: INK_MUTED, lineHeight: 1.5 }}>
            The AI reads your best times each match to calibrate its own pace and how big an army it commits with.
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Top-level: home screen first, the match only once you've actually       */
/* started or resumed one — keeps every one of Match's timers/effects from */
/* existing at all until there's an actual match to run them against.      */
/* ---------------------------------------------------------------------- */

export default function TerritoryPrototype() {
  const [screen, setScreen] = useState("home");
  const savedMatch = loadSavedMatch();
  const [level, setLevel] = useState(() => savedMatch?.level ?? loadLevelProgress().unlocked);

  function handleStart(chosenLevel) {
    const activeMatch = savedMatch && savedMatch.phase !== "won" && savedMatch.phase !== "lost";
    if (activeMatch && !window.confirm("Start a new match? This will erase your current one.")) return;
    clearSavedMatch();
    recordNewMatchStarted();
    setLevel(chosenLevel);
    setScreen("game");
  }

  if (screen === "home") {
    return <HomeScreen savedMatch={savedMatch} onStart={handleStart} onContinue={() => setScreen("game")} />;
  }
  return <Match level={level} onExit={() => setScreen("home")} />;
}
