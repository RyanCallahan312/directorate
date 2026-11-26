// Records leaving: the export tools and /directorate-export, which hand a past review to the user as an unredacted ZIP.
import type { Plugin } from "@opencode/plugin/effect";
import type { CommandDefinition } from "@opencode/plugin/effect/command";
import { Effect, Schema } from "effect";

import { optional, str } from "../platform/platform.ts";
import type { DefineTool } from "../platform/platform.ts";
import { exportReview, listExportReviews } from "./export.ts";

type ExportServices =
  | Effect.Services<ReturnType<typeof exportReview>>
  | Effect.Services<ReturnType<typeof listExportReviews>>;

export const exportTools = (tool: DefineTool<ExportServices>) => {
  tool({
    description:
      "List retained Directorate reviews in this project and its registered Git worktrees, newest seal IDs first. Continue with nextBefore. Returns review metadata, not transcripts or source. Use only when the user asks to list or export past Directorate reviews.",
    *execute(input, c) {
      const page = yield* listExportReviews(c.sessionID, input.before);

      return { content: JSON.stringify(page) };
    },
    harness: false,
    input: Schema.Struct({ before: optional(str) }),
    name: "directorate_export_list",
  });

  tool({
    description:
      "Write a full, unredacted ZIP for one existing Directorate seal to the local exports directory. Use only when the user requests an export. Returns the saved path and warns of unavailable data; does not upload anything.",
    *execute(input) {
      return { content: yield* exportReview(input.seal) };
    },
    harness: false,
    input: Schema.Struct({ seal: str }),
    name: "directorate_export",
  });
};

export const exportCommand = (host: Plugin.Context) =>
  ({
    description:
      "Export full, unredacted Directorate reviews [seal ID or request in plain language]",
    execute: ({ delivery, prompt, sessionID }) =>
      host.session
        .prompt({
          ...prompt,
          delivery,
          sessionID,
          text: [
            "Handle the user's Directorate export request in <user_request> below. If it names a seal ID, use it directly. Otherwise call directorate_export_list to find retained reviews in the current project. For a blank request, use activeSeal or the first (newest) review. For a range or other selection, use the listing's UTC clock and review metadata, following nextBefore until all applicable pages have been checked. For time ranges use reportedAt when present, otherwise createdAt; interpret 'in the last month' as the rolling last 30 days unless the user specifies a calendar month. Ask if the scope is unclear; never silently broaden it. If a non-ID request matches more than 3 reviews, list the matches and ask the user to confirm before calling directorate_export.",
            "Call directorate_export once per matching seal ID. Export existing reviews only; do not start a review. Do not open, attach, or upload the resulting unredacted ZIPs. Report their paths and any missing data or failed exports. If there are no matches, say so; pruned reviews cannot be recovered.",
            `<user_request>\n${prompt.text}\n</user_request>`,
          ].join("\n\n"),
        })
        .pipe(Effect.asVoid),
    name: "directorate-export",
  }) satisfies CommandDefinition;
