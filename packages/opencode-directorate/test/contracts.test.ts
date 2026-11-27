// Stored contracts: seal.json, ledger.json, directorate.json, and ship state outlive the code that wrote them. Each
// fixture under test/stored/ is in the exact bytes Directorate writes and must survive decode → encode unchanged. A
// hand-edited directorate.json is normalized when written, so its normalized fixtures re-encode to their committed
// *.expected.json golden.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Schema, SchemaAST } from "effect";

// ---------- Stored codecs under test ----------
// Moving a codec updates only these import paths; nothing below depends on where the schemas live.
import { LedgerJson } from "../src/feature/ledger/entry.ts";
import {
  normalizeSettings,
  SettingsJson,
} from "../src/feature/settings/file.ts";
import { SealJson } from "../src/seal/record.ts";
import { ShipStateFromStored } from "../src/workflow/ship/state.ts";
// ---------- end stored codecs ----------

/** The host's plugin storage holds ship state as a JSON value under `ship:<sessionID>`; it is stored as this text. */
const ShipJson = Schema.fromJsonString(ShipStateFromStored, { space: 2 });

const read = (name: string) =>
  readFileSync(new URL(`stored/${name}`, import.meta.url), "utf-8");

/** What each contract's reader and writer do to stored text, end to end. */
const sealRoundTrip = (text: string) =>
  Schema.encodeSync(SealJson)(Schema.decodeSync(SealJson)(text));

const ledgerRoundTrip = (text: string) =>
  Schema.encodeSync(LedgerJson)(Schema.decodeSync(LedgerJson)(text));

// feature/settings/store.ts reads with excess keys rejected, normalizes before writing, and ends the file with a newline.
const settingsRoundTrip = (text: string) =>
  `${Schema.encodeSync(SettingsJson)(
    normalizeSettings(
      Schema.decodeSync(SettingsJson)(text, { onExcessProperty: "error" })
    )
  )}\n`;

// workflow/ship/runner.ts decodes with default options (unknown keys dropped) and writes the decoded value back.
const shipRoundTrip = (text: string) =>
  Schema.encodeSync(ShipJson)(Schema.decodeSync(ShipJson)(text));

const contracts = [
  {
    current: ["seal.json"],
    name: "seal.json",
    roundTrip: sealRoundTrip,
    stored: SealJson.to.ast,
  },
  {
    current: ["ledger.json"],
    name: "ledger.json",
    roundTrip: ledgerRoundTrip,
    stored: LedgerJson.to.ast,
  },
  {
    current: ["directorate.json"],
    name: "directorate.json",
    normalized: ["directorate.sparse.json", "directorate.empty-sections.json"],
    roundTrip: settingsRoundTrip,
    stored: SettingsJson.to.ast,
  },
  {
    current: [
      "ship.json",
      "ship.waiting.json",
      "ship.paused.json",
      "ship.complete.json",
    ],
    name: "ship state",
    roundTrip: shipRoundTrip,
    stored: ShipJson.to.ast,
  },
];

const expectedFor = (normalized: string) =>
  normalized.replace(/\.json$/u, ".expected.json");

// ---------- completeness: every encoded key path and every shape-changing union member appears in a fixture ----------
const isJsonObject = Schema.is(Schema.JsonObject);
const isJsonArray = Schema.is(Schema.Array(Schema.Json));

/**
 * Whether a union member is one of several stored shapes. Literal sets are one shape, and the `undefined` that
 * `Schema.optional` adds never reaches JSON.
 */
const isStoredVariant = (union: SchemaAST.Union, member: SchemaAST.AST) => {
  const stored = union.types.filter((type) => !SchemaAST.isUndefined(type));

  return (
    stored.some((type) => type === member) &&
    stored.length > 1 &&
    !stored.every(SchemaAST.isLiteral)
  );
};

/** Every path the encoded schema can write: `.key` per property, `.*` per record key, `[]` per array element. */
const schemaPaths = (ast: SchemaAST.AST, path: string, out: Set<string>) => {
  if (SchemaAST.isObjects(ast)) {
    for (const property of ast.propertySignatures) {
      const at = `${path}.${String(property.name)}`;
      out.add(at);
      schemaPaths(property.type, at, out);
    }

    for (const index of ast.indexSignatures) {
      out.add(`${path}.*`);
      schemaPaths(index.type, `${path}.*`, out);
    }
  } else if (SchemaAST.isArrays(ast)) {
    for (const element of [...ast.elements, ...ast.rest]) {
      out.add(`${path}[]`);
      schemaPaths(element, `${path}[]`, out);
    }
  } else if (SchemaAST.isUnion(ast)) {
    for (const [i, member] of ast.types.entries()) {
      if (isStoredVariant(ast, member)) {
        out.add(`${path} member ${i}`);
      }

      schemaPaths(member, path, out);
    }
  }

  return out;
};

