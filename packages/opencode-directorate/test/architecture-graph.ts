// The import graph of src/ and the rules ARCHITECTURE.md sets on it ("Layout", "Slice anatomy", "Dependency bands"), and
// the files and primitive modules its Layout block lists.
// Modules are named by their path under src/ ("seal/record.ts"). The scanner is a regex over oxfmt-formatted source; the
// checker takes the graph in memory, so architecture.test.ts can exercise it on tiny graphs as well as on src/.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ImportRef {
  /** A module path under src/ for relative imports (it may start with "../" if it escapes src/), else the bare specifier. */
  readonly target: string;
  readonly local: boolean;
  /** `import type`, `export type`, or every specifier marked `type`: erased when the module runs. */
  readonly typeOnly: boolean;
}

export interface Module {
  readonly path: string;
  readonly imports: readonly ImportRef[];
  readonly exportsStar: boolean;
  /** Namespace imports the module re-exports by name (`import * as X from "…"; export { X };`). */
  readonly namespaceExports: readonly string[];
}

/** The `*`-marked modules of ARCHITECTURE.md's Layout (architecture.test.ts holds the two equal). Extend it deliberately. */
export const PRIMITIVE_MODULES: readonly string[] = [
  "exclusions.ts",
  "platform/stored.ts",
  "platform/error.ts",
  "platform/utf8.ts",
  "seal/record.ts",
  "seal/target.ts",
  "seal/region.ts",
  "seal/coverage.ts",
  "feature/agents/agent.ts",
  "feature/dispatch/lifecycle.ts",
  "feature/dispatch/seat.ts",
  "feature/ledger/entry.ts",
  "feature/ledger/decide.ts",
  "feature/report/directive.ts",
  "feature/report/gates.ts",
  "feature/report/render.ts",
  "feature/settings/file.ts",
  "feature/settings/configure-flow.ts",
  "feature/settings/configure-client.ts",
  "feature/settings/rpc.ts",
  "workflow/review/window.ts",
  "workflow/review/custody.ts",
  "workflow/review/request.ts",
  "workflow/review/ship-link.ts",
  "workflow/ship/state.ts",
  "workflow/ship/step.ts",
];

/** Bare specifiers a primitive may import beyond effect: the settings RPC definition is built with Rpc.define. */
export const PRIMITIVE_EXTRA_SPECIFIERS: ReadonlyMap<
  string,
  readonly string[]
> = new Map([["feature/settings/rpc.ts", ["@opencode/plugin/rpc"]]]);

/** The only files directly in src/. */
export const ROOT_MODULES: readonly string[] = [
  "index.ts",
  "tui.ts",
  "gui.ts",
  "rpc.ts",
  "exclusions.ts",
];

/** Dependency bands, lowest first. Features share one band: they are siblings. */
export const SLICE_BANDS: ReadonlyMap<string, number> = new Map([
  ["platform", 0],
  ["records", 1],
  ["seal", 2],
  ["feature/agents", 3],
  ["feature/dispatch", 3],
  ["feature/ledger", 3],
  ["feature/report", 3],
  ["feature/settings", 3],
  ["workflow/review", 4],
  ["workflow/ship", 5],
]);

/** Top-level directories under src/ that are slices themselves; feature/ and workflow/ hold one slice per directory. */
export const TOP_SLICES: ReadonlySet<string> = new Set([
  "platform",
  "records",
  "seal",
]);

const SLICE_GROUPS: ReadonlySet<string> = new Set(["feature", "workflow"]);

export interface Rules {
  readonly primitives: readonly string[];
  readonly primitiveExtras: ReadonlyMap<string, readonly string[]>;
  readonly bands: ReadonlyMap<string, number>;
}

export const RULES: Rules = {
  bands: SLICE_BANDS,
  primitiveExtras: PRIMITIVE_EXTRA_SPECIFIERS,
  primitives: PRIMITIVE_MODULES,
};

// ---------------------------------------------------------------------------
// Scanning

const STATIC_IMPORT =
  /^(?:import|export)\s+(?<type>type\s+)?(?<clause>\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s+from\s+"(?<specifier>[^"]+)";?/gmu;

const SIDE_EFFECT_IMPORT = /^import\s+"(?<specifier>[^"]+)";?/gmu;

const DYNAMIC_IMPORT = /\bimport\(\s*"(?<specifier>[^"]+)"\s*\)/gu;

const EXPORT_STAR = /^export\s+\*/mu;

const NAMESPACE_IMPORT =
  /^import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\*\s+as\s+(?<name>[\w$]+)\s+from\s/gmu;

