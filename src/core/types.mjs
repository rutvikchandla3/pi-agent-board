/**
 * Shared data shapes for the agent-board store. JSDoc typedefs (consumed by the TS
 * extension via `allowJs`) plus the canonical state vocabularies as runtime constants.
 */

/** Semantic (task) state of a row. @typedef {"queued"|"working"|"needs_input"|"idle"|"completed"|"failed"|"stopped"} SemanticState */
/** Process/liveness state. @typedef {"alive"|"exited"} ProcessState */
/** PTY host mode. @typedef {"json-runner"|"pty"} HostMode */
/** PTY host liveness. @typedef {"starting"|"alive"|"exited"|"failed"} HostState */
/** How a run was kicked off. @typedef {"dispatch"|"reply"|"plan"|"plan_change"|"plan_approval"} RunKind */
/** Worktree isolation mode for a row. @typedef {"off"|"worktree"} WorktreeMode */
/** Diagnostic severity. @typedef {"info"|"warn"|"error"} DiagnosticLevel */
/** Diagnostic event source. @typedef {"runner"|"host"|"service"|"queue"|"steering"|"evidence"|"store"} DiagnosticSource */
/** Evidence outcome. @typedef {"unknown"|"in_progress"|"ready"|"needs_input"|"failed"|"stopped"|"queued"|"working"|"idle"|"completed"} EvidenceOutcome */
/** Command kind. @typedef {"test"|"build"|"lint"|"git"|"install"|"other"} EvidenceCommandKind */
/** Command status. @typedef {"started"|"passed"|"failed"|"unknown"} EvidenceCommandStatus */
/** File change action. @typedef {"edited"|"written"|"deleted"|"unknown"} EvidenceFileAction */
/** Follow-up kind. @typedef {"reply"|"plan_request"|"plan_approval"|"plan_change"} FollowUpKind */
/** Follow-up status. @typedef {"queued"|"claimed"|"completed"|"failed"|"cancelled"} FollowUpStatus */
/** Steering state. @typedef {"none"|"plan_requested"|"awaiting_approval"|"approved"|"changes_requested"|"executing_approved_plan"} SteeringModeState */
/** Dashboard auto-state bucket. @typedef {"needs_input"|"in_progress"|"done"} AutoStateKind */
/** Auto-state classifier source. @typedef {"model"|"heuristic"} AutoStateSource */
/** Auto-state classifier confidence. @typedef {"high"|"medium"|"low"} AutoStateConfidence */

/**
 * LLM/heuristic classification of the latest assistant turn.
 * @typedef {Object} AutoStateClassification
 * @property {number} version
 * @property {AutoStateKind} kind
 * @property {SemanticState} semanticState
 * @property {AutoStateConfidence} confidence
 * @property {AutoStateSource} source
 * @property {string} reason
 * @property {string|null} question
 * @property {number} classifiedAt
 * @property {number|null} lastAgentActivityAt
 * @property {string} textHash
 */

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
	working: "Running",
	queued: "Queued",
	failed: "Failed",
	completed: "Done",
	idle: "In Progress",
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
 * @property {Array<{toolCallId:string, question:string}>} pendingQuestions
 * @property {string|null} error
 * @property {number|null} lastVisitedAt
 * @property {number|null} lastAgentActivityAt Timestamp of the latest assistant reply shown in the row.
 * @property {ReviewSummary} [review] Compact collected-evidence summary.
 * @property {DiagnosticSummary} [diagnostics] Compact diagnostics summary.
 * @property {FollowUpSummary} [followUps] Compact queued follow-up summary.
 * @property {SteeringSummary} [steering] Compact plan/approval steering summary.
 * @property {AutoStateClassification|null} [autoState] Latest automatic terminal-state classification.
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
 * @property {Array<{toolCallId:string, question:string}>} pendingQuestions
 * @property {string|null} error
 * @property {number|null} lastAgentActivityAt Timestamp of the latest assistant reply.
 * @property {string|null} stopReason
 * @property {boolean} stoppedByUser
 * @property {number} turns
 * @property {number} toolCount
 * @property {number} [eventCount]
 * @property {number|null} [lastEventAt]
 * @property {EvidenceUsage|null} [usage]
 * @property {string|null} [stallReason]
 * @property {ReviewSummary|null} [evidenceSummary]
 * @property {AutoStateClassification|null} [autoState]
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

