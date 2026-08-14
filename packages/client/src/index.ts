// @keel/client
// Framework-free browser core: AG-UI transport, sessions, tool registration.

export {
  type ClientOptions,
  type ClientTool,
  type IdentityProvider,
  KeelClient,
  KeelClientError,
  parseFrame,
  type Session,
} from "./client.js";
export {
  type AguiEvent,
  type AguiEventType,
  Emitter,
  type EventOf,
  type Handler,
} from "./events.js";