/** The paths of `schemaPaths` that a stored value actually exercises. */
const fixturePaths = (
  ast: SchemaAST.AST,
  path: string,
  value: Schema.Json,
  out: Set<string>
) => {
  if (SchemaAST.isObjects(ast) && isJsonObject(value)) {
    const named = new Set<PropertyKey>();

    for (const property of ast.propertySignatures) {
      named.add(property.name);
      const key = String(property.name);
      const child = value[key];

      if (Object.hasOwn(value, key) && child !== undefined) {
        out.add(`${path}.${key}`);
        fixturePaths(property.type, `${path}.${key}`, child, out);
      }
    }

    for (const index of ast.indexSignatures) {
      for (const [key, child] of Object.entries(value)) {
        if (!named.has(key)) {
          out.add(`${path}.*`);
          fixturePaths(index.type, `${path}.*`, child, out);
        }
      }
    }
  } else if (SchemaAST.isArrays(ast) && isJsonArray(value)) {
    for (const element of value) {
      for (const type of ast.rest) {
        out.add(`${path}[]`);
        fixturePaths(type, `${path}[]`, element, out);
      }
    }
  } else if (SchemaAST.isUnion(ast)) {
    for (const [i, member] of ast.types.entries()) {
      if (
        isStoredVariant(ast, member) &&
        Schema.is(Schema.make(member))(value)
      ) {
        out.add(`${path} member ${i}`);
      }

      fixturePaths(member, path, value, out);
    }
  }

  return out;
};

const parseJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

for (const contract of contracts) {
  test(`${contract.name}: current fixtures decode and re-encode byte for byte`, () => {
    for (const name of contract.current) {
      const text = read(name);
      assert.equal(contract.roundTrip(text), text, name);
    }
  });

  test(`${contract.name}: normalized fixtures re-encode to their golden files byte for byte`, () => {
    for (const name of contract.normalized ?? []) {
      const golden = read(expectedFor(name));
      assert.equal(contract.roundTrip(read(name)), golden, name);
      // A golden is itself current: it must survive another round trip unchanged.
      assert.equal(contract.roundTrip(golden), golden, expectedFor(name));
    }
  });

  test(`${contract.name}: the first fixture sets every encoded field`, () => {
    const encoded = SchemaAST.toEncoded(contract.stored);
    const [first = ""] = contract.current;

    const covered = fixturePaths(
      encoded,
      "",
      parseJson(read(first)),
      new Set()
    );

    const missing = [...schemaPaths(encoded, "", new Set())].filter(
      (path) => !path.includes(" member ") && !covered.has(path)
    );

    assert.deepEqual(missing, [], `${first} lacks these schema paths`);
  });

  test(`${contract.name}: fixtures together exercise every shape-changing union member`, () => {
    const encoded = SchemaAST.toEncoded(contract.stored);
    const covered = new Set<string>();

    for (const name of [...contract.current, ...(contract.normalized ?? [])]) {
      fixturePaths(encoded, "", parseJson(read(name)), covered);
    }

    const missing = [...schemaPaths(encoded, "", new Set())].filter(
      (path) => path.includes(" member ") && !covered.has(path)
    );

    assert.deepEqual(missing, []);
  });
}

test("ship state: every step form round-trips byte for byte; any other step string fails to decode", () => {
  const stored = JSON.parse(read("ship.json"));

  for (const [step, form] of [
    ["review", "Review"],
    ["finish", "Finish"],
    ["resume:directorate-20260102000000-bbbbbb", "Resume"],
    ["fix:directorate-20260102000000-bbbbbb", "Fix"],
    ["recheck:directorate-20260102000000-bbbbbb:fp-1", "Recheck"],
    ["recheck:directorate-20260102000000-bbbbbb:fp:with:colons", "Recheck"],
  ] as const) {
    const text = JSON.stringify({ ...stored, step }, undefined, 2);

    assert.equal(shipRoundTrip(text), text, step);
    assert.equal(Schema.decodeSync(ShipJson)(text).step?._tag, form, step);
  }

  for (const step of [
    "fix",
    // A step whose seal is not a seal id names no seal.
    "fix:not-a-seal",
    "recheck:directorate-20260102000000-bbbbbb",
    "triage:directorate-20260102000000-bbbbbb",
  ]) {
    const text = JSON.stringify({ ...stored, step }, undefined, 2);

    assert.throws(() => shipRoundTrip(text), /not a ship step/u, step);
  }
});

test("directorate.json: an unknown key is rejected, not dropped", () => {
  assert.throws(() => settingsRoundTrip('{\n  "mdoe": "full"\n}\n'));
});

test("seal.json: the root re-applies the Window check, so a deadline before createdAt does not decode", () => {
  const text = read("seal.json");
  const stored = JSON.parse(text);

  assert.throws(
    () =>
      sealRoundTrip(
        JSON.stringify({ ...stored, deadline: "2026-03-01T09:59:59.999Z" })
      ),
    /deadline must not precede createdAt/u
  );

  // A deadline at createdAt is a spent window, not a broken one.
  const spent = JSON.stringify(
    { ...stored, deadline: stored.createdAt },
    undefined,
    2
  );

  assert.equal(sealRoundTrip(spent), spent);
});
