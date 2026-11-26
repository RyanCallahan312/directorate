import { Agent, Skill } from "@opencode/plugin/effect";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { Yaml } from "effect/encoding";

import { ROLES } from "./feature/agents/agent.ts";
import { Host } from "./platform/platform.ts";

const AgentFrontmatter = Schema.Struct({
  color: Agent.Info.fields.color,
  description: Agent.Info.fields.description,
  hidden: Schema.optionalKey(Schema.Boolean),
  mode: Agent.Info.fields.mode,
  permissions: Agent.Info.fields.permissions,
  steps: Agent.Info.fields.steps,
});

const SkillFrontmatter = Schema.Struct({
  description: Schema.String,
  metadata: Schema.Struct({ "opencode/autoinvoke": Schema.Boolean }),
  name: Skill.Name,
});

class MissingFrontmatter extends Data.TaggedError("MissingFrontmatter")<{
  readonly message: string;
}> {}

const readMarkdown = Effect.fn("Directorate.readMarkdown")(
  function* readMarkdown(url: URL) {
    const paths = yield* Path.Path;
    const path = yield* paths.fromFileUrl(url);
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(path);
    const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n/u.exec(text);
    const yaml = match?.groups?.yaml;

    if (!match || yaml === undefined) {
      return yield* new MissingFrontmatter({
        message: `Missing frontmatter: ${path}`,
      });
    }

    const data = yield* Effect.try(() => Yaml.parse(yaml));

    return { content: text.slice(match[0].length).trim(), data, path };
  }
);

export const registerBundled = Effect.fn("Directorate.registerBundled")(
  function* registerBundled() {
    const host = yield* Host;

    const agents = yield* Effect.forEach([...ROLES], (id) =>
      Effect.gen(function* loadAgent() {
        const { data, content } = yield* readMarkdown(
          new URL(`../agents/${id}.md`, import.meta.url)
        );

        const fields =
          yield* Schema.decodeUnknownEffect(AgentFrontmatter)(data);

        return { fields, id, system: content };
      })
    );

    const skill = yield* readMarkdown(
      new URL("../skills/directorate-lenses/SKILL.md", import.meta.url)
    );

    const { name, description, metadata } = yield* Schema.decodeUnknownEffect(
      SkillFrontmatter
    )(skill.data);

    const skillID = Skill.ID.make("directorate-lenses");

    yield* host.agent.transform((editor) => {
      for (const { id, fields, system } of agents) {
        if (editor.get(id)) {
          continue;
        }

        // On OpenCode 2.4.1, update creates an agent when the ID is missing.
        editor.update(id, (agent) => {
          Object.assign(agent, fields, {
            permissions: fields.permissions.map((rule) => ({ ...rule })),
            system,
          });
        });
      }
    });
    yield* host.skill.transform((editor) => {
      if (editor.get(skillID)) {
        return;
      }

      editor.add(
        Skill.Info.make({
          autoinvoke: metadata["opencode/autoinvoke"],
          content: skill.content,
          description,
          id: skillID,
          name,
          path: Skill.Info.fields.path.make(skill.path),
        })
      );
    });
  },
  Effect.orDie
);
