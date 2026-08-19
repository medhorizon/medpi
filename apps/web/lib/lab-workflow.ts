import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { createNewAgentSession } from "./agent-session-create";
import {
  getUndergraduateChildSystemPrompt,
  getUndergraduateChildToolNames,
  type GroupMeeting,
  type GroupMeetingRole,
} from "./group-meeting";
import { configureLabMessageRuntime } from "./lab-message-server";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";

const WORKFLOW_VERSION = 1 as const;
const DEFAULT_RUNTIME_ID = randomUUID();
const ACTIVE_THREAD_STATUSES = new Set<UndergradThreadStatus>(["created", "running"]);
const ACTIVE_RESERVATION_STATUSES = new Set<MasterReservationStatus>(["reserved", "requested", "running", "submitted"]);
const MEETING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SHORT_TEXT = 240;
const MAX_TEXT = 12_000;
const MAX_ARRAY = 64;
const MAX_RECORDS = 200;

type SeniorRole = Exclude<GroupMeetingRole, "undergraduate">;
type DoctorRole = Extract<GroupMeetingRole, "phd-1" | "phd-2">;
type MasterRole = Extract<GroupMeetingRole, "master-1" | "master-2">;
type WorkflowStatus = "clarifying" | "awaiting_user_input" | "brief_ready" | "running" | "pi_review" | "completed" | "cancelled";
type WorkPackageMode = "creative" | "robust";
type WorkPackageStatus =
  | "draft"
  | "retrieval_dispatched"
  | "retrieval_accepted"
  | "pre_master_judgment"
  | "master_requested"
  | "master_submitted"
  | "doctor_synthesized"
  | "pi_review"
  | "accepted"
  | "revision_requested"
  | "cancelled";
type UndergradTaskStatus = "queued" | "running" | "submitted" | "accepted" | "revision_requested" | "blocked" | "failed" | "cancelled" | "interrupted";
type UndergradThreadStatus = "created" | "running" | "submitted" | "blocked" | "failed" | "cancelled" | "interrupted";
type MasterReservationStatus = "reserved" | "requested" | "running" | "submitted" | "released" | "cancelled" | "interrupted";
type LiteratureDatabase = "pubmed" | "crossref" | "arxiv";

const DEFAULT_LITERATURE_DATABASE_SCOPE: LiteratureDatabase[] = ["pubmed", "crossref"];

export interface ClarificationCard {
  questionId: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  allowOther: boolean;
  required: boolean;
  selectionMode?: "single" | "multiple";
  title?: string;
  description?: string;
  submitLabel?: string;
}

export interface ClarificationResponse {
  questionId: string;
  selectedOptionIds: string[];
  freeText?: string;
  answeredAt: string;
}

export type ResearchBrief = string | {
  title: string;
  objective: string;
  scope: string;
  constraints: string[];
};

export interface LiteratureRecord {
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  pmid?: string;
  url?: string;
  source: string;
  retrievedAt: string;
  quoteOrMetadata: string;
}

export interface UndergradResult {
  summary: string;
  records: LiteratureRecord[];
  artifactRefs: string[];
  limitations: string[];
  blockedReason?: string;
}

export interface UndergradThread {
  threadId: string;
  parentTaskId: string;
  attempt: number;
  title: string;
  objective: string;
  inputRefs: string[];
  acceptanceCriteria: string[];
  status: UndergradThreadStatus;
  sessionId: string | null;
  result?: UndergradResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UndergradTask {
  taskId: string;
  requesterRole: SeniorRole;
  requesterSessionId: string;
  doctorWorkPackageId?: string;
  purpose: "scientific_retrieval" | "clerical_supplement";
  workType: "literature_search" | "literature_validate" | "literature_extract";
  databaseScope: LiteratureDatabase[];
  title: string;
  objective: string;
  instructions: string[];
  inputRefs: string[];
  acceptanceCriteria: string[];
  maxThreads: number;
  status: UndergradTaskStatus;
  attempt: number;
  threadIds: string[];
  submission?: UndergradResult;
  createdAt: string;
  updatedAt: string;
}

export interface MasterAnalysisSubmission {
  analysis: string;
  interpretation: string;
  assumptions: string[];
  methodsUsed: string[];
  uncertainty: string[];
  artifactRefs: string[];
}

export interface MasterReservation {
  requestId: string;
  workPackageId: string;
  doctorRole: DoctorRole;
  masterRole: MasterRole;
  masterSessionId: string;
  inputRefs: string[];
  expectedOutput: string;
  status: MasterReservationStatus;
  analysis?: MasterAnalysisSubmission;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DoctorSynthesis {
  ownReasoning: string;
  masterInterpretations: string[];
  evidenceRefs: string[];
  conclusion: string;
  hypotheses: string[];
  proposedMethods: string[];
  counterEvidence: string[];
  sensitivityChecks: string[];
  uncertainties: string[];
  limitations: string[];
  unansweredQuestions: string[];
}

export interface DoctorWorkPackage {
  workPackageId: string;
  doctorRole: DoctorRole;
  mode: WorkPackageMode;
  status: WorkPackageStatus;
  undergradTaskIds: string[];
  preMasterJudgment?: { judgment: string; evidenceRefs: string[]; submittedAt: string };
  masterRequestId?: string;
  synthesis?: DoctorSynthesis;
  createdAt: string;
  updatedAt: string;
}

export interface FinalAcademicReport {
  title: string;
  executiveSummary: string;
  creativeRoute: string;
  robustRoute: string;
  conflictsAndLimitations: string[];
  conclusions: string[];
  hypotheses: string[];
  proposedMethods: string[];
  evidenceRefs: string[];
  openQuestions: string[];
}

export interface FinalReportArtifact {
  path: string;
  artifactRef: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export type LabWorkflowNoticeEvent =
  | "clarification_submitted"
  | "doctor_dispatched"
  | "undergrad_thread_submitted"
  | "undergrad_records_submitted"
  | "undergrad_revision_requested"
  | "master_analysis_submitted"
  | "doctor_synthesis_submitted"
  | "doctor_revision_requested";

export interface LabWorkflowNotice {
  noticeId: string;
  event: LabWorkflowNoticeEvent;
  toRole: GroupMeetingRole;
  toSessionId: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface IdempotencyRecord {
  fingerprint: string;
  status: "pending" | "complete" | "interrupted";
  updatedAt: string;
}

export interface LabWorkflow {
  version: typeof WORKFLOW_VERSION;
  meetingId: string;
  cwd: string;
  runtimeId: string;
  status: WorkflowStatus;
  clarificationCards: ClarificationCard[];
  clarificationResponses: ClarificationResponse[];
  brief?: ResearchBrief;
  workPackages: DoctorWorkPackage[];
  undergradTasks: UndergradTask[];
  undergradThreads: UndergradThread[];
  masterReservations: MasterReservation[];
  finalReport?: FinalAcademicReport;
  finalReportArtifact?: FinalReportArtifact;
  notices: LabWorkflowNotice[];
  idempotency: Record<string, IdempotencyRecord>;
  createdAt: string;
  updatedAt: string;
}

export type LabWorkflowActor =
  | { kind: "member"; role: GroupMeetingRole; sessionId: string }
  | { kind: "undergrad_thread"; role: "undergraduate"; sessionId: string; taskId: string; threadId: string };

interface ThreadSpecInput {
  title: string;
  objective: string;
  inputRefs: string[];
  acceptanceCriteria: string[];
}

interface UndergradSubmissionInput extends UndergradResult {
  threadIds?: string[];
}

export type LabOrchestrateAction =
  | { action: "get_state" }
  | { action: "ask_clarification"; requestId: string; cards: ClarificationCard[] }
  | { action: "submit_clarification"; requestId: string; questionId: string; selectedOptionIds: string[]; freeText?: string }
  | { action: "dispatch_doctor"; requestId: string; doctorRole: DoctorRole; brief: ResearchBrief }
  | { action: "delegate_undergrad"; requestId: string; workPackageId?: string; purpose: "scientific_retrieval" | "clerical_supplement"; workType: UndergradTask["workType"]; databaseScope?: LiteratureDatabase[]; title: string; objective: string; instructions: string[]; inputRefs: string[]; acceptanceCriteria: string[]; maxThreads: number }
  | { action: "spawn_undergrad_threads"; requestId: string; taskId: string; threads: ThreadSpecInput[] }
  | { action: "submit_undergrad_thread"; requestId: string; taskId: string; threadId: string; result: UndergradSubmissionInput }
  | { action: "submit_undergrad_records"; requestId: string; taskId: string; result: UndergradSubmissionInput }
  | { action: "review_undergrad_records"; requestId: string; taskId: string; decision: "accepted" | "revision_requested" }
  | { action: "submit_pre_master_judgment"; requestId: string; workPackageId: string; judgment: string; evidenceRefs: string[] }
  | { action: "claim_master"; requestId: string; workPackageId: string; preferredMasterRole?: MasterRole; inputRefs: string[]; expectedOutput: string }
  | { action: "release_master"; requestId: string; masterRequestId: string }
  | { action: "submit_master_analysis"; requestId: string; masterRequestId: string; submission: MasterAnalysisSubmission }
  | { action: "submit_doctor_synthesis"; requestId: string; workPackageId: string; synthesis: DoctorSynthesis }
  | { action: "review_doctor_synthesis"; requestId: string; workPackageId: string; decision: "accepted" | "revision_requested" }
  | { action: "cancel_task"; requestId: string; taskId: string }
  | { action: "complete_meeting"; requestId: string; report: FinalAcademicReport }
  | { action: "cancel_meeting"; requestId: string };

export interface OrchestrateLabWorkflowInput {
  cwd: string;
  meetingId: string;
  actorSessionId: string;
  action: LabOrchestrateAction | unknown;
}

export interface ReadLabWorkflowInput {
  cwd: string;
  meetingId: string;
  actorSessionId: string;
}

interface ChildSessionInput {
  cwd: string;
  meeting: GroupMeeting;
  task: UndergradTask;
  thread: UndergradThread;
}

interface UndergradTaskDeliveryInput {
  meeting: GroupMeeting;
  task: UndergradTask;
}

interface MasterTaskDeliveryInput {
  meeting: GroupMeeting;
  reservation: MasterReservation;
  workPackage: DoctorWorkPackage;
}

interface LabNoticeDeliveryInput {
  meeting: GroupMeeting;
  notice: LabWorkflowNotice;
}

export interface LabWorkflowOptions {
  agentDir?: string;
  runtimeId?: string;
  now?: () => string;
  readMeeting?: (cwd: string, meetingId: string, agentDir: string) => Promise<GroupMeeting | null>;
  deliverTask?: (input: UndergradTaskDeliveryInput) => Promise<void>;
  deliverMasterTask?: (input: MasterTaskDeliveryInput) => Promise<void>;
  deliverNotice?: (input: LabNoticeDeliveryInput) => Promise<void>;
  createChildSession?: (input: ChildSessionInput) => Promise<{ sessionId: string }>;
  abortSession?: (sessionId: string) => Promise<void>;
}

export class LabWorkflowError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "LabWorkflowError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new LabWorkflowError(`${label} must be an object`, "invalid_action");
  return value;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new LabWorkflowError(`${label} contains unsupported field ${unexpected}`, "invalid_action");
}

function textValue(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new LabWorkflowError(`${label} must be a non-empty string of at most ${max} characters`, "invalid_action");
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, max = MAX_TEXT): string | undefined {
  return value === undefined ? undefined : textValue(value, label, max);
}

function idValue(value: unknown, label: string): string {
  const id = textValue(value, label, 128);
  if (!SAFE_ID_PATTERN.test(id)) throw new LabWorkflowError(`${label} is invalid`, "invalid_action");
  return id;
}

function stringArray(value: unknown, label: string, { min = 0, max = MAX_ARRAY } = {}): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new LabWorkflowError(`${label} must contain ${min}-${max} entries`, "invalid_action");
  }
  return value.map((entry, index) => textValue(entry, `${label}[${index}]`));
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new LabWorkflowError(`${label} is invalid`, "invalid_action");
  }
  return value as T;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new LabWorkflowError(`${label} must be boolean`, "invalid_action");
  return value;
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new LabWorkflowError(`${label} must be an integer from ${min} to ${max}`, "invalid_action");
  }
  return Number(value);
}

