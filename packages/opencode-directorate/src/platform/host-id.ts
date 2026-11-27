// The host's identifiers, mirrored: each schema checks and brands a string exactly as OpenCode's own does, so its type is
// the host's (`Session.ID`, `SessionMessage.ID`, `Tool.CallID`) without importing a host package. Ids from the host's
// typed records and events flow in as they are; a string from anywhere else (tool input, hook metadata, a storage key)
// becomes one only through these schemas.
import { Schema } from "effect";

/** An OpenCode session: `ses…`. The same type as the host's `Session.ID`. */
export const SessionIdSchema = Schema.String.check(
  Schema.isStartingWith("ses")
).pipe(Schema.brand("SessionID"));

export type SessionId = typeof SessionIdSchema.Type;

/** A string as a session id, or none when it is not one. */
export const asSessionId = Schema.decodeUnknownOption(SessionIdSchema);

/** A message or inbox item in a session: `msg_…`. The same type as the host's `SessionMessage.ID`. */
export const MessageIdSchema = Schema.String.check(
  Schema.isStartingWith("msg_")
).pipe(Schema.brand("Session.Message.ID"));

export type MessageId = typeof MessageIdSchema.Type;

/** A tool call, such as a subagent launch. The same type as the host's `Tool.CallID`, which has no format. */
export const CallIdSchema = Schema.String.pipe(Schema.brand("Tool.CallID"));

export type CallId = typeof CallIdSchema.Type;
