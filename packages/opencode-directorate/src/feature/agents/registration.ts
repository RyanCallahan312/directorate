import { Agent, Skill } from "@opencode/plugin/effect";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Yaml } from "effect/encoding";

import { Host } from "../../platform/platform.ts";
import { AgentIdSchema } from "./agent.ts";

const AgentFrontmatterSchema = Schema.Struct({
  color: Agent.Info.fields.color,
  description: Agent.Info.fields.description,
  hidden: Schema.optionalKey(Schema.Boolean),
  mode: Agent.Info.fields.mode,
  permissions: Agent.Info.fields.permissions,
  steps: Agent.Info.fields.steps,
});

const SkillFrontmatterSchema = Schema.Struct({
  description: Schema.String,
  metadata: Schema.Struct({ "opencode/autoinvoke": Schema.Boolean }),
  name: Skill.Name,
});

/** A bundled agent or skill file that could not be read, has no YAML frontmatter, or whose frontmatter does not decode. */
export class BundledFileInvalid extends Schema.TaggedError<
  BundledFileInvalid,
  { readonly brand: unique symbol }
>()("BundledFileInvalid", { cause: Schema.Defect(), path: Schema.String }) {
  override get message() {
    const reason =
      this.cause instanceof Error ? this.cause.message : String(this.cause);

    return `Invalid bundled file ${this.path}: ${reason}`;
  }
}

const invalid = (path: string) => (cause: unknown) =>
  new BundledFileInvalid({ cause, path });

/** A bundled markdown file's text split into its parsed YAML frontmatter and its trimmed body. */
export const parseMarkdown = Effect.fnUntraced(function* parseMarkdown(
  path: string,
  text: string
) {
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n/u.exec(text);
  const yaml = match?.groups?.yaml;

  if (!match || yaml === undefined) {
    return yield* invalid(path)("missing YAML frontmatter");
  }

  const data = yield* Effect.try({
    catch: invalid(path),
    try: () => Yaml.parse(yaml),
  });

  return { content: text.slice(match[0].length).trim(), data, path };
});

const readMarkdown = Effect.fn("Directorate.readMarkdown")(
  function* readMarkdown(url: URL) {
    const paths = yield* Path.Path;

    const path = yield* paths
      .fromFileUrl(url)
      .pipe(Effect.mapError(invalid(url.href)));

    const fs = yield* FileSystem.FileSystem;

    const text = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError(invalid(path)));

    return yield* parseMarkdown(path, text);
  }
);

export const registerBundled = Effect.fn("Directorate.registerBundled")(
  function* registerBundled() {
    const host = yield* Host;

    const agents = yield* Effect.forEach([...AgentIdSchema.literals], (id) =>
      Effect.gen(function* loadAgent() {
        const { data, content, path } = yield* readMarkdown(
          new URL(`../../../agents/${id}.md`, import.meta.url)
        );

        const fields = yield* Schema.decodeUnknownEffect(
          AgentFrontmatterSchema
        )(data).pipe(Effect.mapError(invalid(path)));

        return { fields, id, system: content };
      })
    );

    const skill = yield* readMarkdown(
      new URL("../../../skills/directorate-lenses/SKILL.md", import.meta.url)
    );

    const { name, description, metadata } = yield* Schema.decodeUnknownEffect(
      SkillFrontmatterSchema
    )(skill.data).pipe(Effect.mapError(invalid(skill.path)));

    const skillID = Skill.ID.make("directorate-lenses");

    yield* host.agent.transform((editor) => {
      for (const { id, fields, system } of agents) {
        if (editor.get(id)) {
          continue;
        }

        // OpenCode's editor.update creates an agent when the ID is missing.
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