function parseLiteratureDatabaseScope(value: unknown): LiteratureDatabase[] {
  if (value === undefined) return [...DEFAULT_LITERATURE_DATABASE_SCOPE];
  const requested = stringArray(value, "action.databaseScope", { min: 2, max: 3 });
  const unique = new Set(requested);
  if (
    unique.size !== requested.length
    || !unique.has("pubmed")
    || !unique.has("crossref")
    || [...unique].some((database) => database !== "pubmed" && database !== "crossref" && database !== "arxiv")
  ) {
    throw new LabWorkflowError("databaseScope must be pubmed + crossref, optionally with explicit arxiv preprint access", "invalid_action");
  }
  return ["pubmed", "crossref", ...(unique.has("arxiv") ? ["arxiv" as const] : [])];
}

function parseClarificationOptions(value: unknown, label: string): Array<{ id: string; label: string }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw new LabWorkflowError(`${label} must contain 2-8 entries`, "invalid_action");
  }
  const options = value.map((entry, index) => {
    const option = objectValue(entry, `${label}[${index}]`);
    allowedKeys(option, ["id", "label"], `${label}[${index}]`);
    return { id: idValue(option.id, `${label}[${index}].id`), label: textValue(option.label, `${label}[${index}].label`, MAX_SHORT_TEXT) };
  });
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    throw new LabWorkflowError("card option ids must be unique", "invalid_action");
  }
  return options;
}

function parseCard(value: unknown): ClarificationCard {
  const card = objectValue(value, "card");
  allowedKeys(card, ["questionId", "question", "options", "allowOther", "required"], "card");
  return {
    questionId: idValue(card.questionId, "card.questionId"),
    question: textValue(card.question, "card.question"),
    options: parseClarificationOptions(card.options, "card.options"),
    allowOther: booleanValue(card.allowOther, "card.allowOther"),
    required: booleanValue(card.required, "card.required"),
  };
}

function parseClarificationCards(value: unknown): ClarificationCard[] {
  const card = objectValue(value, "card");
  if (!("questions" in card)) return [parseCard(card)];
  allowedKeys(card, ["title", "description", "questions", "submitLabel"], "card");
  if (!Array.isArray(card.questions) || card.questions.length < 1 || card.questions.length > 8) {
    throw new LabWorkflowError("card.questions must contain 1-8 entries", "invalid_action");
  }
  const title = textValue(card.title, "card.title", MAX_SHORT_TEXT);
  const description = textValue(card.description, "card.description");
  const submitLabel = textValue(card.submitLabel, "card.submitLabel", MAX_SHORT_TEXT);
  const cards = card.questions.map((entry, index) => {
    const question = objectValue(entry, `card.questions[${index}]`);
    allowedKeys(question, ["id", "prompt", "type", "options"], `card.questions[${index}]`);
    return {
      questionId: idValue(question.id, `card.questions[${index}].id`),
      question: textValue(question.prompt, `card.questions[${index}].prompt`),
      options: parseClarificationOptions(question.options, `card.questions[${index}].options`),
      allowOther: false,
      required: true,
      selectionMode: enumValue(question.type, ["single_select", "multiple_select"], `card.questions[${index}].type`) === "single_select"
        ? "single" as const
        : "multiple" as const,
      ...(index === 0 ? { title, description } : {}),
      submitLabel,
    };
  });
  if (new Set(cards.map((entry) => entry.questionId)).size !== cards.length) {
    throw new LabWorkflowError("card question ids must be unique", "invalid_action");
  }
  return cards;
}

function parseBrief(value: unknown): ResearchBrief {
  if (typeof value === "string") return textValue(value, "brief");
  const brief = objectValue(value, "brief");
  allowedKeys(brief, ["title", "objective", "scope", "constraints"], "brief");
  return {
    title: textValue(brief.title, "brief.title", MAX_SHORT_TEXT),
    objective: textValue(brief.objective, "brief.objective"),
    scope: textValue(brief.scope, "brief.scope"),
    constraints: stringArray(brief.constraints, "brief.constraints"),
  };
}

function parseRecord(value: unknown, index: number): LiteratureRecord {
  const record = objectValue(value, `records[${index}]`);
  allowedKeys(record, ["title", "authors", "year", "doi", "pmid", "url", "source", "retrievedAt", "quoteOrMetadata"], `records[${index}]`);
  const doi = optionalText(record.doi, `records[${index}].doi`, MAX_SHORT_TEXT);
  const pmid = optionalText(record.pmid, `records[${index}].pmid`, MAX_SHORT_TEXT);
  const url = optionalText(record.url, `records[${index}].url`, 2048);
  if (!doi && !pmid && !url) throw new LabWorkflowError(`records[${index}] needs doi, pmid, or url`, "invalid_action");
  const year = record.year === undefined ? undefined : boundedInteger(record.year, `records[${index}].year`, 1500, 3000);
  return {
    title: textValue(record.title, `records[${index}].title`),
    authors: stringArray(record.authors, `records[${index}].authors`, { min: 1 }),
    ...(year === undefined ? {} : { year }),
    ...(doi ? { doi } : {}),
    ...(pmid ? { pmid } : {}),
    ...(url ? { url } : {}),
    source: textValue(record.source, `records[${index}].source`, MAX_SHORT_TEXT),
    retrievedAt: textValue(record.retrievedAt, `records[${index}].retrievedAt`, MAX_SHORT_TEXT),
    quoteOrMetadata: textValue(record.quoteOrMetadata, `records[${index}].quoteOrMetadata`),
  };
}

function parseUndergradResult(value: unknown, allowThreadIds: boolean): UndergradSubmissionInput {
  const result = objectValue(value, "result");
  allowedKeys(result, ["summary", "records", "artifactRefs", "limitations", "blockedReason", ...(allowThreadIds ? ["threadIds"] : [])], "result");
  if (!Array.isArray(result.records) || result.records.length > MAX_RECORDS) {
    throw new LabWorkflowError(`result.records must contain 0-${MAX_RECORDS} entries`, "invalid_action");
  }
  return {
    summary: textValue(result.summary, "result.summary"),
    records: result.records.map(parseRecord),
    artifactRefs: stringArray(result.artifactRefs, "result.artifactRefs"),
    limitations: stringArray(result.limitations, "result.limitations"),
    ...(result.blockedReason === undefined ? {} : { blockedReason: textValue(result.blockedReason, "result.blockedReason") }),
    ...(allowThreadIds && result.threadIds !== undefined ? { threadIds: stringArray(result.threadIds, "result.threadIds") } : {}),
  };
}

function parseMasterSubmission(value: unknown): MasterAnalysisSubmission {
  const submission = objectValue(value, "submission");
  allowedKeys(submission, ["analysis", "interpretation", "assumptions", "methodsUsed", "uncertainty", "artifactRefs"], "submission");
  return {
    analysis: textValue(submission.analysis, "submission.analysis"),
    interpretation: textValue(submission.interpretation, "submission.interpretation"),
    assumptions: stringArray(submission.assumptions, "submission.assumptions"),
    methodsUsed: stringArray(submission.methodsUsed, "submission.methodsUsed", { min: 1 }),
    uncertainty: stringArray(submission.uncertainty, "submission.uncertainty", { min: 1 }),
    artifactRefs: stringArray(submission.artifactRefs, "submission.artifactRefs"),
  };
}

function parseSynthesis(value: unknown): DoctorSynthesis {
  const synthesis = objectValue(value, "synthesis");
  allowedKeys(synthesis, ["ownReasoning", "masterInterpretations", "evidenceRefs", "conclusion", "hypotheses", "proposedMethods", "counterEvidence", "sensitivityChecks", "uncertainties", "limitations", "unansweredQuestions"], "synthesis");
  return {
    ownReasoning: textValue(synthesis.ownReasoning, "synthesis.ownReasoning"),
    masterInterpretations: stringArray(synthesis.masterInterpretations, "synthesis.masterInterpretations", { min: 1 }),
    evidenceRefs: stringArray(synthesis.evidenceRefs, "synthesis.evidenceRefs", { min: 1 }),
    conclusion: textValue(synthesis.conclusion, "synthesis.conclusion"),
    hypotheses: stringArray(synthesis.hypotheses, "synthesis.hypotheses"),
    proposedMethods: stringArray(synthesis.proposedMethods, "synthesis.proposedMethods"),
    counterEvidence: stringArray(synthesis.counterEvidence, "synthesis.counterEvidence"),
    sensitivityChecks: stringArray(synthesis.sensitivityChecks, "synthesis.sensitivityChecks"),
    uncertainties: stringArray(synthesis.uncertainties, "synthesis.uncertainties"),
    limitations: stringArray(synthesis.limitations, "synthesis.limitations", { min: 1 }),
    unansweredQuestions: stringArray(synthesis.unansweredQuestions, "synthesis.unansweredQuestions"),
  };
}

