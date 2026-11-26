import { Config, Context, Effect, Layer, Path } from "effect";

/** Where seals live: DIRECTORATE_STATE_DIR, else $XDG_STATE_HOME/opencode-directorate, else ~/.local/state/opencode-directorate. */
export class StateRoot extends Context.Service<StateRoot, string>()(
  "directorate/StateRoot"
) {
  static readonly layer = Layer.effect(
    StateRoot,
    Effect.gen(function* layer() {
      const path = yield* Path.Path;

      return yield* Config.NonEmptyString("DIRECTORATE_STATE_DIR").pipe(
        Config.orElse(() =>
          Config.NonEmptyString("XDG_STATE_HOME").pipe(
            Config.map((dir) => path.join(dir, "opencode-directorate"))
          )
        ),
        Config.orElse(() =>
          Config.NonEmptyString("HOME").pipe(
            Config.orElse(() => Config.NonEmptyString("USERPROFILE")),
            Config.map((home) =>
              path.join(home, ".local", "state", "opencode-directorate")
            )
          )
        )
      );
    }).pipe(Effect.orDie)
  );
}
