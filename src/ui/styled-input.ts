/**
 * @deprecated Ember consolidates all prompts through `./prompt.ts`. This
 * module is a re-export shim so existing imports keep working. Delete in M6
 * once every call site has been migrated to `askText` / `askConfirm`.
 */

export { styledInput, styledConfirm } from "./prompt.js";
