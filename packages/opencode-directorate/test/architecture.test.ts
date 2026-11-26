// Guardrails for ARCHITECTURE.md: the GUI bundle stays effect-only, every slice entry loads on its own, imports follow
// the bands, and the Layout block lists exactly src/'s modules and primitives. The checker and the Layout parser are
// tested on small inputs first, so a pass on src/ means something.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  checkBoundaries,
  entryOf,
  parseLayout,
  PRIMITIVE_MODULES,
  ROOT_MODULES,
  RULES,
  scanModule,
  scanTree,
  TOP_SLICES,
  valueClosure,
} from "./architecture-graph.ts";
import type { ImportRef, Module } from "./architecture-graph.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

const srcRoot = path.join(packageRoot, "src");

const builtGui = path.join(packageRoot, "dist", "gui-experimental.cjs");

const architectureDoc = path.join(packageRoot, "ARCHITECTURE.md");

const graph = scanTree(srcRoot);

// ---------------------------------------------------------------------------
// The scanner

test("the scanner tells value imports from type-only imports", () => {
  const scanned = scanModule(
    "feature/ledger/ledger.ts",
    [
      'import { Effect } from "effect";',
      'import type { Seal } from "../../seal/record.ts";',
      "import {",
      "  type Entry,",
      "  type Verdict,",
      '} from "./entry.ts";',
      'import { decide, type Rule } from "./decide.ts";',
      'import * as Platform from "../../platform/platform.ts";',
      'export { gates } from "../report/gates.ts";',
      'export type { Window } from "../../workflow/review/window.ts";',
      'import "./side-effect.ts";',
      'const later = () => import("./later.ts");',
      'export * from "./everything.ts";',
    ].join("\n")
  );

  assert.deepEqual(
    scanned.imports.map((i) => [i.target, i.local, i.typeOnly]),
    [
      ["effect", false, false],
      ["seal/record.ts", true, true],
      ["feature/ledger/entry.ts", true, true],
      ["feature/ledger/decide.ts", true, false],
      ["platform/platform.ts", true, false],
      ["feature/report/gates.ts", true, false],
      ["workflow/review/window.ts", true, true],
      ["feature/ledger/everything.ts", true, false],
      ["feature/ledger/side-effect.ts", true, false],
      ["feature/ledger/later.ts", true, false],
    ]
  );

  assert.equal(scanned.exportsStar, true);
  assert.deepEqual(scanned.namespaceExports, []);
});

test("the scanner finds namespace imports a module re-exports", () => {
  const scanned = scanModule(
    "seal/seal.ts",
    [
      'import * as Capture from "./capture.ts";',
      'import type * as Views from "./views.ts";',
      'import * as Ends from "./ends.ts";',
      'import { Sessions } from "./sessions.ts";',
      "export {",
      "  Capture,",
      "  type Views as ReadViews,",
      "  Sessions,",
      "};",
      'export { Ends } from "./elsewhere.ts";',
    ].join("\n")
  );

  assert.equal(scanned.exportsStar, false);
  assert.deepEqual(scanned.namespaceExports, ["Capture", "Views"]);
});

test("the scanner finds the imports src/ has today", () => {
  const gui = graph.find((m) => m.path === "gui.ts");

  assert.ok(gui, "src/gui.ts was not scanned");

  assert.deepEqual(
    gui.imports.map((i) => [i.target, i.typeOnly]),
    [
      ["@opencode/plugin/gui", false],
      ["@opencode/plugin/gui", true],
      ["feature/settings/configure-client.ts", false],
      ["feature/settings/configure-flow.ts", true],
      ["rpc.ts", false],
    ]
  );
});

// ---------------------------------------------------------------------------
// The checker on in-memory graphs

const value = (target: string): ImportRef => ({
  local: !target.includes(":") && target.endsWith(".ts"),
  target,
  typeOnly: false,
});

const typeOnly = (target: string): ImportRef => ({
  local: true,
  target,
  typeOnly: true,
});

const mod = (modulePath: string, ...imports: ImportRef[]): Module => ({
  exportsStar: false,
  imports,
  namespaceExports: [],
  path: modulePath,
});

/** Modules every in-memory graph can import, so only the edge under test can break a rule. */
const layout = [
  mod("platform/platform.ts"),
  mod("platform/stored.ts"),
  mod("platform/git.ts"),
  mod("records/records.ts"),
  mod("seal/seal.ts"),
  mod("seal/record.ts"),
  mod("seal/capture.ts"),
  mod("feature/agents/agents.ts"),
  mod("feature/agents/agent.ts"),
  mod("feature/dispatch/dispatch.ts"),
  mod("feature/dispatch/lifecycle.ts"),
  mod("feature/dispatch/events.ts"),
  mod("feature/ledger/ledger.ts"),
  mod("feature/settings/rpc.ts"),
  mod("workflow/review/review.ts"),
  mod("workflow/review/window.ts"),
  mod("workflow/review/watchdog.ts"),
  mod("workflow/ship/ship.ts"),
];

