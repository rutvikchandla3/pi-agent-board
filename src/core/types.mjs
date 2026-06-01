/**
 * Shared data shapes for the agent-board store. JSDoc typedefs (consumed by the TS
 * extension via `allowJs`) plus the canonical state vocabularies as runtime constants.
 */

/** Semantic (task) state of a row. @typedef {"queued"|"working"|"needs_input"|"idle"|"completed"|"failed"|"stopped"} SemanticState */
/** Process/liveness state. @typedef {"alive"|"exited"} ProcessState */
/** PTY host mode. @typedef {"json-runner"|"pty"} HostMode */
/** PTY host liveness. @typedef {"starting"|"alive"|"exited"|"failed"} HostState */
/** How a run was kicked off. @typedef {"dispatch"|"reply"} RunKind */
/** Worktree isolation mode for a row. @typedef {"off"|"worktree"} WorktreeMode */

export const SEMANTIC_STATES = /** @type {const} */ ([
	"queued",
	"working",
	"needs_input",
	"idle",
	"completed",
	"failed",
	"stopped",
]);

export const PROCESS_STATES = /** @type {const} */ (["alive", "exited"]);

/** Order rows are grouped/shown in the dashboard (most-actionable first). */
export const GROUP_ORDER = /** @type {const} */ ([
	"queued",
	"working",
	"needs_input",
	"idle",
	"completed",
	"failed",
	"stopped",
]);

/** Human labels for group headers. @type {Record<SemanticState,string>} */
export const GROUP_LABELS = {
	needs_input: "Needs input",
	working: "Working",
	queued: "Queued",
	failed: "Failed",
	completed: "Done",
	idle: "Idle",
	stopped: "Stopped",
};

/**
 * Stable row metadata (`meta.json`).
 * @typedef {Object} ViewMeta
 * @property {number} version
 * @property {string} id
 * @property {string} name
 * @property {string} cwd               Working dir the worker runs in (repo or worktree path).
 * @property {string} repoCwd           Original repo dir requested at dispatch (== cwd unless worktree).
 * @property {string|null} repoRoot     Git repo root, if any.
 * @property {string} sessionFile        Managed Pi session JSONL path.
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {boolean} pinned
 * @property {"pi-session"} kind
 * @property {string|null} defaultModel
 * @property {"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|null} defaultThinking
 * @property {WorktreeMode} worktreeMode
 * @property {string|null} worktreePath
 * @property {boolean} writeCapable      Whether this session may mutate files (default true).
 * @property {boolean} archived          Soft-deleted from the dashboard (data preserved).
 * @property {"agent-board"} source
 */

/**
 * Derived dashboard state for a row (`state.json`).
 * @typedef {Object} ViewState
 * @property {number} version
 * @property {string} viewId
 * @property {string|null} currentRunId
 * @property {SemanticState} semanticState
 * @property {ProcessState} processState
 * @property {string} summary
 * @property {number} lastActivityAt
 * @property {number} updatedAt
 * @property {boolean} needsInput
 * @property {boolean} hasError
 * @property {string} latestAssistantPreview
 * @property {{name:string, path:string|null}|null} latestTool
 * @property {string|null} question
 * @property {string|null} error
 */

/**
 * Durable PTY host snapshot (`host.json`).
 * @typedef {Object} HostStatus
 * @property {number} version
 * @property {string} viewId
 * @property {HostMode} mode
 * @property {number|null} runnerPid
 * @property {number|null} childPid
 * @property {string|null} socketPath
 * @property {HostState} state
 * @property {number} startedAt
 * @property {number} lastSeenAt
 * @property {number|null} endedAt
 * @property {number|null} exitCode
 * @property {string|null} error
 * @property {number} cols
 * @property {number} rows
 * @property {number} attachedClients
 * @property {boolean} [attachedEver] Whether any client attached to this host.
 */

/**
 * Durable per-run snapshot (`runs/<runId>/status.json`).
 * @typedef {Object} RunStatus
 * @property {number} version
 * @property {string} runId
 * @property {string} viewId
 * @property {number|null} pid
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {number|null} exitCode
 * @property {RunKind} kind
 * @property {string} prompt
 * @property {string|null} model
 * @property {SemanticState} semanticState
 * @property {ProcessState} processState
 * @property {string} summary
 * @property {number} lastActivityAt
 * @property {{name:string, path:string|null}|null} currentTool
 * @property {string} latestAssistantPreview
 * @property {string|null} question
 * @property {string|null} error
 * @property {string|null} stopReason
 * @property {boolean} stoppedByUser
 * @property {number} turns
 * @property {number} toolCount
 */

/**
 * Configuration handed to the detached runner (written to the run dir as `config.json`
 * and passed by path on argv).
 * @typedef {Object} RunConfig
 * @property {string} root
 * @property {string} viewId
 * @property {string} runId
 * @property {RunKind} kind
 * @property {string} sessionFile
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} piCommand        Executable to launch the worker (e.g. "pi" or a node path).
 * @property {string[]} piArgsPrefix   Args before our flags (e.g. [cliJsPath] when piCommand is node).
 * @property {string|null} model
 * @property {"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|null} thinkingLevel
 * @property {string|null} tools
 */

/**
 * Configuration handed to the detached PTY host runner (written as `host-config.json`).
 * @typedef {Object} HostConfig
 * @property {string} root
 * @property {string} viewId
 * @property {string} sessionFile
 * @property {string} cwd
 * @property {string|null} initialPrompt
 * @property {string} piCommand
 * @property {string[]} piArgsPrefix
 * @property {string|null} model
 * @property {"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|null} thinkingLevel
 * @property {string|null} tools
 * @property {Record<string,string>} env
 * @property {number} cols
 * @property {number} rows
 */

/** Roster index (`roster.json`). @typedef {Object} Roster @property {number} version @property {string[]} views */

/**
 * Persisted launch dialog defaults (`launch-prefs.json`).
 * @typedef {Object} LaunchPrefs
 * @property {number} version
 * @property {string|null} cwd
 * @property {string|null} model
 * @property {"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|null} thinkingLevel
 */

export {};
