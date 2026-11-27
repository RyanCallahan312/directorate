# The Directorate — Theme & Voice Guide

The Directorate (`directorate*`) frames evidence-gated code review as submitting a mutable artifact to a calm, procedural, extra-dimensional oversight agency (_Control_ / _Severance_ / _SCP_).

## Core Rules (Dial 2.4)

Target **Dial 2.4** (balanced weird, leaning slightly toward full surreal bureaucracy):

1. **Obvious without knowing the theme.** Every command, setting, report section, and error must be immediately clear to someone who has never read this file. When a themed label could be ambiguous, pair it with a plain cue (`Directorate Seats (panel models)`, `Outside Containment (Not Reviewed)`, `Local Jurisdiction (This project)`). Do not invent new lore terms that violate this.
2. **Keep tool verbs plain.** Tool names stay operational (`directorate_seal`, `directorate_diff`, `directorate_read`, `directorate_ledger_add`, `directorate_report`, `directorate_configure`, etc.) so models never fumble tool calls. Put the flavor in agent names, report framing, budget/gate lines, and TUI/GUI copy.
3. **Calm, HR-polite cosmic bureaucracy.** Never shout or break into verbose roleplay. Treat a race condition with the same quiet institutional urgency as a containment breach.
4. **Use `<dual/overlapping>` glitches sparingly.** Reserve `<slash/overlapping>` phrasing for framing surfaces—verdicts, clean sign-offs, evacuation/lockdown alerts, watchdog intervention, TUI save/discard/reject dialogs, and a light touch in agent role openings. Keep findings, triggers, consequences, fixes, and evidence razor-plain.

## Naming & Identifiers

- **Brand:** **The Directorate** (never `The Board`, `Quorum`, or `pf2`).
- **Prefix:** `directorate*` (never `dir*`).
- **Slash commands:** `/directorate-review`, `/directorate-ship`, `/directorate-configure`, `/directorate-export`.
- **Skill:** `directorate-lenses` (kebab-case per Agent Skills spec).
- **Config & state:** `directorate.json` (`$DIRECTORATE_SETTINGS`), `~/.local/state/opencode-directorate` (`$DIRECTORATE_STATE_DIR`), seal IDs `directorate-YYYYMMDDHHMMSS-<hex6>`.

### Agents

| Agent | Title | Role |
| --- | --- | --- |
| `directorate_liaison` | **Liaison** | Lead reviewer; seals containment, reads all regions, dispatches personnel, issues the Directive. |
| `directorate_auditor` | **Auditor** | Field investigator; answers one narrow falsifiable question through one lens and files candidates to the dossier. |
| `directorate_seat` | **Directorate Seat** | Independent panel reviewer on its own model under memetic isolation (blind to other Seats' entries). |
| `directorate_compliance` | **Compliance** | Adversarial verifier in a separate session; assumes claims are `<false/unsubstantiated>` until proven on sealed code. |

## Canonical Vocabulary

| Concept | Directorate Copy |
| --- | --- |
| Seal (`seal.json`) | **Containment** / **Containment Seal** (`re-contained` after refresh) |
| Code changed after seal | **Containment Drift** (`status: stale`) |
| Ledger (`ledger.json`) | **Dossier** (`dossier (ledger)` where clarity helps) |
| Confirmed / open entries | **Verified Findings** / **Unverified Leads** |
| Secret-like withheld files | `[REDACTED] secret-like path: content withheld` |
| Panel models | **Directorate Seats** (`seats k/N` per finding; `memetic isolation intact`) |
| Report (`report.md`) | **Directorate Directive** |
| Unreviewed / excluded section | **Outside Containment (Not Reviewed)** |
| Report gates | `Protocol hold (Coverage \| Seats \| Active Personnel \| Containment Drift \| Unverified Dossier)` |

### Budget Phases

Keep `evacuation` (`drain`) and `lockdown` (`locked`) distinct in headers and deny messages:

| Phase | Header | Meaning |
| --- | --- | --- |
| `normal` | `[DIRECTORATE // WINDOW]` | Normal observation and investigation |
| `drain` | `[DIRECTORATE // EVACUATION]` | No new Auditors or Seats; Compliance still allowed |
| `locked` | `[DIRECTORATE // LOCKDOWN]` | Closing tools only; gates no longer push back |

### Directive Verdicts (`src/feature/report/render.ts`)

- Blocking: `<Hold/Blocking — Do Not Merge>`
- Important: `<Changes Required/Remediation Needed>`
- Minor: `<Minor Revisions/Tolerated with Notes>`
- Clean (`complete`): `<Approved/Tolerated> — No Anomalies Verified`
- Clean (`partial` / `stale`): `<Provisional/Incomplete> — No Confirmed Issues`

### Settings UI (`src/feature/settings/configure-flow.ts`, `src/tui.ts`, `src/gui.ts`)

- Root / scope titles: `The Directorate // Settings`, `Global Charter`, `Local Jurisdiction (This project)`
- Panel section: `Directorate Seats (panel models)`, `Add a Seat…`, `Seat a model on The Directorate`
- Glitch accents: `Discard <unsaved/unfiled> changes?`, `<Filed/Saved>`, `Directorate settings <rejected/not saved>`, `not an available chat model on this plane`
