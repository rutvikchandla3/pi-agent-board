/**
 * Auto-discovery entry point. Pi loads `<extensions-dir>/<name>/index.ts`, so this
 * re-exports the real extension from `src/index.ts`. Symlink this repo into
 * `~/.pi/agent/extensions/agent-board` (or add its path to settings.json `extensions`).
 */
export { default } from "./src/index.ts";
