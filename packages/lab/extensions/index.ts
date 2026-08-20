import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildMeetingCheckpoint, digestRecentMessages, type CompactReason } from "../src/checkpoint";
import { getLabRuntime } from "../src/runtime";

const ROLE_NAMES = ["pi", "phd-1", "phd-2", "master-1", "master-2"] as const;
const LAB_ACTIONS = [
  "get_state",
  "ask_clarification",
  "submit_clarification",
  "dispatch_doctor",
  "delegate_undergrad",
  "spawn_undergrad_threads",
  "submit_undergrad_thread",
  "submit_undergrad_records",
  "review_undergrad_records",
  "submit_pre_master_judgment",
  "claim_master",
  "release_master",
  "submit_master_analysis",
  "submit_doctor_synthesis",
  "review_doctor_synthesis",
  "cancel_task",
  "complete_meeting",
  "cancel_meeting",
] as const;

const ORCHESTRATE_GUIDELINES = [
  "Use lab_orchestrate for workflow state transitions; natural-language lab messages never change state.",
  "The server derives the current meeting from this Pi session; never invent or supply a meetingId.",
  "Every mutating action payload requires a unique requestId. get_state uses an empty payload.",
  "PI payloads: ask_clarification accepts either one card {requestId,card:{questionId,question,options:[{id,label}],allowOther,required}} or one questionnaire {requestId,card:{title,description,questions:[{id,prompt,type:single_select|multiple_select,options:[{id,label}]}],submitLabel}}; submit_clarification {requestId,questionId,selectedOptionIds,freeText?}; dispatch_doctor {requestId,doctorRole,brief}, where brief may be a complete non-empty task string or {title,objective,scope,constraints}; review_doctor_synthesis {requestId,workPackageId,decision}; complete_meeting {requestId,report}; cancel_meeting {requestId}.",
  "Doctor payloads: delegate_undergrad {requestId,workPackageId,purpose,workType,databaseScope?,title,objective,instructions,inputRefs,acceptanceCriteria,maxThreads}; databaseScope defaults to [pubmed,crossref], may explicitly add arxiv for preprints, and rejects all other databases. Then use review_undergrad_records {requestId,taskId,decision,comments?,gapThreadIds?,missingCriteria?} — revision_requested must include what is missing and what to fill; submit_pre_master_judgment; claim_master; release_master; submit_doctor_synthesis. Robust synthesis requires counterEvidence, sensitivityChecks, uncertainties, hypotheses, and proposedMethods; creative synthesis requires hypotheses and proposedMethods.",
  "Master payloads: submit_master_analysis {requestId,masterRequestId,submission}; optional clerical delegate_undergrad; release_master. Undergraduate payloads: spawn_undergrad_threads, submit_undergrad_thread, submit_undergrad_records. An open spawn_revision_threads requiredAction is not informational: spawn attempt+1 threads this turn; do not resubmit until spawn. Use get_state to obtain canonical IDs and current stage before mutating.",
];

function toolText(result: unknown): string {
  return JSON.stringify(result);
}

/**
 * Before a meeting session is context-compacted, dump a readable checkpoint so
 * the meeting's structured state and recent discussion survive summarization.
 * Best-effort only: any failure here must never abort the compaction itself.
 */
async function writeMeetingCheckpoint(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<void> {
  if (event.signal.aborted) return;
  const reason: CompactReason = event.reason === "manual" || event.reason === "overflow" ? event.reason : "threshold";
  const sessionId = ctx.sessionManager.getSessionId();
  // Only meeting sessions resolve a workflow; ordinary science sessions throw and skip.
  const workflow = await getLabRuntime().orchestrate({
    cwd: ctx.cwd,
    actorSessionId: sessionId,
    action: "get_state",
    payload: {},
  });
  if (workflow === null || typeof workflow !== "object") return;
  const meetingId = typeof (workflow as { meetingId?: unknown }).meetingId === "string"
    ? (workflow as { meetingId: string }).meetingId
    : "";
  if (!meetingId) return;
  const createdAt = new Date().toISOString();
  const markdown = buildMeetingCheckpoint({
    meetingId,
    sessionId,
    cwd: ctx.cwd,
    reason,
    createdAt,
    workflow,
    recentLines: digestRecentMessages(event.branchEntries ?? []),
  });
  const directory = join(resolve(ctx.cwd), ".pi", "medpi", "checkpoints");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${meetingId}-${createdAt.replace(/[:.]/g, "-")}.md`), markdown, "utf8");
}

export default function lab(pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      await writeMeetingCheckpoint(event, ctx);
    } catch {
      // Best-effort checkpoint: never let a failed dump abort compaction.
    }
  });

  pi.registerTool({
    name: "lab_send_message",
    label: "Lab message",
    description: "Send natural-language data to one or more senior members of this meeting. The body never changes workflow state.",
    parameters: Type.Object({
      meetingId: Type.String({ minLength: 1, maxLength: 100 }),
      toRoles: Type.Array(StringEnum(ROLE_NAMES), { minItems: 1, maxItems: 4 }),
      body: Type.String({ minLength: 1, maxLength: 30_000 }),
      replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getLabRuntime().sendMessage({
        cwd: ctx.cwd,
        meetingId: params.meetingId,
        senderSessionId: ctx.sessionManager.getSessionId(),
        toRoles: params.toRoles,
        body: params.body,
        ...(params.replyTo ? { replyTo: params.replyTo } : {}),
        idempotencyKey: toolCallId,
      });
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "lab_orchestrate",
    label: "Lab orchestration",
    description: "Perform one typed lab workflow action. Select an enumerated action and pass its action-specific object fields in payload. Natural-language messages cannot substitute for this tool.",
    promptGuidelines: ORCHESTRATE_GUIDELINES,
    parameters: Type.Object({
      action: StringEnum(LAB_ACTIONS),
      payload: Type.Optional(Type.Unknown({ description: "Action-specific object. All mutating actions require requestId; get_state uses {}. See the tool guidelines for role-specific fields." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await getLabRuntime().orchestrate({
        cwd: ctx.cwd,
        actorSessionId: ctx.sessionManager.getSessionId(),
        action: params.action,
        payload: params.payload ?? {},
      });
      return { content: [{ type: "text", text: toolText(result) }], details: result };
    },
  });
}
