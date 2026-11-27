// Directorate settings: defaults for new reviews, from directorate.json. The store reads both files and replaces one
// scope's file; file.ts says how they merge.
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
import type { PlatformError } from "effect/PlatformError";

import { Git } from "../../platform/platform.ts";
import { mutationLocks } from "../../records/records.ts";
import {
  isGlobalScope,
  isUnset,
  merge,
  normalizeSettings,
  sameSettings,
  SettingsJson,
} from "./file.ts";
import type { Settings, SettingsScope as Scope } from "./file.ts";

/** A settings file that cannot be found, read, decoded, or written. */
export class SettingsUnavailable extends Schema.TaggedError<
  SettingsUnavailable,
  { readonly brand: unique symbol }
>()("SettingsUnavailable", {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}

/** `what` failed because of `error`, which is kept as the cause; `advice` says what to do about it. */
export const settingsUnavailable = (
  what: string,
  error: Error,
  advice?: string
) =>
  new SettingsUnavailable({
    cause: error,
    message: `${what}: ${error.message}${advice ? `. ${advice}` : ""}`,
  });

/** Another writer held the settings lock for as long as a save waits. */
export class SettingsBusy extends Schema.TaggedError<
  SettingsBusy,
  { readonly brand: unique symbol }
>()("SettingsBusy", { lock: Schema.String }) {
  override get message() {
    return `Settings are busy. Retry the save; if all writers have stopped, remove the lock directory at ${this.lock}.`;
  }
}

/** The settings file changed since the dialog that edits it opened. */
export class SettingsChanged extends Schema.TaggedError<
  SettingsChanged,
  { readonly brand: unique symbol }
>()("SettingsChanged", { at: Schema.String }) {
  override get message() {
    return `Settings at ${this.at} changed since this dialog opened. Reopen /directorate-configure and reapply your changes.`;
  }
}

/** A typo in a settings file is an error, not a silently ignored key. */
const decodeSettings = Schema.decodeEffect(SettingsJson);
const STRICT = { onExcessProperty: "error" } as const;

const make = Effect.gen(function* make() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git;
  const { locked, replace } = yield* mutationLocks;
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
            Config.orElse(() => Config.NonEmptyString("USERPROFILE")),
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
  const file = Effect.fn("Settings.file")(function* file(
    scope: Scope,
    directory: string
  ) {
    if (isGlobalScope(scope)) {
      return (
        globalFile ??
        (yield* new SettingsUnavailable({
          message:
            "No global settings file: none of DIRECTORATE_SETTINGS, OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, HOME, or USERPROFILE is set.",
        }))
      );
    }

    const top = Option.getOrElse(
      yield* git
        .rootOption(directory)
        .pipe(
          Effect.mapError((error) =>
            settingsUnavailable(
              `Cannot find the repository of ${directory}`,
              error
            )
          )
        ),
      () => directory
    );

    const at = path.join(top, ".opencode", "directorate.json");

    return at === globalFile ? undefined : at;
  });

  const read = Effect.fn("Settings.read")(function* read(at: string) {
    const text = yield* fs.readFileString(at).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () => Effect.undefined,
        (_, error) =>
          Effect.fail(settingsUnavailable(`Cannot read ${at}`, error))
      )
    );

    if (text === undefined) {
      return {};
    }

    return yield* decodeSettings(text, STRICT).pipe(
      Effect.mapError((error) =>
        settingsUnavailable(
          `${at} is not valid Directorate settings`,
          error,
          "Fix it, or delete it and run /directorate-configure."
        )
      )
    );
  });

  /** Both files and what they add up to. */
  const load = Effect.fn("Settings.load")(function* load(directory: string) {
    const projectFile = yield* file("project", directory);

    /** A file is absent when there is none to read or write: no global config directory, or no project file. */
    const files = {
      ...(globalFile && { global: globalFile }),
      ...(projectFile && { project: projectFile }),
    };

    const global = globalFile ? yield* read(globalFile) : {};
    const project = projectFile ? yield* read(projectFile) : {};

    return { effective: merge(global, project), files, global, project };
  });

  /** Resolves effective settings before replacing or removing one scope's file. */
  const write = Effect.fn("Settings.write")(function* write(
    scope: Scope,
    directory: string,
    input: Settings,
    previous?: Settings
  ) {
    const at =
      (yield* file(scope, directory)) ??
      (yield* new SettingsUnavailable({
        message: `No project settings here: ${globalFile} is the global file. Write the global scope, or configure from a project.`,
      }));

    const settings = normalizeSettings(input);
    const removed = isUnset(settings);

    const other = isGlobalScope(scope)
      ? yield* file("project", directory)
      : globalFile;

    const unchanged = other ? yield* read(other) : {};

    const effective = isGlobalScope(scope)
      ? merge(settings, unchanged)
      : merge(unchanged, settings);

    const fail = (e: PlatformError) =>
      Effect.fail(settingsUnavailable(`Cannot write ${at}`, e));

    const result = { effective, path: at, removed, settings };

    // Removing a file that is not there changes nothing: no directory to create, no lock to take.
    if (removed && !(yield* fs.exists(at).pipe(Effect.catch(fail)))) {
      return result;
    }

    yield* fs
      .makeDirectory(path.dirname(at), { recursive: true })
      .pipe(Effect.catch(fail));
    const lock = `${at}.lock`;
    yield* locked(
      at,
      lock,
      Effect.gen(function* replaceFile() {
        if (previous && !sameSettings(previous, yield* read(at))) {
          return yield* new SettingsChanged({ at });
        }

        if (removed) {
          return yield* fs.remove(at, { force: true }).pipe(Effect.catch(fail));
        }

        const text = yield* Schema.encodeEffect(SettingsJson)(settings).pipe(
          Effect.orDie
        );

        yield* replace(at, `${text}\n`, {
          prefix: ".directorate-settings-",
        }).pipe(Effect.catch(fail));
      })
    ).pipe(
      Effect.catchTags({
        LockBusy: () => Effect.fail(new SettingsBusy({ lock })),
        LockFailed: (error) =>
          Effect.fail(
            new SettingsUnavailable({
              cause: error,
              message: `Cannot lock ${at}: ${error.reason}`,
            })
          ),
      })
    );

    return result;
  });

  return { file, load, write };
});

export class SettingsStore extends Context.Service<
  SettingsStore,
  Effect.Success<typeof make>
>()("directorate/Settings") {
  static readonly layer = Layer.effect(SettingsStore, make.pipe(Effect.orDie));
}