function parseFinalReport(value: unknown): FinalAcademicReport {
  const report = objectValue(value, "report");
  allowedKeys(report, [
    "title",
    "executiveSummary",
    "creativeRoute",
    "robustRoute",
    "conflictsAndLimitations",
    "conclusions",
    "hypotheses",
    "proposedMethods",
    "evidenceRefs",
    "openQuestions",
  ], "report");
  return {
    title: textValue(report.title, "report.title", MAX_SHORT_TEXT),
    executiveSummary: textValue(report.executiveSummary, "report.executiveSummary"),
    creativeRoute: textValue(report.creativeRoute, "report.creativeRoute"),
    robustRoute: textValue(report.robustRoute, "report.robustRoute"),
    conflictsAndLimitations: stringArray(report.conflictsAndLimitations, "report.conflictsAndLimitations", { min: 1 }),
    conclusions: stringArray(report.conclusions, "report.conclusions", { min: 1 }),
    hypotheses: stringArray(report.hypotheses, "report.hypotheses"),
    proposedMethods: stringArray(report.proposedMethods, "report.proposedMethods", { min: 1 }),
    evidenceRefs: stringArray(report.evidenceRefs, "report.evidenceRefs", { min: 2 }),
    openQuestions: stringArray(report.openQuestions, "report.openQuestions"),
  };
}

export function parseLabOrchestrateAction(value: unknown): LabOrchestrateAction {
  const raw = objectValue(value, "action");
  const action = textValue(raw.action, "action.action", 64);
  if (action === "get_state") {
    allowedKeys(raw, ["action"], "action");
    return { action };
  }
  const requestId = idValue(raw.requestId, "action.requestId");
  switch (action) {
    case "ask_clarification":
      allowedKeys(raw, ["action", "requestId", "card"], "action");
      return { action, requestId, cards: parseClarificationCards(raw.card) };
    case "submit_clarification": {
      allowedKeys(raw, ["action", "requestId", "questionId", "selectedOptionIds", "freeText"], "action");
      return { action, requestId, questionId: idValue(raw.questionId, "action.questionId"), selectedOptionIds: stringArray(raw.selectedOptionIds, "action.selectedOptionIds"), ...(raw.freeText === undefined ? {} : { freeText: textValue(raw.freeText, "action.freeText") }) };
    }
    case "dispatch_doctor":
      allowedKeys(raw, ["action", "requestId", "doctorRole", "brief"], "action");
      return { action, requestId, doctorRole: enumValue(raw.doctorRole, ["phd-1", "phd-2"], "action.doctorRole"), brief: parseBrief(raw.brief) };
    case "delegate_undergrad":
      allowedKeys(raw, ["action", "requestId", "workPackageId", "purpose", "workType", "databaseScope", "title", "objective", "instructions", "inputRefs", "acceptanceCriteria", "maxThreads"], "action");
      return {
        action,
        requestId,
        ...(raw.workPackageId === undefined ? {} : { workPackageId: idValue(raw.workPackageId, "action.workPackageId") }),
        purpose: enumValue(raw.purpose, ["scientific_retrieval", "clerical_supplement"], "action.purpose"),
        workType: enumValue(raw.workType, ["literature_search", "literature_validate", "literature_extract"], "action.workType"),
        databaseScope: parseLiteratureDatabaseScope(raw.databaseScope),
        title: textValue(raw.title, "action.title", MAX_SHORT_TEXT),
        objective: textValue(raw.objective, "action.objective"),
        instructions: stringArray(raw.instructions, "action.instructions", { min: 1 }),
        inputRefs: stringArray(raw.inputRefs, "action.inputRefs"),
        acceptanceCriteria: stringArray(raw.acceptanceCriteria, "action.acceptanceCriteria", { min: 1 }),
        maxThreads: boundedInteger(raw.maxThreads, "action.maxThreads", 1, 3),
      };
    case "spawn_undergrad_threads": {
      allowedKeys(raw, ["action", "requestId", "taskId", "threads"], "action");
      if (!Array.isArray(raw.threads) || raw.threads.length < 1 || raw.threads.length > 3) throw new LabWorkflowError("action.threads must contain 1-3 entries", "invalid_action");
      const threads = raw.threads.map((entry, index) => {
        const thread = objectValue(entry, `action.threads[${index}]`);
        allowedKeys(thread, ["title", "objective", "inputRefs", "acceptanceCriteria"], `action.threads[${index}]`);
        return { title: textValue(thread.title, `action.threads[${index}].title`, MAX_SHORT_TEXT), objective: textValue(thread.objective, `action.threads[${index}].objective`), inputRefs: stringArray(thread.inputRefs, `action.threads[${index}].inputRefs`), acceptanceCriteria: stringArray(thread.acceptanceCriteria, `action.threads[${index}].acceptanceCriteria`, { min: 1 }) };
      });
      return { action, requestId, taskId: idValue(raw.taskId, "action.taskId"), threads };
    }
    case "submit_undergrad_thread":
      allowedKeys(raw, ["action", "requestId", "taskId", "threadId", "result"], "action");
      return { action, requestId, taskId: idValue(raw.taskId, "action.taskId"), threadId: idValue(raw.threadId, "action.threadId"), result: parseUndergradResult(raw.result, false) };
    case "submit_undergrad_records":
      allowedKeys(raw, ["action", "requestId", "taskId", "result"], "action");
      return { action, requestId, taskId: idValue(raw.taskId, "action.taskId"), result: parseUndergradResult(raw.result, true) };
    case "review_undergrad_records":
      allowedKeys(raw, ["action", "requestId", "taskId", "decision"], "action");
      return { action, requestId, taskId: idValue(raw.taskId, "action.taskId"), decision: enumValue(raw.decision, ["accepted", "revision_requested"], "action.decision") };
    case "submit_pre_master_judgment":
      allowedKeys(raw, ["action", "requestId", "workPackageId", "judgment", "evidenceRefs"], "action");
      return { action, requestId, workPackageId: idValue(raw.workPackageId, "action.workPackageId"), judgment: textValue(raw.judgment, "action.judgment"), evidenceRefs: stringArray(raw.evidenceRefs, "action.evidenceRefs", { min: 1 }) };
    case "claim_master":
      allowedKeys(raw, ["action", "requestId", "workPackageId", "preferredMasterRole", "inputRefs", "expectedOutput"], "action");
      return { action, requestId, workPackageId: idValue(raw.workPackageId, "action.workPackageId"), ...(raw.preferredMasterRole === undefined ? {} : { preferredMasterRole: enumValue(raw.preferredMasterRole, ["master-1", "master-2"] as const, "action.preferredMasterRole") }), inputRefs: stringArray(raw.inputRefs, "action.inputRefs"), expectedOutput: textValue(raw.expectedOutput, "action.expectedOutput") };
    case "release_master":
      allowedKeys(raw, ["action", "requestId", "masterRequestId"], "action");
      return { action, requestId, masterRequestId: idValue(raw.masterRequestId, "action.masterRequestId") };
    case "submit_master_analysis":
      allowedKeys(raw, ["action", "requestId", "masterRequestId", "submission"], "action");
      return { action, requestId, masterRequestId: idValue(raw.masterRequestId, "action.masterRequestId"), submission: parseMasterSubmission(raw.submission) };
    case "submit_doctor_synthesis":
      allowedKeys(raw, ["action", "requestId", "workPackageId", "synthesis"], "action");
      return { action, requestId, workPackageId: idValue(raw.workPackageId, "action.workPackageId"), synthesis: parseSynthesis(raw.synthesis) };
    case "review_doctor_synthesis":
      allowedKeys(raw, ["action", "requestId", "workPackageId", "decision"], "action");
      return { action, requestId, workPackageId: idValue(raw.workPackageId, "action.workPackageId"), decision: enumValue(raw.decision, ["accepted", "revision_requested"] as const, "action.decision") };
    case "cancel_task":
      allowedKeys(raw, ["action", "requestId", "taskId"], "action");
      return { action, requestId, taskId: idValue(raw.taskId, "action.taskId") };
    case "complete_meeting":
      allowedKeys(raw, ["action", "requestId", "report"], "action");
      return { action, requestId, report: parseFinalReport(raw.report) };
    case "cancel_meeting":
      allowedKeys(raw, ["action", "requestId"], "action");
      return { action, requestId };
    default:
      throw new LabWorkflowError(`Unknown lab orchestration action: ${action}`, "invalid_action");
  }
}

function workflowDirectory(cwd: string, agentDir: string): string {
  return join(agentDir, "meetings", createHash("sha256").update(resolve(cwd)).digest("hex"));
}

function workflowPath(cwd: string, meetingId: string, agentDir: string): string {
  if (!MEETING_ID_PATTERN.test(meetingId)) throw new LabWorkflowError("Invalid meeting id", "invalid_meeting_id");
  return join(workflowDirectory(cwd, agentDir), `${meetingId}.workflow.json`);
}