/** The layout with the given modules replacing their namesakes. */
const withModules = (...modules: Module[]) => [
  ...layout.filter((m) => !modules.some((n) => n.path === m.path)),
  ...modules,
];

const check = (...modules: Module[]) =>
  checkBoundaries(withModules(...modules), RULES);

test("the checker passes a legal workflow -> feature -> seal -> platform chain", () => {
  assert.deepEqual(
    check(
      mod(
        "workflow/ship/ship.ts",
        value("workflow/review/review.ts"),
        value("workflow/ship/state.ts")
      ),
      mod("workflow/ship/state.ts", value("effect")),
      mod(
        "workflow/review/review.ts",
        value("feature/dispatch/dispatch.ts"),
        value("workflow/review/watchdog.ts"),
        value("feature/agents/agent.ts")
      ),
      mod(
        "feature/dispatch/dispatch.ts",
        value("seal/seal.ts"),
        value("feature/dispatch/events.ts"),
        value("@opencode/plugin/effect")
      ),
      mod(
        "seal/seal.ts",
        value("platform/platform.ts"),
        value("seal/capture.ts")
      ),
      mod(
        "seal/record.ts",
        value("workflow/review/window.ts"),
        value("effect/Schema")
      ),
      mod("platform/platform.ts", value("platform/git.ts"), value("node:fs")),
      mod("index.ts", value("workflow/ship/ship.ts"), value("seal/record.ts")),
      mod("gui.ts", value("feature/settings/rpc.ts"), value("rpc.ts")),
      mod("rpc.ts", value("feature/settings/rpc.ts")),
      mod("feature/settings/rpc.ts", value("@opencode/plugin/rpc"))
    ),
    []
  );
});

test("the checker rejects a primitive importing an entry or a host package", () => {
  assert.deepEqual(
    check(
      mod("seal/record.ts", value("seal/seal.ts")),
      mod("feature/agents/agent.ts", value("@opencode/plugin/effect"))
    ),
    [
      "seal/record.ts -> seal/seal.ts: a primitive module may import only effect and other primitive modules",
      "feature/agents/agent.ts -> @opencode/plugin/effect: a primitive module may import only effect and other primitive modules",
    ]
  );
});

test("the checker rejects a feature importing a sibling feature's entry", () => {
  assert.deepEqual(
    check(
      mod("feature/ledger/ledger.ts", value("feature/dispatch/dispatch.ts"))
    ),
    [
      "feature/ledger/ledger.ts -> feature/dispatch/dispatch.ts: feature/dispatch is in the same band as feature/ledger (features are siblings)",
    ]
  );
});

test("the checker rejects a lower band importing a higher entry", () => {
  assert.deepEqual(
    check(
      mod("seal/seal.ts", typeOnly("feature/dispatch/dispatch.ts")),
      mod("workflow/review/review.ts", value("workflow/ship/ship.ts"))
    ),
    [
      "seal/seal.ts -> feature/dispatch/dispatch.ts: feature/dispatch is in a higher band than seal",
      "workflow/review/review.ts -> workflow/ship/ship.ts: workflow/ship is in a higher band than workflow/review",
    ]
  );
});

test("the checker rejects importing another slice's internal module", () => {
  assert.deepEqual(
    check(
      mod("workflow/review/review.ts", value("feature/dispatch/events.ts")),
      mod("index.ts", value("seal/capture.ts"))
    ),
    [
      "workflow/review/review.ts -> feature/dispatch/events.ts: internal to feature/dispatch: import its entry or a primitive instead",
      "index.ts -> seal/capture.ts: index.ts may import only slice entries and primitive modules",
    ]
  );
});

test("the checker rejects a value cycle and passes a type-only one", () => {
  assert.deepEqual(
    check(
      mod("seal/record.ts", value("workflow/review/window.ts")),
      mod("workflow/review/window.ts", value("seal/record.ts"))
    ),
    [
      "seal/record.ts -> workflow/review/window.ts: value-import cycle seal/record.ts -> workflow/review/window.ts -> seal/record.ts",
    ]
  );

  assert.deepEqual(
    check(
      mod("seal/record.ts", value("workflow/review/window.ts")),
      mod("workflow/review/window.ts", typeOnly("seal/record.ts"))
    ),
    []
  );
});