/** `export { … }` without `from`: names declared or imported in the module itself. */
const LOCAL_EXPORT_LIST =
  /^export\s+(?:type\s+)?\{(?<names>[^}]*)\}(?!\s*from\s)/gmu;

/** The local names an `export { … }` list re-exports (`X`, `type X`, and `X as Y` all name `X`). */
const exportedLocals = (names: string) =>
  names
    .split(",")
    .map(
      (s) =>
        s
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0] ?? ""
    )
    .filter((s) => s !== "");

/** True when the clause is `{ ... }` and every specifier in it is marked `type`. */
const everySpecifierIsType = (clause: string) => {
  if (!clause.startsWith("{")) {
    return false;
  }

  const specifiers = clause
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  return specifiers.length > 0 && specifiers.every((s) => /^type\s/u.test(s));
};

const reference = (from: string, specifier: string, typeOnly: boolean) => {
  if (!specifier.startsWith(".")) {
    return { local: false, target: specifier, typeOnly };
  }

  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(from), specifier)
  );

  return { local: true, target, typeOnly };
};

/** One module's imports and re-exports, from its source text. */
export const scanModule = (modulePath: string, source: string): Module => {
  const imports: ImportRef[] = [];

  for (const { groups } of source.matchAll(STATIC_IMPORT)) {
    imports.push(
      reference(
        modulePath,
        groups?.specifier ?? "",
        groups?.type !== undefined || everySpecifierIsType(groups?.clause ?? "")
      )
    );
  }

  for (const { groups } of source.matchAll(SIDE_EFFECT_IMPORT)) {
    imports.push(reference(modulePath, groups?.specifier ?? "", false));
  }

  for (const { groups } of source.matchAll(DYNAMIC_IMPORT)) {
    imports.push(reference(modulePath, groups?.specifier ?? "", false));
  }

  const namespaces = new Set(
    [...source.matchAll(NAMESPACE_IMPORT)].map(({ groups }) => groups?.name)
  );

  const namespaceExports = [...source.matchAll(LOCAL_EXPORT_LIST)].flatMap(
    ({ groups }) =>
      exportedLocals(groups?.names ?? "").filter((n) => namespaces.has(n))
  );

  return {
    exportsStar: EXPORT_STAR.test(source),
    imports,
    namespaceExports,
    path: modulePath,
  };
};

const listTs = (root: string, dir: string): string[] =>
  readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = dir === "" ? entry.name : `${dir}/${entry.name}`;

      if (entry.isDirectory()) {
        return listTs(root, relative);
      }

      return entry.name.endsWith(".ts") ? [relative] : [];
    }
  );

/** Every .ts module under srcRoot, scanned. */
export const scanTree = (srcRoot: string): Module[] =>
  listTs(srcRoot, "")
    .toSorted()
    .map((p) => scanModule(p, readFileSync(path.join(srcRoot, p), "utf-8")));

// ---------------------------------------------------------------------------
// Classifying

export interface Placement {
  readonly kind: "root" | "entry" | "internal" | "unplaced";
  readonly primitive: boolean;
  /** The slice directory ("seal", "feature/ledger") for entries and internal modules. */
  readonly slice?: string;
}

/** The slice directory a module path sits in, if any. */
export const sliceOf = (modulePath: string) => {
  const parts = modulePath.split("/");
  const [top = ""] = parts;

  if (TOP_SLICES.has(top) && parts.length >= 2) {
    return top;
  }

  return SLICE_GROUPS.has(top) && parts.length >= 3
    ? `${top}/${parts[1]}`
    : undefined;
};

/** `<dir>/<basename(dir)>.ts`. */
export const entryOf = (slice: string) =>
  `${slice}/${path.posix.basename(slice)}.ts`;

export const placementOf = (rules: Rules, modulePath: string): Placement => {
  const primitive = rules.primitives.includes(modulePath);

  if (!modulePath.includes("/")) {
    return {
      kind: ROOT_MODULES.includes(modulePath) ? "root" : "unplaced",
      primitive,
    };
  }

  const slice = sliceOf(modulePath);

  if (slice === undefined) {
    return { kind: "unplaced", primitive };
  }

  return {
    kind: modulePath === entryOf(slice) ? "entry" : "internal",
    primitive,
    slice,
  };
};

// ---------------------------------------------------------------------------
// Checking

const PRIMITIVE_ONLY =
  "a primitive module may import only effect and other primitive modules";

const isEffect = (specifier: string) =>
  specifier === "effect" || specifier.startsWith("effect/");