async function writeWorkflow(workflow: LabWorkflow, agentDir: string): Promise<void> {
  const directory = workflowDirectory(workflow.cwd, agentDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = workflowPath(workflow.cwd, workflow.meetingId, agentDir);
  const temporary = join(directory, `.${workflow.meetingId}.${randomUUID()}.workflow.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function markdownList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None recorded";
}

async function writeFinalReportArtifact(cwd: string, meetingId: string, report: FinalAcademicReport, createdAt: string): Promise<FinalReportArtifact> {
  const relativePath = `.medpi/meetings/${meetingId}/final-report.md`;
  const directory = join(cwd, ".medpi", "meetings", meetingId);
  const target = join(directory, "final-report.md");
  const contents = [
    `# ${report.title}`,
    "",
    "## Executive summary",
    "",
    report.executiveSummary,
    "",
    "## Creative route",
    "",
    report.creativeRoute,
    "",
    "## Robust route",
    "",
    report.robustRoute,
    "",
    "## Conflicts and limitations",
    "",
    markdownList(report.conflictsAndLimitations),
    "",
    "## Conclusions",
    "",
    markdownList(report.conclusions),
    "",
    "## Hypotheses",
    "",
    markdownList(report.hypotheses),
    "",
    "## Proposed methods",
    "",
    markdownList(report.proposedMethods),
    "",
    "## Evidence",
    "",
    markdownList(report.evidenceRefs),
    "",
    "## Open questions",
    "",
    markdownList(report.openQuestions),
    "",
  ].join("\n");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.final-report.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return {
    path: relativePath,
    artifactRef: `artifact://meetings/${meetingId}/final-report.md`,
    sha256: createHash("sha256").update(contents).digest("hex"),
    size: Buffer.byteLength(contents, "utf8"),
    createdAt,
  };
}

function parseWorkflow(contents: string, meeting: GroupMeeting): LabWorkflow {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new LabWorkflowError("Invalid lab workflow JSON", "invalid_workflow");
  }
  if (!isObject(value)
    || value.version !== WORKFLOW_VERSION
    || value.meetingId !== meeting.meetingId
    || value.cwd !== meeting.cwd
    || typeof value.runtimeId !== "string"
    || !Array.isArray(value.clarificationCards)
    || !Array.isArray(value.clarificationResponses)
    || !Array.isArray(value.workPackages)
    || !Array.isArray(value.undergradTasks)
    || !Array.isArray(value.undergradThreads)
    || !Array.isArray(value.masterReservations)
    || (value.notices !== undefined && !Array.isArray(value.notices))
    || !isObject(value.idempotency)) {
    throw new LabWorkflowError("Invalid lab workflow metadata", "invalid_workflow");
  }
  value.notices ??= [];
  return value as unknown as LabWorkflow;
}

function newWorkflow(meeting: GroupMeeting, runtimeId: string, now: string): LabWorkflow {
  return {
    version: WORKFLOW_VERSION,
    meetingId: meeting.meetingId,
    cwd: meeting.cwd,
    runtimeId,
    status: "clarifying",
    clarificationCards: [],
    clarificationResponses: [],
    workPackages: [],
    undergradTasks: [],
    undergradThreads: [],
    masterReservations: [],
    notices: [],
    idempotency: {},
    createdAt: now,
    updatedAt: now,
  };
}

