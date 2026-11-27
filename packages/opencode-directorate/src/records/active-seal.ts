// The ActiveSeal port: what records needs to know about the seal a session works on. Declared here, provided by seal/.
import { Context } from "effect";
import type { Effect } from "effect";

import type { SessionId } from "../platform/host-id.ts";
import type { Seal } from "../seal/record.ts";

export class ActiveSeal extends Context.Service<
  ActiveSeal,
  {
    /** The unreported seal this session belongs to, if any. */
    readonly active: (sessionID: SessionId) => Effect.Effect<Seal | undefined>;
    /** The session's working directory, if the host still knows the session. */
    readonly directory: (
      sessionID: SessionId
    ) => Effect.Effect<string | undefined>;
  }
>()("directorate/ActiveSeal") {}