/** Why a package entry may not import a non-primitive module, if it may not. */
const rootViolations = (importer: string, imported: string, to: Placement) => {
  if (importer === "index.ts") {
    return to.kind === "entry"
      ? []
      : ["index.ts may import only slice entries and primitive modules"];
  }

  // tui.ts and gui.ts ask the settings RPC; rpc.ts itself is held to primitives.
  if (importer !== "rpc.ts" && imported === "rpc.ts") {
    return [];
  }

  return [`${importer} may import only primitive modules`];
};

/** Why a slice's entry or internal module may not import a non-primitive module, if it may not. */
const sliceViolations = (rules: Rules, from: Placement, to: Placement) => {
  if (to.kind === "root") {
    return ["a slice module may not import a package entry"];
  }

  if (from.slice === to.slice) {
    return [];
  }

  if (to.kind === "internal") {
    return [`internal to ${to.slice}: import its entry or a primitive instead`];
  }

  const fromBand = rules.bands.get(from.slice ?? "");
  const toBand = rules.bands.get(to.slice ?? "");

  // A slice without a band is reported once, on its own modules.
  if (fromBand === undefined || toBand === undefined) {
    return [];
  }

  if (toBand === fromBand) {
    return [
      `${to.slice} is in the same band as ${from.slice} (features are siblings)`,
    ];
  }

  return toBand > fromBand
    ? [`${to.slice} is in a higher band than ${from.slice}`]
    : [];
};

/** Why importer may not import imported (both local modules), if it may not. */
const localViolations = (rules: Rules, importer: string, imported: string) => {
  const from = placementOf(rules, importer);
  const to = placementOf(rules, imported);

  // Unplaced modules are reported once, on their own.
  if (from.kind === "unplaced" || to.kind === "unplaced") {
    return [];
  }

  if (from.primitive) {
    return to.primitive ? [] : [PRIMITIVE_ONLY];
  }

  if (to.primitive) {
    return [];
  }

  return from.kind === "root"
    ? rootViolations(importer, imported, to)
    : sliceViolations(rules, from, to);
};

/** Rules about a module itself rather than one of its imports. */
const placementViolations = (rules: Rules, m: Module) => {
  const placement = placementOf(rules, m.path);
  const violations: string[] = [];

  if (placement.kind === "unplaced") {
    violations.push(
      m.path.includes("/")
        ? `${m.path}: not inside a slice directory (platform/, records/, seal/, feature/<name>/, workflow/<name>/)`
        : `${m.path}: not a root module; move it into its slice`
    );
  }

  if (placement.slice !== undefined && !rules.bands.has(placement.slice)) {
    violations.push(
      `${m.path}: slice ${placement.slice} has no band; add it to SLICE_BANDS`
    );
  }

  if (placement.slice !== undefined && m.exportsStar) {
    violations.push(
      `${m.path}: export * in a slice module; export selected names`
    );
  }

  for (const name of placement.slice === undefined ? [] : m.namespaceExports) {
    violations.push(
      `${m.path}: re-exports namespace ${name} in a slice module; export selected names`
    );
  }

  return violations;
};

/** One import's broken rules, as report lines. */
const importViolations = (
  rules: Rules,
  known: ReadonlySet<string>,
  m: Module,
  i: ImportRef
) => {
  if (!i.local) {
    const extras = rules.primitiveExtras.get(m.path) ?? [];

    return rules.primitives.includes(m.path) &&
      !isEffect(i.target) &&
      !extras.includes(i.target)
      ? [`${m.path} -> ${i.target}: ${PRIMITIVE_ONLY}`]
      : [];
  }

  if (!known.has(i.target)) {
    return [`${m.path} -> ${i.target}: no such module under src/`];
  }

  return localViolations(rules, m.path, i.target).map(
    (why) => `${m.path} -> ${i.target}: ${why}`
  );
};

/** One concrete cycle inside a strongly connected component: a shortest path from its first module back to it. */
const cycleThrough = (
  edges: ReadonlyMap<string, readonly string[]>,
  component: ReadonlySet<string>
) => {
  const [start = ""] = [...component].toSorted();
  const previous = new Map<string, string>();
  const queue = [start];

  for (const node of queue) {
    for (const next of edges.get(node) ?? []) {
      if (component.has(next) && !previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }

    if (previous.has(start)) {
      break;
    }
  }

  const cycle = [start];
  let node = previous.get(start);

  while (node !== undefined && node !== start) {
    cycle.unshift(node);
    node = previous.get(node);
  }

  return [start, ...cycle];
};

/** Value-import cycles, each as the modules around it (first module repeated last). Tarjan's SCCs. */
export const valueCycles = (modules: readonly Module[]) => {
  const known = new Set(modules.map((m) => m.path));

  const edges = new Map(
    modules.map((m) => [
      m.path,
      [
        ...new Set(
          m.imports.flatMap((i) =>
            i.local && !i.typeOnly && known.has(i.target) ? [i.target] : []
          )
        ),
      ],
    ])
  );

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (node: string) => {
    index.set(node, index.size);
    low.set(node, index.get(node) ?? 0);
    stack.push(node);
    onStack.add(node);

    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member = stack.pop();

      while (member !== undefined) {
        onStack.delete(member);
        component.push(member);

        if (member === node) {
          break;
        }

        member = stack.pop();
      }

      components.push(component);
    }
  };

  for (const m of modules) {
    if (!index.has(m.path)) {
      connect(m.path);
    }
  }

  return components.flatMap(([first = "", ...rest]) =>
    rest.length > 0 || (edges.get(first) ?? []).includes(first)
      ? [cycleThrough(edges, new Set([first, ...rest]))]
      : []
  );
};

