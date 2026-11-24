import { Data } from "effect";

/** Another writer holds the seal's mutation lock. */
export class LockBusy extends Data.TaggedError("DirectorateLockBusy") {}