async function loadWorkflow(path: string, meeting: GroupMeeting, runtimeId: string, now: string): Promise<{ workflow: LabWorkflow; created: boolean }> {
  try {
    return { workflow: parseWorkflow(await readFile(path, "utf8"), meeting), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { workflow: newWorkflow(meeting, runtimeId, now), created: true };
  }
}

async function withMeetingLock<T>(cwd: string, meetingId: string, agentDir: string, fn: () => Promise<T>): Promise<T> {
  const directory = workflowDirectory(cwd, agentDir);
  const path = workflowPath(cwd, meetingId, agentDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    realpath: false,
    lockfilePath: `${path}.lock`,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 50, minTimeout: 10, maxTimeout: 200, factor: 1.2 },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function nowValue(options: LabWorkflowOptions): string {
  return options.now?.() ?? new Date().toISOString();
}

async function resolveMeeting(cwd: string, meetingId: string, options: LabWorkflowOptions): Promise<GroupMeeting> {
  const agentDir = options.agentDir ?? getAgentDir();
  const readMeeting = options.readMeeting ?? (async (requestedCwd: string, requestedMeetingId: string, requestedAgentDir: string) => (
    (await import("./group-meeting-server")).readGroupMeeting(requestedCwd, requestedMeetingId, requestedAgentDir)
  ));
  const meeting = await readMeeting(cwd, meetingId, agentDir);
  if (!meeting) throw new LabWorkflowError("Meeting not found", "meeting_not_found");
  if (meeting.status !== "ready") throw new LabWorkflowError("Meeting is not ready", "meeting_not_ready");
  return meeting;
}

function resolveActor(meeting: GroupMeeting, workflow: LabWorkflow, sessionId: string): LabWorkflowActor {
  const member = meeting.members.find((candidate) => candidate.sessionId === sessionId);
  if (member?.sessionId) return { kind: "member", role: member.role, sessionId: member.sessionId };
  const thread = workflow.undergradThreads.find((candidate) => candidate.sessionId === sessionId);
  if (thread?.sessionId) return { kind: "undergrad_thread", role: "undergraduate", sessionId, taskId: thread.parentTaskId, threadId: thread.threadId };
  throw new LabWorkflowError("Session is not a member of this meeting", "actor_forbidden");
}

function visibleWorkflow(workflow: LabWorkflow, actor: LabWorkflowActor): LabWorkflow {
  const visible = structuredClone(workflow);
  visible.idempotency = {};
  if (actor.kind === "member" && actor.role === "pi") return visible;
  delete visible.finalReport;
  delete visible.finalReportArtifact;
  visible.notices = visible.notices.filter((notice) => notice.toSessionId === actor.sessionId);
  if (actor.kind === "undergrad_thread") {
    visible.workPackages = [];
    visible.masterReservations = [];
    visible.undergradTasks = visible.undergradTasks.filter((task) => task.taskId === actor.taskId);
    visible.undergradThreads = visible.undergradThreads.filter((thread) => thread.threadId === actor.threadId);
    return visible;
  }
  if (actor.role === "undergraduate") {
    visible.workPackages = [];
    visible.masterReservations = [];
    return visible;
  }
  if (actor.role === "phd-1" || actor.role === "phd-2") {
    const packageIds = new Set(visible.workPackages.filter((entry) => entry.doctorRole === actor.role).map((entry) => entry.workPackageId));
    visible.workPackages = visible.workPackages.filter((entry) => packageIds.has(entry.workPackageId));
    visible.undergradTasks = visible.undergradTasks.filter((task) => task.requesterSessionId === actor.sessionId || (task.doctorWorkPackageId && packageIds.has(task.doctorWorkPackageId)));
    const taskIds = new Set(visible.undergradTasks.map((task) => task.taskId));
    visible.undergradThreads = visible.undergradThreads.filter((thread) => taskIds.has(thread.parentTaskId));
    visible.masterReservations = visible.masterReservations.filter((reservation) => packageIds.has(reservation.workPackageId));
    return visible;
  }
  const reservationPackageIds = new Set(visible.masterReservations.filter((reservation) => reservation.masterRole === actor.role).map((reservation) => reservation.workPackageId));
  visible.workPackages = visible.workPackages.filter((entry) => reservationPackageIds.has(entry.workPackageId));
  visible.masterReservations = visible.masterReservations.filter((reservation) => reservation.masterRole === actor.role);
  visible.undergradTasks = visible.undergradTasks.filter((task) => task.requesterSessionId === actor.sessionId);
  const taskIds = new Set(visible.undergradTasks.map((task) => task.taskId));
  visible.undergradThreads = visible.undergradThreads.filter((thread) => taskIds.has(thread.parentTaskId));
  return visible;
}

function requireMember(actor: LabWorkflowActor, roles: readonly GroupMeetingRole[]): asserts actor is Extract<LabWorkflowActor, { kind: "member" }> {
  if (actor.kind !== "member" || !roles.includes(actor.role)) throw new LabWorkflowError("Action is not allowed for this meeting role", "action_forbidden");
}

function findPackage(workflow: LabWorkflow, workPackageId: string): DoctorWorkPackage {
  const workPackage = workflow.workPackages.find((candidate) => candidate.workPackageId === workPackageId);
  if (!workPackage) throw new LabWorkflowError("Doctor work package not found", "work_package_not_found");
  return workPackage;
}

function findTask(workflow: LabWorkflow, taskId: string): UndergradTask {
  const task = workflow.undergradTasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new LabWorkflowError("Undergraduate task not found", "task_not_found");
  return task;
}

function findReservation(workflow: LabWorkflow, requestId: string): MasterReservation {
  const reservation = workflow.masterReservations.find((candidate) => candidate.requestId === requestId);
  if (!reservation) throw new LabWorkflowError("Master reservation not found", "reservation_not_found");
  return reservation;
}

function requireDoctorOwner(actor: LabWorkflowActor, workPackage: DoctorWorkPackage): asserts actor is Extract<LabWorkflowActor, { kind: "member" }> {
  requireMember(actor, ["phd-1", "phd-2"]);
  if (actor.role !== workPackage.doctorRole) throw new LabWorkflowError("Doctor work package belongs to another role", "action_forbidden");
}

function hasCompletedClarifications(workflow: LabWorkflow): boolean {
  const required = workflow.clarificationCards.filter((card) => card.required);
  return required.length > 0 && required.every((card) => workflow.clarificationResponses.some((response) => response.questionId === card.questionId));
}

function requireAcceptedEvidence(workflow: LabWorkflow, workPackage: DoctorWorkPackage, evidenceRefs: string[]): void {
  const accepted = workPackage.undergradTaskIds.filter((taskId) => findTask(workflow, taskId).status === "accepted");
  if (accepted.length === 0) throw new LabWorkflowError("An accepted undergraduate task is required", "stage_violation");
  if (!accepted.some((taskId) => evidenceRefs.includes(`undergrad-task:${taskId}`))) {
    throw new LabWorkflowError("Evidence refs must include an accepted undergraduate task", "stage_violation");
  }
}

function requireMeetingRefs(meetingId: string, refs: string[]): void {
  for (const ref of refs) {
    const match = /^artifact:\/\/meetings\/([^/]+)\//.exec(ref);
    if (match && match[1] !== meetingId) throw new LabWorkflowError("Artifact ref belongs to another meeting", "cross_meeting_ref");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function actionFingerprint(action: LabOrchestrateAction): string {
  return createHash("sha256").update(stableJson(action)).digest("hex");
}

function markRestartedWorkInterrupted(workflow: LabWorkflow, runtimeId: string, now: string): boolean {
  if (workflow.runtimeId === runtimeId) return false;
  for (const thread of workflow.undergradThreads) {
    if (ACTIVE_THREAD_STATUSES.has(thread.status)) {
      thread.status = "interrupted";
      thread.updatedAt = now;
    }
  }
  for (const task of workflow.undergradTasks) {
    if (task.status === "running" && task.threadIds.some((threadId) => workflow.undergradThreads.find((thread) => thread.threadId === threadId)?.status === "interrupted")) {
      task.status = "interrupted";
      task.updatedAt = now;
    }
  }
  for (const reservation of workflow.masterReservations) {
    if (ACTIVE_RESERVATION_STATUSES.has(reservation.status)) {
      reservation.status = "interrupted";
      reservation.updatedAt = now;
    }
  }
  for (const [requestId, entry] of Object.entries(workflow.idempotency)) {
    if (entry.status === "pending") {
      workflow.idempotency[requestId] = { ...entry, status: "interrupted", updatedAt: now };
    }
  }
  workflow.runtimeId = runtimeId;
  workflow.updatedAt = now;
  return true;
}

async function defaultCreateChildSession(input: ChildSessionInput): Promise<{ sessionId: string }> {
  const undergraduate = input.meeting.members.find((member) => member.role === "undergraduate");
  if (!undergraduate?.provider || !undergraduate.modelId || !undergraduate.thinkingLevel) {
    throw new LabWorkflowError("Undergraduate session model is unavailable", "child_session_unavailable");
  }
  const result = await createNewAgentSession(input.cwd, {
    type: "prompt",
    message: [
      "You are an isolated undergraduate literature-retrieval worker.",
      "Return only bibliographic records through lab_orchestrate; do not interpret, conclude, hypothesize, or propose methods.",
      JSON.stringify({
        meetingId: input.meeting.meetingId,
        taskId: input.task.taskId,
        threadId: input.thread.threadId,
        attempt: input.thread.attempt,
        databaseScope: input.task.databaseScope,
        title: input.thread.title,
        objective: input.thread.objective,
        inputRefs: input.thread.inputRefs,
        acceptanceCriteria: input.thread.acceptanceCriteria,
      }),
    ].join("\n"),
    provider: undergraduate.provider,
    modelId: undergraduate.modelId,
    thinkingLevel: undergraduate.thinkingLevel,
    toolNames: getUndergraduateChildToolNames(),
  }, {
    persistStartupPreferences: false,
    persistSession: true,
    fixedToolNames: getUndergraduateChildToolNames(),
    fixedSystemPrompt: getUndergraduateChildSystemPrompt(),
  });
  return { sessionId: result.sessionId };
}

async function defaultAbortSession(sessionId: string): Promise<void> {
  await getRpcSession(sessionId)?.send({ type: "abort" });
}

async function defaultDeliverTask({ meeting, task }: UndergradTaskDeliveryInput): Promise<void> {
  const undergraduate = meeting.members.find((member) => member.role === "undergraduate");
  if (!undergraduate?.sessionId) throw new LabWorkflowError("Undergraduate coordinator session is unavailable", "undergraduate_unavailable");
  let session = getRpcSession(undergraduate.sessionId);
  if (!session?.isAlive()) {
    const sessionFile = await resolveSessionPath(undergraduate.sessionId);
    if (!sessionFile) throw new LabWorkflowError("Undergraduate coordinator session is unavailable", "undergraduate_unavailable");
    ({ session } = await startRpcSession(undergraduate.sessionId, sessionFile, meeting.cwd));
  }
  const state = await session.send({ type: "get_state" }) as {
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isBashRunning?: boolean;
    isCompacting?: boolean;
  };
  const type = state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting
    ? "follow_up"
    : "prompt";
  await session.send({
    type,
    message: [
      "A structured undergraduate literature task was assigned to this coordinator.",
      "Use only lab_orchestrate actions for thread creation and submission. Return bibliographic records only.",
      JSON.stringify({
        meetingId: meeting.meetingId,
        taskId: task.taskId,
        attempt: task.attempt,
        workType: task.workType,
        databaseScope: task.databaseScope,
        title: task.title,
        objective: task.objective,
        instructions: task.instructions,
        inputRefs: task.inputRefs,
        acceptanceCriteria: task.acceptanceCriteria,
        maxThreads: task.maxThreads,
      }),
    ].join("\n"),
  });
}

async function defaultDeliverMasterTask({ meeting, reservation, workPackage }: MasterTaskDeliveryInput): Promise<void> {
  let session = getRpcSession(reservation.masterSessionId);
  if (!session?.isAlive()) {
    const sessionFile = await resolveSessionPath(reservation.masterSessionId);
    if (!sessionFile) throw new LabWorkflowError("Master session is unavailable", "master_unavailable");
    ({ session } = await startRpcSession(reservation.masterSessionId, sessionFile, meeting.cwd));
  }
  const state = await session.send({ type: "get_state" }) as {
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isBashRunning?: boolean;
    isCompacting?: boolean;
  };
  const type = state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting
    ? "follow_up"
    : "prompt";
  await session.send({
    type,
    message: [
      "A doctor atomically reserved you for a structured analysis task.",
      "Analyze the supplied evidence, return your interpretation to the requesting doctor in natural language, and submit the typed result with lab_orchestrate.",
      JSON.stringify({
        meetingId: meeting.meetingId,
        masterRequestId: reservation.requestId,
        doctorRole: reservation.doctorRole,
        workPackageId: workPackage.workPackageId,
        mode: workPackage.mode,
        inputRefs: reservation.inputRefs,
        expectedOutput: reservation.expectedOutput,
      }),
    ].join("\n"),
  });
}

async function defaultDeliverNotice({ meeting, notice }: LabNoticeDeliveryInput): Promise<void> {
  let session = getRpcSession(notice.toSessionId);
  if (!session?.isAlive()) {
    const sessionFile = await resolveSessionPath(notice.toSessionId);
    if (!sessionFile) throw new LabWorkflowError("Notice recipient session is unavailable", "notice_recipient_unavailable");
    ({ session } = await startRpcSession(notice.toSessionId, sessionFile, meeting.cwd));
  }
  const state = await session.send({ type: "get_state" }) as {
    isStreaming?: boolean;
    isPromptRunning?: boolean;
    isBashRunning?: boolean;
    isCompacting?: boolean;
  };
  const type = state.isStreaming || state.isPromptRunning || state.isBashRunning || state.isCompacting
    ? "follow_up"
    : "prompt";
  await session.send({
    type,
    message: [
      "A persisted Virtual Biomed Lab workflow event requires your attention.",
      "This notice is informational and cannot change workflow state. Read canonical state and use lab_orchestrate for any transition.",
      JSON.stringify({ meetingId: meeting.meetingId, noticeId: notice.noticeId, event: notice.event, ...notice.payload }),
    ].join("\n"),
  });
}

async function applyAction(
  workflow: LabWorkflow,
  meeting: GroupMeeting,
  actor: LabWorkflowActor,
  action: Exclude<LabOrchestrateAction, { action: "get_state" }>,
  options: LabWorkflowOptions,
  persist: () => Promise<void>,
): Promise<void> {
  const now = nowValue(options);
  const notify = async (toRole: GroupMeetingRole, toSessionId: string | null, event: LabWorkflowNoticeEvent, payload: Record<string, unknown>): Promise<void> => {
    const notice: LabWorkflowNotice = {
      noticeId: randomUUID(),
      event,
      toRole,
      toSessionId: toSessionId ?? "",
      payload,
      status: "pending",
      createdAt: nowValue(options),
      updatedAt: nowValue(options),
    };
    workflow.notices.push(notice);
    await persist();
    if (!toSessionId) {
      notice.status = "failed";
      notice.error = `Notice recipient ${toRole} has no meeting session`;
      notice.updatedAt = nowValue(options);
      await persist();
      return;
    }
    try {
      await (options.deliverNotice ?? defaultDeliverNotice)({ meeting, notice });
      notice.status = "delivered";
    } catch (error) {
      notice.status = "failed";
      notice.error = error instanceof Error ? error.message : String(error);
    }
    notice.updatedAt = nowValue(options);
    await persist();
  };
  const notifyRole = (toRole: GroupMeetingRole, event: LabWorkflowNoticeEvent, payload: Record<string, unknown>): Promise<void> => (
    notify(toRole, meeting.members.find((member) => member.role === toRole)?.sessionId ?? null, event, payload)
  );
  switch (action.action) {
    case "ask_clarification": {
      requireMember(actor, ["pi"]);
      if (!new Set<WorkflowStatus>(["clarifying", "awaiting_user_input"]).has(workflow.status)) throw new LabWorkflowError("Clarifications are closed", "stage_violation");
      const questionIds = action.cards.map((card) => card.questionId);
      if (new Set(questionIds).size !== questionIds.length || workflow.clarificationCards.some((card) => questionIds.includes(card.questionId))) {
        throw new LabWorkflowError("Clarification question already exists", "duplicate_question");
      }
      workflow.clarificationCards.push(...action.cards);
      workflow.status = "awaiting_user_input";
      break;
    }
    case "submit_clarification": {
      requireMember(actor, ["pi"]);
      const card = workflow.clarificationCards.find((candidate) => candidate.questionId === action.questionId);
      if (!card) throw new LabWorkflowError("Clarification question not found", "question_not_found");
      if (workflow.brief) throw new LabWorkflowError("Research brief is already immutable", "stage_violation");
      if (action.selectedOptionIds.some((id) => !card.options.some((option) => option.id === id))) throw new LabWorkflowError("Clarification response contains an invalid option", "invalid_action");
      if (action.selectedOptionIds.length === 0 && !(card.allowOther && action.freeText)) throw new LabWorkflowError("Clarification response is empty", "invalid_action");
      const response: ClarificationResponse = { questionId: card.questionId, selectedOptionIds: [...new Set(action.selectedOptionIds)], ...(action.freeText ? { freeText: action.freeText } : {}), answeredAt: now };
      const index = workflow.clarificationResponses.findIndex((candidate) => candidate.questionId === card.questionId);
      if (index >= 0) workflow.clarificationResponses[index] = response;
      else workflow.clarificationResponses.push(response);
      workflow.status = hasCompletedClarifications(workflow) ? "brief_ready" : "awaiting_user_input";
      await notifyRole("pi", "clarification_submitted", { questionId: action.questionId, workflowStatus: workflow.status });
      break;
    }
    case "dispatch_doctor": {
      requireMember(actor, ["pi"]);
      if (!hasCompletedClarifications(workflow)) throw new LabWorkflowError("Required clarifications are incomplete", "clarification_required");
      if (workflow.brief && stableJson(workflow.brief) !== stableJson(action.brief)) throw new LabWorkflowError("Research brief is immutable", "brief_conflict");
      if (workflow.workPackages.some((candidate) => candidate.doctorRole === action.doctorRole)) throw new LabWorkflowError("Doctor work package already exists", "work_package_exists");
      workflow.brief ??= action.brief;
      const workPackage: DoctorWorkPackage = {
        workPackageId: randomUUID(),
        doctorRole: action.doctorRole,
        mode: action.doctorRole === "phd-1" ? "creative" : "robust",
        status: "draft",
        undergradTaskIds: [],
        createdAt: now,
        updatedAt: now,
      };
      workflow.workPackages.push(workPackage);
      workflow.status = "running";
      await notifyRole(action.doctorRole, "doctor_dispatched", { workPackageId: workPackage.workPackageId, mode: workPackage.mode, brief: workflow.brief });
      break;
    }
    case "delegate_undergrad": {
      requireMember(actor, ["pi", "phd-1", "phd-2", "master-1", "master-2"]);
      if (!workflow.brief) throw new LabWorkflowError("Research brief is required before delegation", "clarification_required");
      requireMeetingRefs(workflow.meetingId, action.inputRefs);
      let workPackage: DoctorWorkPackage | undefined;
      if (actor.role === "phd-1" || actor.role === "phd-2") {
        if (action.purpose !== "scientific_retrieval" || !action.workPackageId) throw new LabWorkflowError("Doctor retrieval must belong to a work package", "invalid_action");
        workPackage = findPackage(workflow, action.workPackageId);
        requireDoctorOwner(actor, workPackage);
        if (!new Set<WorkPackageStatus>(["draft", "retrieval_dispatched"]).has(workPackage.status)) throw new LabWorkflowError("Doctor retrieval stage is closed", "stage_violation");
      } else if (action.purpose !== "clerical_supplement") {
        throw new LabWorkflowError("PI and master delegation is limited to clerical supplements", "action_forbidden");
      }
      if (actor.role === "master-1" || actor.role === "master-2") {
        const active = workflow.masterReservations.find((reservation) => reservation.masterRole === actor.role && ACTIVE_RESERVATION_STATUSES.has(reservation.status));
        if (!active) throw new LabWorkflowError("Master has no active delegated analysis", "stage_violation");
        if (action.workPackageId && action.workPackageId !== active.workPackageId) throw new LabWorkflowError("Master task belongs to another work package", "action_forbidden");
      }
      const task: UndergradTask = {
        taskId: randomUUID(),
        requesterRole: actor.role as SeniorRole,
        requesterSessionId: actor.sessionId,
        ...(action.workPackageId ? { doctorWorkPackageId: action.workPackageId } : {}),
        purpose: action.purpose,
        workType: action.workType,
        databaseScope: action.databaseScope ?? [...DEFAULT_LITERATURE_DATABASE_SCOPE],
        title: action.title,
        objective: action.objective,
        instructions: action.instructions,
        inputRefs: action.inputRefs,
        acceptanceCriteria: action.acceptanceCriteria,
        maxThreads: action.maxThreads,
        status: "queued",
        attempt: 1,
        threadIds: [],
        createdAt: now,
        updatedAt: now,
      };
      workflow.undergradTasks.push(task);
      if (workPackage) {
        workPackage.undergradTaskIds.push(task.taskId);
        workPackage.status = "retrieval_dispatched";
        workPackage.updatedAt = now;
      }
      await persist();
      try {
        await (options.deliverTask ?? defaultDeliverTask)({ meeting, task });
        task.status = "running";
      } catch (error) {
        task.status = "failed";
        task.submission = {
          summary: "Undergraduate task delivery failed",
          records: [],
          artifactRefs: [],
          limitations: [error instanceof Error ? error.message : String(error)],
          blockedReason: error instanceof Error ? error.message : String(error),
        };
      }
      task.updatedAt = nowValue(options);
      await persist();
      break;
    }
    case "spawn_undergrad_threads": {
      requireMember(actor, ["undergraduate"]);
      const task = findTask(workflow, action.taskId);
      for (const spec of action.threads) requireMeetingRefs(workflow.meetingId, spec.inputRefs);
      if (!new Set<UndergradTaskStatus>(["queued", "running", "revision_requested", "interrupted"]).has(task.status)) throw new LabWorkflowError("Task cannot start threads in its current state", "stage_violation");
      const currentTaskActive = workflow.undergradThreads.filter((thread) => thread.parentTaskId === task.taskId && thread.attempt === task.attempt && ACTIVE_THREAD_STATUSES.has(thread.status)).length;
      const globalActive = workflow.undergradThreads.filter((thread) => ACTIVE_THREAD_STATUSES.has(thread.status)).length;
      if (currentTaskActive + action.threads.length > task.maxThreads || currentTaskActive + action.threads.length > 3 || globalActive + action.threads.length > 6) {
        throw new LabWorkflowError("Undergraduate thread capacity exceeded", "undergrad_capacity_exceeded");
      }
      if (task.status === "revision_requested" || task.status === "interrupted") task.attempt += 1;
      const created = action.threads.map((spec): UndergradThread => ({
        threadId: randomUUID(),
        parentTaskId: task.taskId,
        attempt: task.attempt,
        ...spec,
        status: "created",
        sessionId: null,
        createdAt: now,
        updatedAt: now,
      }));
      workflow.undergradThreads.push(...created);
      task.threadIds.push(...created.map((thread) => thread.threadId));
      task.status = "running";
      task.updatedAt = now;
      await persist();
      const createChildSession = options.createChildSession ?? defaultCreateChildSession;
      for (const thread of created) {
        try {
          thread.sessionId = (await createChildSession({ cwd: workflow.cwd, meeting, task, thread })).sessionId;
          thread.status = "running";
        } catch (error) {
          thread.status = "failed";
          thread.error = error instanceof Error ? error.message : String(error);
        }
        thread.updatedAt = nowValue(options);
        await persist();
      }
      break;
    }
    case "submit_undergrad_thread": {
      if (actor.kind !== "undergrad_thread" || actor.taskId !== action.taskId || actor.threadId !== action.threadId) throw new LabWorkflowError("Child thread can only submit its own result", "action_forbidden");
      const thread = workflow.undergradThreads.find((candidate) => candidate.threadId === action.threadId && candidate.parentTaskId === action.taskId);
      if (!thread) throw new LabWorkflowError("Undergraduate thread not found", "thread_not_found");
      if (thread.status !== "running") throw new LabWorkflowError("Undergraduate thread is not running", "stage_violation");
      requireMeetingRefs(workflow.meetingId, action.result.artifactRefs);
      thread.result = action.result;
      thread.status = action.result.blockedReason ? "blocked" : "submitted";
      thread.updatedAt = now;
      await notifyRole("undergraduate", "undergrad_thread_submitted", { taskId: action.taskId, threadId: action.threadId, threadStatus: thread.status });
      break;
    }
    case "submit_undergrad_records": {
      requireMember(actor, ["undergraduate"]);
      const task = findTask(workflow, action.taskId);
      if (!new Set<UndergradTaskStatus>(["running", "revision_requested"]).has(task.status)) throw new LabWorkflowError("Undergraduate task is not accepting records", "stage_violation");
      requireMeetingRefs(workflow.meetingId, action.result.artifactRefs);
      const threadIds = action.result.threadIds ?? [];
      if (threadIds.length === 0 || threadIds.some((threadId) => !task.threadIds.includes(threadId))) throw new LabWorkflowError("Submission must reference this task's threads", "invalid_action");
      if (threadIds.some((threadId) => workflow.undergradThreads.find((thread) => thread.threadId === threadId)?.status !== "submitted")) throw new LabWorkflowError("All referenced threads must be submitted", "stage_violation");
      task.submission = action.result;
      task.status = action.result.blockedReason ? "blocked" : "submitted";
      task.updatedAt = now;
      await notify(task.requesterRole, task.requesterSessionId, "undergrad_records_submitted", { taskId: task.taskId, workPackageId: task.doctorWorkPackageId ?? null, taskStatus: task.status });
      break;
    }
    case "review_undergrad_records": {
      requireMember(actor, ["pi", "phd-1", "phd-2", "master-1", "master-2"]);
      const task = findTask(workflow, action.taskId);
      if (actor.role !== "pi" && actor.sessionId !== task.requesterSessionId) throw new LabWorkflowError("Only the requester or PI can review this task", "action_forbidden");
      if (task.status !== "submitted") throw new LabWorkflowError("Only submitted tasks can be reviewed", "stage_violation");
      task.status = action.decision;
      task.updatedAt = now;
      if (task.doctorWorkPackageId) {
        const workPackage = findPackage(workflow, task.doctorWorkPackageId);
        if (action.decision === "accepted" && workPackage.undergradTaskIds.every((taskId) => findTask(workflow, taskId).status === "accepted")) workPackage.status = "retrieval_accepted";
        workPackage.updatedAt = now;
      }
      if (action.decision === "revision_requested") {
        await notifyRole("undergraduate", "undergrad_revision_requested", { taskId: task.taskId, requesterRole: task.requesterRole });
      }
      break;
    }
    case "submit_pre_master_judgment": {
      const workPackage = findPackage(workflow, action.workPackageId);
      requireDoctorOwner(actor, workPackage);
      if (workPackage.status !== "retrieval_accepted") throw new LabWorkflowError("Accepted retrieval is required before pre-master judgment", "stage_violation");
      requireAcceptedEvidence(workflow, workPackage, action.evidenceRefs);
      workPackage.preMasterJudgment = { judgment: action.judgment, evidenceRefs: action.evidenceRefs, submittedAt: now };
      workPackage.status = "pre_master_judgment";
      workPackage.updatedAt = now;
      break;
    }
    case "claim_master": {
      const workPackage = findPackage(workflow, action.workPackageId);
      requireDoctorOwner(actor, workPackage);
      if (workPackage.status !== "pre_master_judgment") throw new LabWorkflowError("Pre-master judgment is required before claiming a master", "stage_violation");
      if (workflow.masterReservations.some((reservation) => reservation.requestId === action.requestId)) {
        throw new LabWorkflowError("A failed or released master request must be retried with a new requestId", "idempotency_conflict");
      }
      requireMeetingRefs(workflow.meetingId, action.inputRefs);
      const candidates: MasterRole[] = action.preferredMasterRole ? [action.preferredMasterRole] : ["master-1", "master-2"];
      const masterRole = candidates.find((role) => !workflow.masterReservations.some((reservation) => reservation.masterRole === role && ACTIVE_RESERVATION_STATUSES.has(reservation.status)));
      if (!masterRole) throw new LabWorkflowError("No master slot is available", "master_capacity_exceeded");
      const master = meeting.members.find((member) => member.role === masterRole && member.sessionId);
      if (!master?.sessionId) throw new LabWorkflowError("Master session is unavailable", "master_capacity_exceeded");
      const reservation: MasterReservation = {
        requestId: action.requestId,
        workPackageId: workPackage.workPackageId,
        doctorRole: workPackage.doctorRole,
        masterRole,
        masterSessionId: master.sessionId,
        inputRefs: action.inputRefs,
        expectedOutput: action.expectedOutput,
        status: "requested",
        createdAt: now,
        updatedAt: now,
      };
      workflow.masterReservations.push(reservation);
      workPackage.masterRequestId = action.requestId;
      workPackage.status = "master_requested";
      workPackage.updatedAt = now;
      await persist();
      try {
        await (options.deliverMasterTask ?? defaultDeliverMasterTask)({ meeting, reservation, workPackage });
        reservation.status = "running";
        reservation.updatedAt = nowValue(options);
      } catch (error) {
        reservation.status = "released";
        reservation.error = error instanceof Error ? error.message : String(error);
        reservation.updatedAt = nowValue(options);
        workPackage.status = "pre_master_judgment";
        delete workPackage.masterRequestId;
        workPackage.updatedAt = nowValue(options);
        throw new LabWorkflowError(`Master task delivery failed: ${reservation.error}`, "master_delivery_failed");
      }
      break;
    }
    case "release_master": {
      const reservation = findReservation(workflow, action.masterRequestId);
      if (actor.kind !== "member" || (actor.role !== "pi" && actor.role !== reservation.doctorRole && actor.role !== reservation.masterRole)) throw new LabWorkflowError("Master reservation belongs to another role", "action_forbidden");
      if (!ACTIVE_RESERVATION_STATUSES.has(reservation.status) && reservation.status !== "interrupted") throw new LabWorkflowError("Master reservation is not active", "stage_violation");
      reservation.status = "released";
      reservation.updatedAt = now;
      const workPackage = findPackage(workflow, reservation.workPackageId);
      if (workPackage.status === "master_requested") {
        workPackage.status = "pre_master_judgment";
        delete workPackage.masterRequestId;
        workPackage.updatedAt = now;
      }
      break;
    }
    case "submit_master_analysis": {
      const reservation = findReservation(workflow, action.masterRequestId);
      requireMember(actor, [reservation.masterRole]);
      if (!new Set<MasterReservationStatus>(["requested", "running"]).has(reservation.status)) throw new LabWorkflowError("Master reservation is not accepting a submission", "stage_violation");
      requireMeetingRefs(workflow.meetingId, action.submission.artifactRefs);
      reservation.analysis = action.submission;
      reservation.status = "submitted";
      reservation.updatedAt = now;
      const workPackage = findPackage(workflow, reservation.workPackageId);
      workPackage.status = "master_submitted";
      workPackage.updatedAt = now;
      await notifyRole(reservation.doctorRole, "master_analysis_submitted", { masterRequestId: reservation.requestId, workPackageId: reservation.workPackageId, masterRole: reservation.masterRole });
      break;
    }
    case "submit_doctor_synthesis": {
      const workPackage = findPackage(workflow, action.workPackageId);
      requireDoctorOwner(actor, workPackage);
      if (!new Set<WorkPackageStatus>(["master_submitted", "revision_requested"]).has(workPackage.status) || !workPackage.preMasterJudgment || !workPackage.masterRequestId) throw new LabWorkflowError("Master analysis is required before synthesis", "stage_violation");
      const reservation = findReservation(workflow, workPackage.masterRequestId);
      if (!reservation.analysis || !action.synthesis.masterInterpretations.includes(reservation.analysis.interpretation)) {
        throw new LabWorkflowError("Synthesis must include the submitted master interpretation", "stage_violation");
      }
      requireAcceptedEvidence(workflow, workPackage, action.synthesis.evidenceRefs);
      requireMeetingRefs(workflow.meetingId, action.synthesis.evidenceRefs);
      if (action.synthesis.ownReasoning !== workPackage.preMasterJudgment.judgment) throw new LabWorkflowError("Synthesis must preserve the pre-master judgment verbatim", "stage_violation");
      if (action.synthesis.hypotheses.length === 0 || action.synthesis.proposedMethods.length === 0) throw new LabWorkflowError("Doctor synthesis requires hypotheses and proposed methods", "stage_violation");
      if (workPackage.mode === "robust" && (action.synthesis.counterEvidence.length === 0 || action.synthesis.sensitivityChecks.length === 0 || action.synthesis.uncertainties.length === 0)) {
        throw new LabWorkflowError("Robust synthesis requires counter-evidence, sensitivity checks, and uncertainties", "stage_violation");
      }
      workPackage.synthesis = action.synthesis;
      workPackage.status = "pi_review";
      workPackage.updatedAt = now;
      findReservation(workflow, workPackage.masterRequestId).status = "released";
      workflow.status = workflow.workPackages.every((candidate) => candidate.status === "pi_review" || candidate.status === "accepted") ? "pi_review" : workflow.status;
      await notifyRole("pi", "doctor_synthesis_submitted", { workPackageId: workPackage.workPackageId, doctorRole: workPackage.doctorRole, mode: workPackage.mode });
      break;
    }
    case "review_doctor_synthesis": {
      requireMember(actor, ["pi"]);
      const workPackage = findPackage(workflow, action.workPackageId);
      if (workPackage.status !== "pi_review") throw new LabWorkflowError("Work package is not awaiting PI review", "stage_violation");
      if (!workPackage.synthesis?.evidenceRefs.length) throw new LabWorkflowError("Doctor synthesis has no evidence refs", "stage_violation");
      workPackage.status = action.decision;
      workPackage.updatedAt = now;
      workflow.status = action.decision === "accepted"
        ? (workflow.workPackages.length === 2 && workflow.workPackages.every((candidate) => candidate.status === "accepted") ? "pi_review" : workflow.status)
        : "running";
      if (action.decision === "revision_requested") {
        await notifyRole(workPackage.doctorRole, "doctor_revision_requested", { workPackageId: workPackage.workPackageId, mode: workPackage.mode });
      }
      break;
    }
    case "cancel_task": {
      requireMember(actor, ["pi", "phd-1", "phd-2", "master-1", "master-2"]);
      const task = findTask(workflow, action.taskId);
      if (actor.role !== "pi" && actor.sessionId !== task.requesterSessionId) throw new LabWorkflowError("Only the requester or PI can cancel this task", "action_forbidden");
      if (new Set<UndergradTaskStatus>(["accepted", "cancelled"]).has(task.status)) throw new LabWorkflowError("Task cannot be cancelled", "stage_violation");
      const activeSessions: string[] = [];
      for (const thread of workflow.undergradThreads.filter((candidate) => candidate.parentTaskId === task.taskId && ACTIVE_THREAD_STATUSES.has(candidate.status))) {
        thread.status = "cancelled";
        thread.updatedAt = now;
        if (thread.sessionId) activeSessions.push(thread.sessionId);
      }
      task.status = "cancelled";
      task.updatedAt = now;
      await persist();
      const abortSession = options.abortSession ?? defaultAbortSession;
      await Promise.all(activeSessions.map((sessionId) => abortSession(sessionId).catch(() => {})));
      break;
    }
    case "complete_meeting": {
      requireMember(actor, ["pi"]);
      if (workflow.status !== "pi_review" || workflow.finalReport || workflow.finalReportArtifact) throw new LabWorkflowError("Completed meeting reports are immutable", "stage_violation");
      if (workflow.workPackages.length !== 2 || workflow.workPackages.some((workPackage) => workPackage.status !== "accepted")) throw new LabWorkflowError("Both doctor work packages must be accepted", "stage_violation");
      requireMeetingRefs(workflow.meetingId, action.report.evidenceRefs);
      for (const workPackage of workflow.workPackages) {
        if (!action.report.evidenceRefs.includes(`doctor-synthesis:${workPackage.workPackageId}`)) {
          throw new LabWorkflowError("Final report must cite both accepted doctor syntheses", "stage_violation");
        }
      }
      for (const reference of action.report.evidenceRefs) {
        if (!reference.startsWith("undergrad-task:")) continue;
        const task = workflow.undergradTasks.find((candidate) => `undergrad-task:${candidate.taskId}` === reference);
        if (!task || task.status !== "accepted") throw new LabWorkflowError("Final report cites an unaccepted undergraduate task", "stage_violation");
      }
      workflow.finalReportArtifact = await writeFinalReportArtifact(workflow.cwd, workflow.meetingId, action.report, now);
      workflow.finalReport = action.report;
      workflow.status = "completed";
      break;
    }
    case "cancel_meeting": {
      requireMember(actor, ["pi"]);
      const activeSessions: string[] = [];
      for (const task of workflow.undergradTasks) {
        if (!new Set<UndergradTaskStatus>(["accepted", "cancelled", "failed"]).has(task.status)) {
          task.status = "cancelled";
          task.updatedAt = now;
        }
      }
      for (const thread of workflow.undergradThreads) {
        if (ACTIVE_THREAD_STATUSES.has(thread.status)) {
          thread.status = "cancelled";
          thread.updatedAt = now;
          if (thread.sessionId) activeSessions.push(thread.sessionId);
        }
      }
      for (const reservation of workflow.masterReservations) {
        if (ACTIVE_RESERVATION_STATUSES.has(reservation.status)) {
          reservation.status = "cancelled";
          reservation.updatedAt = now;
        }
      }
      workflow.status = "cancelled";
      await persist();
      const abortSession = options.abortSession ?? defaultAbortSession;
      await Promise.all(activeSessions.map((sessionId) => abortSession(sessionId).catch(() => {})));
      break;
    }
  }
  workflow.updatedAt = nowValue(options);
}

async function prepareLockedWorkflow(cwd: string, meetingId: string, options: LabWorkflowOptions): Promise<{ meeting: GroupMeeting; workflow: LabWorkflow; agentDir: string; path: string }> {
  const agentDir = options.agentDir ?? getAgentDir();
  const meeting = await resolveMeeting(cwd, meetingId, options);
  const path = workflowPath(meeting.cwd, meeting.meetingId, agentDir);
  const now = nowValue(options);
  const { workflow, created } = await loadWorkflow(path, meeting, options.runtimeId ?? DEFAULT_RUNTIME_ID, now);
  const recovered = !created && markRestartedWorkInterrupted(workflow, options.runtimeId ?? DEFAULT_RUNTIME_ID, now);
  if (created || recovered) await writeWorkflow(workflow, agentDir);
  return { meeting, workflow, agentDir, path };
}

function parseStoredWorkflow(contents: string): LabWorkflow {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new LabWorkflowError("Invalid lab workflow JSON", "invalid_workflow");
  }
  if (
    !isObject(value)
    || value.version !== WORKFLOW_VERSION
    || typeof value.meetingId !== "string"
    || typeof value.cwd !== "string"
    || !Array.isArray(value.undergradTasks)
    || !Array.isArray(value.undergradThreads)
  ) {
    throw new LabWorkflowError("Invalid lab workflow metadata", "invalid_workflow");
  }
  return value as unknown as LabWorkflow;
}

async function storedWorkflowsIn(directory: string): Promise<LabWorkflow[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".workflow.json"))
    .map(async (entry) => parseStoredWorkflow(await readFile(join(directory, entry.name), "utf8"))));
}

