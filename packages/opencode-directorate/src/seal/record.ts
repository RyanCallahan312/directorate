// The seal record, seal.json: composed from the field groups each owner keeps, and decoded and encoded through SealJson.
// A Seal is read-only: every change builds a new one through the constructor, so the root's checks hold after it. Each
// field group has one rebuild method; its owner's transitions call it (a method call needs no value import of this
// module, which imports theirs).
import { Schema } from "effect";

import { DispatchFromStored } from "../feature/dispatch/lifecycle.ts";
import type { Dispatch } from "../feature/dispatch/lifecycle.ts";
import { Gates, Protocol } from "../feature/report/directive.ts";
import { Count, sortedFields } from "../platform/stored.ts";
import { Custody } from "../workflow/review/custody.ts";
import { ModeSchema } from "../workflow/review/request.ts";
import { ShipIdSchema } from "../workflow/review/ship-link.ts";
import type { ShipId } from "../workflow/review/ship-link.ts";
import {
  StoredWindow,
  Window,
  windowCheck,
} from "../workflow/review/window.ts";
import { FileEntry, Region } from "./region.ts";
import { SealIdSchema } from "./seal-id.ts";
import { isCommitImage, PostImageSchema, Target } from "./target.ts";

const list = Schema.Array;
const opt = Schema.optional;

/** What a review pins at sealing: its identity, its target and the commits that fix it, and what was asked. */
const Pins = Schema.Struct({
  baseSha: Schema.String,
  baseTip: opt(Schema.String),
  description: Schema.String,
  headSha: Schema.String,
  id: SealIdSchema,
  /** Lenses the settings turned off for this review. */
  lensesOff: opt(list(Schema.String)),
  mode: ModeSchema,
  /** A panel review's Directorate Seats: one model per seat. */
  panel: opt(list(Schema.String)),
  postImage: PostImageSchema,
  question: opt(Schema.String),
  /** A re-check: the reported seal it follows, whose findings it carries and re-decides. */
  recheckOf: opt(SealIdSchema),
  repo: Schema.String,
  target: Target,
});

/** What capture writes; a new review starts with none of it. */
const Captured = Schema.Struct({
  deleted: list(Schema.String),
  files: list(FileEntry),
  fingerprint: Schema.String,
  regions: list(Region),
  sigs: opt(Schema.Record(Schema.String, Schema.String)),
});

/** The Containment field group of seal.json: the pins, what capture wrote, and how often it was re-contained. */
const Containment = Schema.Struct(
  sortedFields({
    ...Pins.fields,
    ...Captured.fields,
    gen: Count,
    refreshes: Count,
  })
);

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
      children: list(DispatchFromStored),
      /** The ship whose loop this review belongs to. Only that ship continues it, even after the ship is stopped. */
      ship: opt(ShipIdSchema),
    })
    // Spreading StoredWindow's fields drops its check; the root re-applies it.
  ).check(windowCheck)
) {
  /**
   * A new review at generation 0, before capture: what it pins, its window, and who holds it. No subagent has run and no
   * gate has pushed back.
   */
  static open(
    pins: typeof Pins.Type,
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
  withShip(ship: ShipId) {
    return new Seal({ ...this, ship });
  }
}

export const SealJson = Schema.fromJsonString(Seal, { space: 2 });
