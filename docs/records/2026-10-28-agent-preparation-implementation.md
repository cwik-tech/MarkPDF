# Agent PDF preparation implementation record

Date: 2026-10-28. Scope: implement the reviewed [plan](../agent-pdf-preparation-plan.md), without committing or changing installed agent configuration. Gate results live only in the plan's Status section.

## Independent source review and disposition

An independent Codex session reviewed the implementation against the repository rules and plan. It used source inspection only and did not run tests. The original nine findings and their disposition are below. Its final source verdict found no remaining critical defect within that review scope; this is not independent runtime acceptance.

| Finding | Implemented response |
| --- | --- |
| Functional updates could evade edit ownership | Inspect the proposed patch, track document revisions, and cancel preparation on user edits while preserving React's functional state update (`src/App.tsx`, `updatePdfTab`). |
| Mutating form inspection could remove XFA | Inspect AcroForm/XFA dictionaries without calling `getForm`; refuse automatic replacement for forms and signatures (`src/pdf/prepareOutline.ts`, `prepareOutline`). |
| Manual and agent saves could overlap | Both main-process write paths use the canonical-document save coordinator (`electron/agentPreparation.ts`, `withDocumentSave`). |
| Edits could cross asynchronous save/load boundaries | Check revisions after awaits and before clearing dirty state; propagate cancellation to file replacement (`src/App.tsx`, preparation callback; `electron/preparationSave.ts`). |
| Startup cancellation could be missed | Watch cancellation and read an existing marker before starting work and again after registering operation ownership (`electron/agentPreparation.ts`, `queueExternalPreparation`). |
| Closed/expired operations could retain ownership | Clean up readiness listeners, watches and ownership; abort file/index work before releasing pending state (`electron/agentPreparation.ts`). |
| Agent and desktop data directories could diverge | Honor and validate the explicit application data directory at desktop startup (`electron/main.ts`). |
| No-save readiness could describe obsolete bytes | Validate the current file against the tab snapshot even when no outline needs saving, and recheck after indexing (`src/App.tsx`, preparation callback). |
| Replies could lose completed-save or scope facts | Preserve save outcome separately, report unknown outcome after an unacknowledged failure, and return effective model/profile and bounded coverage (`core/agent/preparation.ts`, `electron/main.ts`). |

Follow-up review also identified cancellation after an await, active-window destruction, effective index scope, and post-save tab reconciliation. The implementation now refreshes committed bytes before returning cancellation, checks cancellation before starting indexing, and links main-process preparation aborts directly to the registered index job.

## Runtime findings and corrections

- A heading-only fixture did not establish the intended generated-outline condition. The fixture now contains independent heading and body text; no expectation was weakened.
- A late metadata update could mark a just-saved tab dirty again. Preparation now owns the operation while awaiting the staged metadata promise. The visible acceptance journey closes without a save prompt and reopens the persisted outline.
- Real selection after reopening needs mouse interaction as in the existing bookmark journey. The test uses that interaction before proving that user edits block preparation.
- Multiple agents targeting different files could open unlimited preparation windows. Main-process admission is now bounded, with a busy response instead of implicit queuing.
- The built renderer revealed an automatic optional Docling installation during agent startup. Agent-created windows now skip unrelated converter installation and speculative model warm-up; preparation loads its own required index model. The cold-start test explicitly checks that no converter installation tree is created. Failed-test temporary directories were removed only after their converter processes were absent.
- The offline test preload path was unquoted in NODE_OPTIONS. The existing checkout has spaces in its path. A pristine baseline under a path with spaces reproduced the harness defect, while a baseline without spaces did not. The fix quotes that environment value and adds a local-process regression that does not contact a remote server.
- Existing native-navigation tests tried to click a collapsed input. Their setup now opens the public search control before entering the query; all geometry assertions and timeouts remain intact.

## Scope and remaining limits

The optional automatic agent installer and per-file consent UI remain deferred as agreed. Client registration syntax was checked against installed Claude/Codex help, but no user configuration was edited and no fresh model session was used to establish skill compliance. Automatic PDF replacement is macOS-only and refuses unsupported source cases. No new package dependency or migration was introduced.

Unacknowledged request/cancellation records are retained for diagnosis rather than expired automatically. Fine-grained external preparation progress is not forwarded through the result-file channel; the desktop displays the underlying work and the tool returns its completion receipt. Cloud-sync provider behavior, real-model retrieval quality and measured token savings are not established by this task's local fixture verification.

## Final visible-flow corrections

The close/reopen acceptance uncovered a late generated-outline update; staged metadata is now awaited under preparation ownership before saving. The built-renderer journey also verifies that agent-created windows do not start an unrelated optional converter installation. Its test disables package-index access and checks absence of the converter tree. The mouse-selection setup after reopening now follows the existing real bookmark interaction. Gate results remain in the plan Status section.