export interface LabScienceDatabaseAuthorizationInput {
  cwd: string;
  sessionId: string;
  undergradTaskId?: string;
  database: string;
  operation: "search" | "fetch";
}

function authorizeUndergraduateTaskDatabase(
  workflow: LabWorkflow,
  input: LabScienceDatabaseAuthorizationInput,
  child?: UndergradThread,
): void {
  if (!input.undergradTaskId) {
    throw new LabWorkflowError("undergradTaskId is required for meeting literature access", "undergrad_task_required");
  }
  const task = workflow.undergradTasks.find((candidate) => candidate.taskId === input.undergradTaskId);
  if (!task || (child && child.parentTaskId !== task.taskId)) {
    throw new LabWorkflowError("The structured task does not belong to this undergraduate session", "undergrad_task_forbidden");
  }
  if (task.status !== "running") {
    throw new LabWorkflowError("The structured task is not running", "undergrad_task_inactive");
  }
  const databaseScope = Array.isArray(task.databaseScope)
    ? ["pubmed", "crossref", ...(task.databaseScope.includes("arxiv") ? ["arxiv"] : [])]
    : DEFAULT_LITERATURE_DATABASE_SCOPE;
  if (!databaseScope.includes(input.database)) {
    throw new LabWorkflowError(`Database ${input.database} is outside this literature task scope`, "science_database_forbidden");
  }
}