/** Every broken rule, one line each: `<importer> -> <imported>: <rule>` or `<module>: <rule>`. */
export const checkBoundaries = (
  modules: readonly Module[],
  rules: Rules = RULES
) => {
  const known = new Set(modules.map((m) => m.path));

  const violations = modules.flatMap((m) => [
    ...placementViolations(rules, m),
    ...m.imports.flatMap((i) => importViolations(rules, known, m, i)),
  ]);

  const cycles = valueCycles(modules).map(
    (cycle) =>
      `${cycle[0]} -> ${cycle[1]}: value-import cycle ${cycle.join(" -> ")}`
  );

  return [...new Set([...violations, ...cycles])];
};

/** The local modules and bare specifiers reached from start through value imports. */
export const valueClosure = (modules: readonly Module[], start: string) => {
  const byPath = new Map(modules.map((m) => [m.path, m]));
  const reached = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [start];

  for (const current of queue) {
    if (reached.has(current)) {
      continue;
    }

    reached.add(current);

    for (const i of byPath.get(current)?.imports ?? []) {
      if (i.typeOnly) {
        continue;
      }

      if (i.local) {
        queue.push(i.target);
      } else {
        specifiers.add(i.target);
      }
    }
  }

  return {
    modules: [...reached].toSorted(),
    specifiers: [...specifiers].toSorted(),
  };
};

// ---------------------------------------------------------------------------
// The Layout block

export interface Layout {
  /** Every module the block lists, as a path under src/. */
  readonly files: readonly string[];
  /** The `*`-marked ones. */
  readonly primitives: readonly string[];
}

const TREE_LINE = /^(?<indent>(?:│ {3}| {4})*)(?:├──|└──) (?<body>.*)$/u;

const NAME = String.raw`[\w.-]+\.ts\*?`;

/** A `·`-separated run of module names at the start of a string. */
const NAME_LIST = new RegExp(String.raw`^${NAME}(?: · ${NAME})*`, "u");

const DIRECTORY = /^(?<dir>[\w-]+)\/(?<rest>.*)$/u;

/**
 * The modules ARCHITECTURE.md's fenced Layout block lists. Each tree line holds a directory (`seal/`), optionally followed
 * by its modules, or a `·`-separated run of modules; whatever follows the names is a comment.
 */
export const parseLayout = (markdown: string): Layout => {
  const section = markdown.split(/^## Layout$/mu)[1] ?? "";
  const block = /```text\n(?<tree>[\s\S]*?)```/u.exec(section)?.groups?.tree;

  if (block === undefined) {
    throw new Error("ARCHITECTURE.md has no ```text block under ## Layout");
  }

  const dirs: string[] = [];
  const files: string[] = [];
  const primitives: string[] = [];

  const add = (depth: number, names: string) => {
    for (const name of names.split(" · ")) {
      const file = [...dirs.slice(0, depth), name.replace(/\*$/u, "")].join(
        "/"
      );

      files.push(file);

      if (name.endsWith("*")) {
        primitives.push(file);
      }
    }
  };

  for (const line of block.split("\n")) {
    const match = TREE_LINE.exec(line);

    if (!match?.groups) {
      continue;
    }

    const depth = (match.groups.indent ?? "").length / 4;
    const body = match.groups.body ?? "";
    const directory = DIRECTORY.exec(body)?.groups;

    if (directory) {
      dirs.length = depth;
      dirs.push(directory.dir ?? "");

      const listed = NAME_LIST.exec((directory.rest ?? "").trim())?.[0];

      if (listed !== undefined) {
        add(depth + 1, listed);
      }

      continue;
    }

    const listed = NAME_LIST.exec(body)?.[0];

    if (listed === undefined) {
      throw new Error(`ARCHITECTURE.md Layout: cannot read line "${line}"`);
    }

    add(depth, listed);
  }

  return { files, primitives };
};
