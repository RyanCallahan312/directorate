// /directorate-review: asks the session's agent to dispatch a Liaison for a review, or for a re-check after fixes.
import type { Plugin } from "@opencode/plugin/effect";
import type { CommandDefinition } from "@opencode/plugin/effect/command";
import { Effect } from "effect";

import { failure } from "../../platform/error.ts";
import { reviewRequest } from "./request.ts";

export const reviewCommand = (host: Plugin.Context) =>
  ({
    description:
      "Start a Directorate review [request, --scope branch|local|repository, or --recheck <seal>]",
    execute: ({ delivery, prompt, sessionID }) => {
      const again =
        /^\s*--recheck(?=\s|=|$)(?:(?:=|\s+)(?<seal>directorate-\S+))?/u.exec(
          prompt.text
        );

      if (again) {
        const seal = again.groups?.seal;
        const rest = prompt.text.slice(again[0].length).trim();

        if (rest.startsWith("=")) {
          return failure(
            "Use --recheck alone for the latest Directive, or --recheck <seal id> (directorate-…)."
          );
        }

        const which = seal ? `\`${seal}\`` : "the latest Directive";

        return host.session
          .prompt({
            ...prompt,
            delivery,
            sessionID,
            text: [
              rest ? `<user_request>\n${rest}\n</user_request>` : "",
              `Re-check ${which} after fixes${rest ? `, with the <user_request> above as its focus` : ""}. If you dispatched the directorate_liaison that issued it in this conversation, send that session a follow-up asking for the re-check. Otherwise dispatch directorate_liaison to re-check it: ${seal ? `tell it to pass recheck: "${seal}" to directorate_seal` : "it finds the latest reported seal with directorate_ledger_list and passes it as recheck to directorate_seal"}. Wait for the Liaison and relay its final Directive verbatim. Do not run the review yourself.`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          })
          .pipe(Effect.asVoid);
      }

      return Effect.gen(function* submitReview() {
        const text = yield* reviewRequest(prompt.text, "ask");
        yield* host.session.prompt({ ...prompt, delivery, sessionID, text });
      });
    },
    name: "directorate-review",
  }) satisfies CommandDefinition;
