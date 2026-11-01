# pi-goal — Project Rules

Persistent autonomous goals for pi: `/goal` command, goal tools, status bar. TypeScript extension package at `github.com/BetterCodeCrafting/pi-goal` (origin, ssh), published to npm as `pi-goal`.

Project rules for pi-goal. Only project-specific rules are listed here.

## Tests

No DB, no browser, no network. The pyramid collapses into three tiers, all running in seconds:

1. **Source contract tests** (`test/source-contract.test.cjs`, `test/continuation-contract.test.cjs`) — pin the model-facing contract by matching exact phrases in the TS source and README: goal-writing guidance, `create_goal` upsert semantics, completion-only `update_goal`, tool visibility, README↔code sync.
2. **Unit tests** (`test/goal-state.test.cjs`, `test/usage.test.cjs`) — pure functions from `goal-state.ts` / `usage.ts`, loaded via jiti.
3. **Smoke** — `npm run check` proves the extension actually loads in pi.

- Outside-in TDD: new or changed behavior gets its failing contract/unit test first, then the minimal source change.
- User-visible behavior is documented in README and pinned by contract tests — update code, README, and tests in one change.
- Never loosen a contract assertion to make a test pass. Renaming contract wording in source without the test (or vice versa) breaks the suite by design.
- Suite stays deterministic and fast: no timers, no sleeps, no network.

Before every push: `npm test && npm run check`.

## Stop Starting, Start Finishing

Before starting any new feature, finish what is in flight. A stalled delivery (code built but no PR, PR open but not merged, review findings unfixed) outranks any new work. Never leave a feature half-delivered when picking up the next one.

## Implementation

Production code is `.pi/extensions/pi-goal/*.ts` and `skills/pi-goal-writer/SKILL.md`. A behavior change usually reaches several of:

- `index.ts` — commands, tools, events, TUI, turn accounting
- `goal-state.ts` / `usage.ts` — pure logic; keep pi imports out of these, they are unit-tested via jiti
- `test/*.test.cjs` — the failing test comes first
- `README.md` — user-visible behavior is part of the contract
- `package.json` `files` — new shipped paths must be listed or `npm pack` drops them

## Git

- ssh GitHub only: `origin git@github.com:BetterCodeCrafting/pi-goal`.
- Forge is GitHub — manage everything above git with the `gh` CLI (`gh issue`, `gh pr`, `gh run watch`, `gh release`).
- While babysitting a release run: `gh run watch`, and confirm the outcome via `gh release view <tag>` — do not infer publish success from the tag push alone.
- **Tags are releases.** Pushing `v*` triggers `.github/workflows/release.yml`: `npm test` + `npm run check`, then a GitHub Release. No npm publish — the fork consumes via git ref (`pi install git:github.com/BetterCodeCrafting/pi-goal@<tag>`). Bump `package.json` version in the same commit as the tag. Never push a tag speculatively.

## Subagents

- Use sub agents by default. Keep orchestration context small; delegate research & investigation.
- Async subagents notify on completion natively — do not poll for status. On checkpoint wakes while background work runs, make one silent `bg_wait` call (~120s) instead of emitting status turns.
- Keep an active goal active — never pause it to silence checkpoint noise.

## Commands

```bash
npm install        # once; jiti devDep required by tests and check
npm test           # node --test test/**/*.test.cjs — full suite, seconds
npm run check      # pi --no-extensions -e ./.pi/extensions/pi-goal/index.ts --list-models __pi_goal_load_check__
npm run pack:dry   # verify package contents match files[] before release
```

CI exists only for releases (tag push, see Git). No PR pipeline — the local `npm test && npm run check` gate is the gate.

## Architecture

Single pi extension, ~570 lines TypeScript:

- `index.ts` — entry. `/goal` command parsing, goal events (custom message type `pi-goal-event`; `content` is always actionable LLM text — the TUI only collapses it for display), tool registration (`create_goal`, `get_goal`, `update_goal`; the latter two hidden unless a goal is active), turn accounting on `turn_end`, continuation queueing on `agent_end`, footer status.
- `goal-state.ts` — pure state machine: statuses (`active`, `paused`, `complete`, `cleared`, `budget_limited`), token budget parsing (`--tokens 50k`), continuation/audit prompts, usage formatting. No pi imports.
- `usage.ts` — usage snapshot → token delta (cache-aware, prefers `totalTokens`).
- State persists as custom session entries (`customType: "pi-goal"`) on the active branch; reload pauses an active goal, `/goal resume` continues.
- Invariants the tests pin: `update_goal` accepts only `complete`; goal tools hidden unless a goal is active; the final turn is accounted even when completed mid-turn; persisting a non-active goal cancels any queued continuation.

## Conventions

- English only for all names, docs, and commit messages.
- Commits: conventional style (`fix:`, `feat:`, `chore:`).
- Outside-in TDD mandatory; the contract tests are this repo's acceptance tier.

## Memory palace (shared semantic memory)

Mandatory, not judgment-gated:

1. **Kickoff recall** — before any non-trivial task (new issue, feature, investigation), run `mempalace_search` once on the topic against wing `pi-goal` (plus wing `global` for cross-project topics). One call, cheap, always. "I judged it familiar" is not a skip reason; if the search returns nothing relevant, move on.
2. **Record on landing** — when a PR is opened or a lesson surfaces (crash, workaround avoided, environment quirk, orchestration failure), file one `mempalace_add_drawer` in the matching room. Tied to landing, not remembered as a separate step.
3. **Worker briefs** — every dispatched coding/scout subagent brief includes: "search mempalace wing `pi-goal` for `<topic>` before implementing; report any relevant drawer hits".

Endpoint and auth: this repo is public, so no endpoint is recorded here. Read `url=` and `token=` from `~/.config/mempalace/config` (`chmod 600`); that config file is the only source of truth. Never commit or log the token. Liveness (no auth):

```bash
curl -s "$(grep '^url=' ~/.config/mempalace/config | cut -d= -f2- | sed 's|/mcp$|/healthz|')"  # -> ok
```

Wings/rooms — this repo's data lives under:

- wing `pi-goal` — this project; room = kind/topic (`failure`, `strategy`, `workflow`,
  `architecture`, `patterns`, `conventions`, `process`, `environment`, …)
- wing `global` — cross-project lessons; search it next to the project wing

Tools: `mempalace_search` `{query, wing, room?, limit}` — semantic recall, hits every room of the
wing; `mempalace_add_drawer` `{wing, room, content, source_file?, added_by?}` — verbatim write,
deduped server-side by content hash; `mempalace_delete_drawer` `{drawer_id}`; `mempalace_status`.

One-time client wiring (Claude Code; URL and token come from the config file):
`claude mcp add --transport http mempalace "$(grep '^url=' ~/.config/mempalace/config | cut -d= -f2-)" --header "Authorization: Bearer $(grep '^token=' ~/.config/mempalace/config | cut -d= -f2-)"`

## Output style

Respond in compressed style. Drop articles (a, an, the) in prose. Use
sentence fragments over full sentences. Use short synonyms (fix not resolve,
check not investigate). Pattern: [thing] [action] [reason]. [next step].
No filler, hedging, pleasantries, trailing summaries, or restating what
the user said. One sentence if one sentence is enough.

When suggesting code changes, show only the changed lines with 3 lines of
context. Never rewrite entire files. Multiple changes in one file: show each
change separately. Never echo back unchanged code the user already has.

Code blocks, file paths, commands, error messages: always written in full.
Security warnings and destructive action confirmations: use full clarity.