export async function authorizeUndergraduateScienceDatabase(
  input: LabScienceDatabaseAuthorizationInput,
  options: LabWorkflowOptions = {},
): Promise<void> {
  const agentDir = options.agentDir ?? getAgentDir();
  const workflows = await storedWorkflowsIn(workflowDirectory(input.cwd, agentDir));
  for (const workflow of workflows) {
    if (resolve(workflow.cwd) !== resolve(input.cwd)) continue;
    const child = workflow.undergradThreads.find((candidate) => candidate.sessionId === input.sessionId);
    if (child) {
      authorizeUndergraduateTaskDatabase(workflow, input, child);
      return;
    }
    const meeting = await (options.readMeeting ?? (async (cwd, meetingId, requestedAgentDir) => (
      (await import("./group-meeting-server")).readGroupMeeting(cwd, meetingId, requestedAgentDir)
    )))(input.cwd, workflow.meetingId, agentDir);
    if (!meeting) continue;
    const member = meeting.members.find((candidate) => candidate.sessionId === input.sessionId);
    if (!member) continue;
    if (member.role !== "undergraduate") {
      if (input.operation === "fetch" && new Set<GroupMeetingRole>(["phd-1", "phd-2", "master-1", "master-2"]).has(member.role)) return;
      throw new LabWorkflowError("This meeting role cannot search literature", "science_database_forbidden");
    }
    authorizeUndergraduateTaskDatabase(workflow, input);
    return;
  }
}

