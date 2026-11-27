import type { Plugin } from "@opencode/plugin/effect";
import { Context } from "effect";

/** The OpenCode host, as it gave itself to the plugin. */
export class Host extends Context.Service<Host, Plugin.Context>()(
  "directorate/Host"
) {}
