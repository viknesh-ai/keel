// @keel/react
// React SDK: KeelProvider, Assistant, Shadow-DOM mounting.

export { Assistant } from "./assistant.js";
export {
  activityLabel,
  createTranslator,
  type Locale,
  STRINGS,
  type StringKey,
  type Translate,
} from "./i18n.js";
export { ShadowRoot } from "./mount.js";
export {
  type Activity,
  type KeelContextValue,
  KeelProvider,
  type KeelProviderProps,
  type Message,
  type PendingApproval,
  useKeel,
} from "./provider.js";
export { WIDGET_STYLES } from "./styles.js";