test("the checker rejects package-entry, placement, and export * mistakes", () => {
  assert.deepEqual(
    check(
      mod("tui.ts", value("feature/settings/settings.ts")),
      mod("feature/settings/settings.ts", value("rpc.ts")),
      { ...mod("seal/seal.ts"), exportsStar: true },
      { ...mod("feature/ledger/ledger.ts"), namespaceExports: ["Entry"] },
      mod("feature/stray.ts"),
      mod("leftover.ts"),
      mod("workflow/audit/audit.ts", value("seal/missing.ts")),
      mod("rpc.ts")
    ),
    [
      "tui.ts -> feature/settings/settings.ts: tui.ts may import only primitive modules",
      "feature/settings/settings.ts -> rpc.ts: a slice module may not import a package entry",
      "seal/seal.ts: export * in a slice module; export selected names",
      "feature/ledger/ledger.ts: re-exports namespace Entry in a slice module; export selected names",
      "feature/stray.ts: not inside a slice directory (platform/, records/, seal/, feature/<name>/, workflow/<name>/)",
      "leftover.ts: not a root module; move it into its slice",
      "workflow/audit/audit.ts: slice workflow/audit has no band; add it to SLICE_BANDS",
      "workflow/audit/audit.ts -> seal/missing.ts: no such module under src/",
    ]
  );
});

test("a module directly in src/ other than the root modules breaks no import rule but is reported", () => {
  assert.deepEqual(
    check(
      mod("seal/record.ts", value("model.ts")),
      mod("model.ts", value("seal/capture.ts"), value("node:fs"))
    ),
    ["model.ts: not a root module; move it into its slice"]
  );
});

test("the Layout parser reads directories, module runs, stars, and comments", () => {
  const markdown = [
    "## Layout",
    "",
    "```text",
    "src/",
    "├── index.ts                composition root",
    "├── tui.ts · gui.ts package entries (gui.ts re-exports x.ts)",
    "├── exclusions.ts*          shared kernel",
    "├── platform/               seams · and more",
    "│   ├── platform.ts         entry",
    "│   ├── stored.ts*          since · Time",
    "│   └── error.ts* · git.ts",
    "└── feature/",
    "    └── ledger/             ledger.ts · entry.ts* · tools.ts",
    "```",
    "",
    "`*` marks a primitive module.",
  ].join("\n");

  assert.deepEqual(parseLayout(markdown), {
    files: [
      "index.ts",
      "tui.ts",
      "gui.ts",
      "exclusions.ts",
      "platform/platform.ts",
      "platform/stored.ts",
      "platform/error.ts",
      "platform/git.ts",
      "feature/ledger/ledger.ts",
      "feature/ledger/entry.ts",
      "feature/ledger/tools.ts",
    ],
    primitives: [
      "exclusions.ts",
      "platform/stored.ts",
      "platform/error.ts",
      "feature/ledger/entry.ts",
    ],
  });
});

// ---------------------------------------------------------------------------
// src/ today

test("src/ follows the import boundaries", () => {
  const violations = checkBoundaries(graph);

  assert.deepEqual(
    violations,
    [],
    `${violations.length} import boundary violation(s):\n${violations.join("\n")}`
  );
});

test("the only files directly in src/ are the root modules and AGENTS.md", () => {
  const extra = readdirSync(srcRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name !== "AGENTS.md" &&
        !ROOT_MODULES.includes(entry.name)
    )
    .map(
      (entry) =>
        `src/${entry.name} is not a root module (${ROOT_MODULES.join(", ")}); move it into its slice`
    );

  assert.deepEqual(extra, []);
});

test("ARCHITECTURE.md's Layout lists every module under src/ and nothing else", () => {
  const listed = parseLayout(readFileSync(architectureDoc, "utf-8")).files;
  const modules = graph.map((m) => m.path);

  const problems = [
    ...modules
      .filter((m) => !listed.includes(m))
      .map((m) => `src/${m} is missing from the Layout block`),
    ...listed
      .filter((f) => !modules.includes(f))
      .map((f) => `the Layout block lists ${f}, which is not under src/`),
  ];

  assert.deepEqual(problems, [], problems.join("\n"));
});

test("the Layout's *-marked modules are exactly PRIMITIVE_MODULES", () => {
  const { primitives } = parseLayout(readFileSync(architectureDoc, "utf-8"));

  const problems = [
    ...PRIMITIVE_MODULES.filter((m) => !primitives.includes(m)).map(
      (m) => `${m} is in PRIMITIVE_MODULES but not marked * in the Layout`
    ),
    ...primitives
      .filter((m) => !PRIMITIVE_MODULES.includes(m))
      .map(
        (m) => `${m} is marked * in the Layout but not in PRIMITIVE_MODULES`
      ),
  ];

  assert.deepEqual(problems, [], problems.join("\n"));
});