/**
 * Configuration handed to the detached title runner (written as `title-config.json`).
 * @typedef {Object} TitleConfig
 * @property {string} root
 * @property {string} viewId
 * @property {string} cwd
 * @property {string} prompt
 * @property {string} fallbackName
 * @property {string} piCommand
 * @property {string[]} piArgsPrefix
 * @property {string|null} model
 */

/**
 * Configuration handed to the detached auto-state runner.
 * @typedef {Object} AutoStateConfig
 * @property {string} root
 * @property {string} viewId
 * @property {string|null} runId
 * @property {string} cwd
 * @property {string} piCommand
 * @property {string[]} piArgsPrefix
 */

/**
 * @typedef {Object} DiagnosticEvent
 * @property {number} version
 * @property {number} at
 * @property {string} viewId
 * @property {string|null} runId
 * @property {DiagnosticSource|string} source
 * @property {DiagnosticLevel} level
 * @property {string} code
 * @property {string} message
 * @property {Record<string,any>} details
 */

/**
 * @typedef {Object} DiagnosticSummary
 * @property {number} count
 * @property {number} warningCount
 * @property {number} errorCount
 * @property {number|null} lastAt
 * @property {DiagnosticLevel|null} lastLevel
 * @property {string|null} lastCode
 * @property {string|null} lastMessage
 * @property {boolean} stalled
 * @property {string|null} stallReason
 */

/**
 * @typedef {Object} EvidenceUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 */

/**
 * @typedef {Object} EvidenceCommand
 * @property {string} id
 * @property {number} at
 * @property {string} command
 * @property {EvidenceCommandKind} kind
 * @property {EvidenceCommandStatus} status
 * @property {number|null} exitCode
 * @property {number|null} durationMs
 * @property {string} outputPreview
 */

/**
 * @typedef {Object} EvidenceFileChange
 * @property {string} path
 * @property {EvidenceFileAction} action
 * @property {string|null} toolName
 * @property {number} firstSeenAt
 * @property {number} lastSeenAt
 * @property {number} count
 */

/** @typedef {{ at:number, source:string, message:string, toolName:string|null }} EvidenceError */
/** @typedef {{ at:number, text:string }} EvidenceAssistantClaim */

/**
 * @typedef {Object} EvidenceSnapshot
 * @property {number} version
 * @property {string} viewId
 * @property {string|null} runId
 * @property {number} updatedAt
 * @property {EvidenceOutcome|string} outcome
 * @property {boolean} ready
 * @property {string} summary
 * @property {EvidenceCommand[]} commands
 * @property {EvidenceFileChange[]} fileChanges
 * @property {EvidenceError[]} errors
 * @property {EvidenceAssistantClaim[]} assistantEvidence
 * @property {EvidenceUsage|null} usage
 * @property {number} [eventCount]
 * @property {string} [source]
 */

/**
 * @typedef {Object} ReviewSummary
 * @property {boolean} ready
 * @property {EvidenceOutcome|string} outcome
 * @property {number} fileChangeCount
 * @property {number} commandCount
 * @property {number} failedCommandCount
 * @property {number} errorCount
 * @property {string} latestAssistantEvidence
 * @property {number|null} updatedAt
 */

/**
 * @typedef {Object} FollowUpItem
 * @property {string} id
 * @property {number} seq
 * @property {string} viewId
 * @property {FollowUpKind} kind
 * @property {string} text
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {FollowUpStatus} status
 * @property {string} source
 * @property {"auto"|"now"|"queue"} delivery
 * @property {string|null} runId
 * @property {number|null} claimedAt
 * @property {number|null} completedAt
 * @property {number} attempts
 * @property {string|null} error
 */

/** @typedef {{ version:number, viewId:string, nextSeq:number, updatedAt:number, items:FollowUpItem[] }} FollowUpQueue */
/** @typedef {{ queuedCount:number, claimedCount:number, lastQueuedAt:number|null, lastQueuedPreview:string|null }} FollowUpSummary */

/**
 * @typedef {Object} SteeringState
 * @property {number} version
 * @property {string} viewId
 * @property {SteeringModeState} status
 * @property {number} updatedAt
 * @property {string} planText
 * @property {string|null} planRunId
 * @property {number|null} approvedAt
 * @property {string|null} changeRequest
 * @property {string|null} executionRunId
 * @property {Array<{at:number, from:string, to:string, action:string, runId:string|null, note:string|null}>} history
 */

/** @typedef {{ status:SteeringModeState, awaitingApproval:boolean, planPreview:string|null, updatedAt:number|null, question:string|null }} SteeringSummary */

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