export async function resolveLabWorkflowChildSessionPolicy(sessionId: string, agentDir = getAgentDir()): Promise<{
  meetingId: string;
  role: "undergraduate";
  toolNames: string[];
  systemPrompt: string;
} | null> {
  let projectDirectories;
  try {
    projectDirectories = await readdir(join(agentDir, "meetings"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const projectDirectory of projectDirectories) {
    if (!projectDirectory.isDirectory()) continue;
    for (const workflow of await storedWorkflowsIn(join(agentDir, "meetings", projectDirectory.name))) {
      if (workflow.undergradThreads.some((thread) => thread.sessionId === sessionId)) {
        return {
          meetingId: workflow.meetingId,
          role: "undergraduate",
          toolNames: getUndergraduateChildToolNames(),
          systemPrompt: getUndergraduateChildSystemPrompt(),
        };
      }
    }
  }
  return null;
}

export async function readLabWorkflow(input: ReadLabWorkflowInput, options: LabWorkflowOptions = {}): Promise<LabWorkflow> {
  const agentDir = options.agentDir ?? getAgentDir();
  return withMeetingLock(input.cwd, input.meetingId, agentDir, async () => {
    const { meeting, workflow } = await prepareLockedWorkflow(input.cwd, input.meetingId, options);
    const actor = resolveActor(meeting, workflow, input.actorSessionId);
    return visibleWorkflow(workflow, actor);
  });
}

export async function orchestrateLabWorkflow(input: OrchestrateLabWorkflowInput, options: LabWorkflowOptions = {}): Promise<LabWorkflow> {
  const action = parseLabOrchestrateAction(input.action);
  if (action.action === "get_state") return readLabWorkflow(input, options);
  const agentDir = options.agentDir ?? getAgentDir();
  return withMeetingLock(input.cwd, input.meetingId, agentDir, async () => {
    const { meeting, workflow } = await prepareLockedWorkflow(input.cwd, input.meetingId, options);
    const actor = resolveActor(meeting, workflow, input.actorSessionId);
    const fingerprint = actionFingerprint(action);
    const existing = workflow.idempotency[action.requestId];
    if (existing) {
      if (existing.status === "interrupted") throw new LabWorkflowError("Action was interrupted; retry with a new requestId", "operation_interrupted");
      if (existing.fingerprint !== fingerprint) throw new LabWorkflowError("requestId was already used for another action", "idempotency_conflict");
      if (existing.status === "pending") throw new LabWorkflowError("Action is already in progress", "operation_in_progress");
      return visibleWorkflow(workflow, actor);
    }
    workflow.idempotency[action.requestId] = { fingerprint, status: "pending", updatedAt: nowValue(options) };
    await writeWorkflow(workflow, agentDir);
    try {
      await applyAction(workflow, meeting, actor, action, options, () => writeWorkflow(workflow, agentDir));
      workflow.idempotency[action.requestId] = { fingerprint, status: "complete", updatedAt: nowValue(options) };
      await writeWorkflow(workflow, agentDir);
      return visibleWorkflow(workflow, actor);
    } catch (error) {
      delete workflow.idempotency[action.requestId];
      await writeWorkflow(workflow, agentDir);
      throw error;
    }
  });
}

export async function recoverInterruptedLabWorkflow(cwd: string, meetingId: string, options: LabWorkflowOptions = {}): Promise<LabWorkflow> {
  const agentDir = options.agentDir ?? getAgentDir();
  return withMeetingLock(cwd, meetingId, agentDir, async () => {
    const { workflow } = await prepareLockedWorkflow(cwd, meetingId, options);
    return structuredClone(workflow);
  });
}

export async function resolveLabMeetingIdForSession(cwd: string, sessionId: string, agentDir: string): Promise<string> {
  const { listGroupMeetings } = await import("./group-meeting-server");
  const meetingIds = new Set(
    (await listGroupMeetings(cwd, agentDir))
      .filter((meeting) => meeting.members.some((member) => member.sessionId === sessionId))
      .map((meeting) => meeting.meetingId),
  );
  for (const workflow of await storedWorkflowsIn(workflowDirectory(cwd, agentDir))) {
    if (workflow.undergradThreads.some((thread) => thread.sessionId === sessionId)) {
      meetingIds.add(workflow.meetingId);
    }
  }
  if (meetingIds.size !== 1) {
    throw new LabWorkflowError(
      meetingIds.size ? "Session belongs to multiple meetings" : "Session does not belong to this meeting project",
      meetingIds.size ? "ambiguous_meeting_session" : "meeting_session_not_found",
    );
  }
  return meetingIds.values().next().value!;
}

/** Bind the model-visible lab tools to the canonical Web workflow service. */
export function bindLabWorkflowRuntime(): void {
  configureLabMessageRuntime(async ({ cwd, actorSessionId, action, payload }) => {
    const fields = objectValue(payload, "payload");
    if ("action" in fields) throw new LabWorkflowError("payload.action is not allowed", "invalid_action");
    return orchestrateLabWorkflow({
      cwd,
      meetingId: await resolveLabMeetingIdForSession(cwd, actorSessionId, getAgentDir()),
      actorSessionId,
      action: { action, ...fields },
    });
  }, authorizeUndergraduateScienceDatabase);
}
