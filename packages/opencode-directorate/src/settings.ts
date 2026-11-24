// Directorate settings: defaults for new reviews, from directorate.json. The project's file (<repo>/.opencode/directorate.json) overrides the
// global one (directorate.json in OpenCode's global config directory, ~/.config/opencode) key by key; a directorate_seal input overrides
// both.
import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import { failure } from "./error.ts";
import { Git } from "./git.ts";
import {
  DEFAULT_PANEL,
  isUnset,
  Mode,
  seatRef,
  Settings,
  type SettingsScope as Scope,
} from "./model.ts";

const SettingsJson = Schema.fromJsonString(Settings, { space: 2 });
/** A typo in a settings file is an error, not a silently ignored key. */
const decodeSettings = Schema.decodeEffect(SettingsJson);
const STRICT = { onExcessProperty: "error" } as const;

/** The project's settings over the global ones, key by key within each section. */
export const merge = (global: Settings, project: Settings): Settings => ({
  ...(global.default_scope && { default_scope: global.default_scope }),
  ...(project.default_scope && { default_scope: project.default_scope }),
  mode: project.mode ?? global.mode,
  budget_minutes:
    global.budget_minutes || project.budget_minutes
      ? { ...global.budget_minutes, ...project.budget_minutes }
      : undefined,
  panel:
    global.panel || project.panel
      ? { ...global.panel, ...project.panel }
      : undefined,
  lenses:
    global.lenses || project.lenses
      ? { ...global.lenses, ...project.lenses }
      : undefined,
});
/** What a new review gets from settings: its mode, whether it is a panel and with which seats, its budget, and lenses off. */
export const resolve = (
  s: Settings,
  input: {
    mode?: Mode;
    panel?: boolean;
    panelModels?: readonly string[];
    budgetMinutes?: number;
  }
) => {
  const mode = input.mode ?? s.mode ?? "default";
  const panel = input.panelModels?.length
    ? input.panelModels
    : (input.panel ?? s.panel?.enabled)
      ? (s.panel?.models?.map(seatRef) ?? DEFAULT_PANEL)
      : undefined;
  return {
    mode,
    panel,
    budgetMinutes: input.budgetMinutes ?? s.budget_minutes?.[mode],
    lensesOff: s.lenses?.disabled?.length ? s.lenses.disabled : undefined,
  };
};
/** One line for a model: the effective settings, or nothing when no file sets anything. */
export function describe(s: Settings): string | undefined {
  const parts = [
    s.mode && `mode ${s.mode}`,
    s.default_scope && `scope ${s.default_scope}`,
    s.panel?.enabled !== undefined && `panel ${s.panel.enabled ? "on" : "off"}`,
    s.panel?.models && `panel models ${s.panel.models.map(seatRef).join(", ")}`,
    s.budget_minutes &&
      `budgets ${Object.entries(s.budget_minutes)
        .map(([m, n]) => `${m} ${n} min`)
        .join(", ")}`,
    s.lenses?.disabled?.length && `lenses off ${s.lenses.disabled.join(", ")}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git;
  /**
   * DIRECTORATE_SETTINGS, else directorate.json in OpenCode's global config directory: OPENCODE_CONFIG_DIR, else
   * $XDG_CONFIG_HOME/opencode, else ~/.config/opencode. None without any of them.
   */
  const inDir = (dir: string) => path.join(dir, "directorate.json");
  const globalFile = Option.getOrUndefined(
    yield* Config.option(
      Config.NonEmptyString("DIRECTORATE_SETTINGS").pipe(
        Config.orElse(() =>
          Config.NonEmptyString("OPENCODE_CONFIG_DIR").pipe(Config.map(inDir))
        ),
        Config.orElse(() =>
          Config.NonEmptyString("XDG_CONFIG_HOME").pipe(
            Config.map((dir) => inDir(path.join(dir, "opencode")))
          )
        ),
        Config.orElse(() =>
          Config.NonEmptyString("HOME").pipe(
            Config.map((home) => inDir(path.join(home, ".config", "opencode")))
          )
        )
      )
    )
  );
  /**
   * The settings file for a scope; a project is its repository's top level, or the directory itself outside Git. When
   * that is the global file (OPENCODE_CONFIG_DIR=~/.opencode, run from home), there is no project file.
   */
  const file = Effect.fn("Settings.file")(function* (
    scope: Scope,
    directory: string
  ) {
    if (scope === "global")
      return (
        globalFile ??
        (yield* failure(
          "No global settings file: none of DIRECTORATE_SETTINGS, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, or HOME is set."
        ))
      );
    const top = yield* git
      .root(directory)
      .pipe(Effect.orElseSucceed(() => directory));
    const at = path.join(top, ".opencode", "directorate.json");
    return at === globalFile ? undefined : at;
  });
  const read = Effect.fn("Settings.read")(function* (at: string) {
    if (!(yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false))))
      return {};
    const text = yield* fs
      .readFileString(at)
      .pipe(Effect.catch((e) => failure(`Cannot read ${at}: ${e.message}`)));
    return yield* decodeSettings(text, STRICT).pipe(
      Effect.catch((e) =>
        failure(
          `${at} is not valid Directorate settings: ${e.message}. Fix it, or delete it and run /directorate-configure.`
        )
      )
    );
  });
  /** Both files and what they add up to. */
  const load = Effect.fn("Settings.load")(function* (directory: string) {
    const projectFile = yield* file("project", directory);
    const files = {
      global: globalFile ?? "(no global config directory)",
      project: projectFile,
    };
    const global = globalFile ? yield* read(globalFile) : {};
    const project = projectFile ? yield* read(projectFile) : {};
    return { files, global, project, effective: merge(global, project) };
  });
  /** Replaces one scope's file; settings with no key set remove it. */
  const write = Effect.fn("Settings.write")(function* (
    scope: Scope,
    directory: string,
    settings: Settings
  ) {
    const at =
      (yield* file(scope, directory)) ??
      (yield* failure(
        `No project settings here: ${globalFile} is the global file. Write the global scope, or configure from a project.`
      ));
    const fail = (e: { message: string }) =>
      failure(`Cannot write ${at}: ${e.message}`);
    if (isUnset(settings)) {
      yield* fs.remove(at, { force: true }).pipe(Effect.catch(fail));
      return at;
    }
    const text = yield* Schema.encodeEffect(SettingsJson)(settings).pipe(
      Effect.orDie
    );
    yield* fs
      .makeDirectory(path.dirname(at), { recursive: true })
      .pipe(Effect.catch(fail));
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tmp = yield* fs.makeTempFileScoped({
          directory: path.dirname(at),
          prefix: ".directorate-settings-",
        });
        yield* fs.writeFileString(tmp, `${text}\n`);
        yield* fs.rename(tmp, at);
      })
    ).pipe(Effect.catch(fail));
    return at;
  });
  return { file, load, write };
});

export class SettingsStore extends Context.Service<
  SettingsStore,
  Effect.Success<typeof make>
>()("directorate/Settings") {
  static readonly layer = Layer.effect(SettingsStore, make.pipe(Effect.orDie));
}