// ---------------------------------------------------------------------------
// The GUI bundle and the other package entries

/** What the desktop app supplies to the GUI bundle (ARCHITECTURE.md "Two forces"). */
const GUI_ALLOWED = ["@opencode/plugin/gui", "@opencode/plugin/rpc"];

/** The TUI part runs in the terminal host, which supplies its own plugin API besides the settings RPC client. */
const TUI_ALLOWED = ["@opencode/plugin/tui", "@opencode/plugin/rpc"];

/** The settings RPC definition alone. */
const RPC_ALLOWED = ["@opencode/plugin/rpc"];

const allowedBy = (extras: readonly string[]) => (specifier: string) =>
  specifier === "effect" ||
  specifier.startsWith("effect/") ||
  extras.some(
    (extra) => specifier === extra || specifier.startsWith(`${extra}/`)
  );

for (const [entry, extras] of [
  ["gui.ts", GUI_ALLOWED],
  ["tui.ts", TUI_ALLOWED],
  ["rpc.ts", RPC_ALLOWED],
] as const) {
  test(`${entry} reaches only effect and ${extras.join(", ")}`, (t) => {
    const closure = valueClosure(graph, entry);

    t.diagnostic(`${entry} reaches modules: ${closure.modules.join(", ")}`);
    t.diagnostic(`${entry} reaches packages: ${closure.specifiers.join(", ")}`);

    assert.deepEqual(
      closure.specifiers.filter((s) => !allowedBy(extras)(s)),
      [],
      `${entry} reaches packages its host does not supply, through ${closure.modules.join(", ")}`
    );
  });
}

test("the built GUI bundle requires only effect and @opencode/plugin/{gui,rpc}", (t) => {
  if (!existsSync(builtGui)) {
    t.skip(
      "dist/gui-experimental.cjs is missing: run `bun run build` (bun run check builds it first)"
    );

    return;
  }

  const required = [
    ...new Set(
      [
        ...readFileSync(builtGui, "utf-8").matchAll(
          /\brequire\(\s*["'](?<specifier>[^"']+)["']\s*\)/gu
        ),
      ].map(({ groups }) => groups?.specifier ?? "")
    ),
  ].toSorted();

  t.diagnostic(`dist/gui-experimental.cjs requires: ${required.join(", ")}`);

  assert.deepEqual(
    required.filter((s) => !allowedBy(GUI_ALLOWED)(s)),
    []
  );
});

// ---------------------------------------------------------------------------
// Every entry loads on its own

/** The directories directly under src/<parent>, as slice paths. */
const directoriesIn = (parent: string) =>
  existsSync(path.join(srcRoot, parent))
    ? readdirSync(path.join(srcRoot, parent), { withFileTypes: true }).flatMap(
        (entry) => (entry.isDirectory() ? [`${parent}/${entry.name}`] : [])
      )
    : [];

const sliceDirectories = () => [
  ...[...TOP_SLICES].filter((dir) => existsSync(path.join(srcRoot, dir))),
  ...directoriesIn("feature"),
  ...directoriesIn("workflow"),
];

const run = promisify(execFile);

/** Imports one module in a fresh node process; resolves to the failure (with its stderr) as a one-item list, else none. */
const loadAlone = async (modulePath: string) => {
  const url = pathToFileURL(path.join(srcRoot, modulePath)).href;

  try {
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(url)});`,
      ],
      { cwd: packageRoot, timeout: 60_000 }
    );

    return [];
  } catch (error) {
    return [`${modulePath} failed to load on its own:\n${String(error)}`];
  }
};

test("every slice has its entry", () => {
  const missing = sliceDirectories()
    .map(entryOf)
    .filter((entry) => !existsSync(path.join(srcRoot, entry)));

  assert.deepEqual(missing, [], `missing slice entries: ${missing.join(", ")}`);
});

test("every slice entry and package entry loads in a fresh node process", async () => {
  const entries = [
    ...sliceDirectories()
      .map(entryOf)
      .filter((entry) => existsSync(path.join(srcRoot, entry))),
    "index.ts",
    "rpc.ts",
    "tui.ts",
    "gui.ts",
  ];

  const results = await Promise.all(entries.map(loadAlone));
  const failures = results.flat();

  assert.deepEqual(failures, [], failures.join("\n\n"));
});
