// The seal record, seal.json: composed from the field groups each owner keeps, and decoded and encoded through SealJson.
// A Seal is read-only: every change builds a new one through the constructor, so the root's checks hold after it. Each
// field group has one rebuild method; its owner's transitions call it (a method call needs no value import of this
// module, which imports theirs).
import { Schema } from "effect";

import { DispatchFromStored } from "../feature/dispatch/lifecycle.ts";
import type { Dispatch } from "../feature/dispatch/lifecycle.ts";
import { Gates, Protocol } from "../feature/report/directive.ts";
import { Count, since, sortedFields } from "../platform/stored.ts";
import { Custody } from "../workflow/review/custody.ts";
import { ModeSchema } from "../workflow/review/request.ts";
import {
  StoredWindow,
  Window,
  windowCheck,
} from "../workflow/review/window.ts";
import { FileEntry, Region } from "./region.ts";
import { isCommitImage, PostImageSchema, Target } from "./target.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** The Containment field group of seal.json. */
export const Containment = Schema.Struct({
  baseSha: Schema.String,
  baseTip: opt(Schema.String),
  deleted: since(list(Schema.String), []),
  description: Schema.String,
  files: since(list(FileEntry), []),
  fingerprint: Schema.String,
  gen: since(Count, 0),
  headSha: Schema.String,
  id: Schema.String,
  /** Lenses the settings turned off for this review. */
  lensesOff: opt(list(Schema.String)),
  mode: ModeSchema,
  /** A panel review's Directorate Seats: one model per seat. */
  panel: opt(list(Schema.String)),
  postImage: PostImageSchema,
  question: opt(Schema.String),
  /** A re-check: the reported seal it follows, whose findings it carries and re-decides. */
  recheckOf: opt(Schema.String),
  refreshes: since(Count, 0),
  regions: since(list(Region), []),
  repo: Schema.String,
  sigs: opt(Schema.Record(Schema.String, Schema.String)),
  target: Target,
});

/** What capture writes; a new review starts with none of it. */
type Captured = "deleted" | "files" | "fingerprint" | "regions" | "sigs";

export class Seal extends Schema.Class<Seal, { readonly brand: unique symbol }>(
  "directorate/Seal"
)(
  // Keys stay in alphabetical order across the field groups: seal.json is encoded in field order.
  Schema.Struct(
    sortedFields({
      ...Containment.fields,
      ...StoredWindow.fields,
      ...Custody.fields,
      ...Protocol.fields,
      children: since(list(DispatchFromStored), []),
      /** The ship whose loop this review belongs to. Only that ship continues it, even after the ship is stopped. */
      ship: opt(Schema.String),
    })
    // Spreading StoredWindow's fields drops its check; the root re-applies it.
  ).check(windowCheck)
) {
  /**
   * A new review at generation 0, before capture: what it pins, its window, and who holds it. No subagent has run and no
   * gate has pushed back.
   */
  static open(
    pins: Omit<typeof Containment.Type, Captured | "gen" | "refreshes">,
    window: Window,
    custody: typeof Custody.Type
  ) {
    return Seal.make({
      ...pins,
      ...custody,
      budgetMinutes: window.budgetMinutes,
      children: [],
      createdAt: window.createdAt,
      deadline: window.deadline,
      deleted: [],
      files: [],
      fingerprint: "",
      gates: Gates.make({}),
      gen: 0,
      refreshes: 0,
      regions: [],
    });
  }

  /** Its post-image is a commit; otherwise it is the working tree, snapshotted at sealing. */
  get pinsCommit() {
    return isCommitImage(this.postImage);
  }

  /** The review's clock. */
  get window() {
    return Window.make({
      budgetMinutes: this.budgetMinutes,
      createdAt: this.createdAt,
      deadline: this.deadline,
    });
  }

  /** Containment and coverage marks (carried in regions): seal/'s capture, re-pin, and coverage transitions. */
  withContainment(containment: Partial<typeof Containment.Type>) {
    return new Seal({ ...this, ...containment });
  }

  /** The Window group: workflow/review's window transitions. */
  withWindow(window: Window) {
    return new Seal({
      ...this,
      budgetMinutes: window.budgetMinutes,
      createdAt: window.createdAt,
      deadline: window.deadline,
    });
  }

  /** The Custody group: workflow/review's custody transitions. */
  withCustody(custody: Partial<typeof Custody.Type>) {
    return new Seal({ ...this, ...custody });
  }

  /** The Protocol & Directive group: feature/report's transitions. */
  withProtocol(protocol: Partial<typeof Protocol.Type>) {
    return new Seal({ ...this, ...protocol });
  }

  /** The Dispatches group (stored as children): feature/dispatch's transitions. */
  withDispatches(children: readonly Dispatch[]) {
    return new Seal({ ...this, children });
  }

  /** The Ship link: stamped by workflow/review with the id the ship hands it. */
  withShip(ship: string) {
    return new Seal({ ...this, ship });
  }
}

export const SealJson = Schema.fromJsonString(Seal, { space: 2 });
