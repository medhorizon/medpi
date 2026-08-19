import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  authorizeUndergraduateScienceDatabase,
  LabWorkflowError,
  orchestrateLabWorkflow,
  parseLabOrchestrateAction,
  readLabWorkflow,
  resolveLabWorkflowChildSessionPolicy,
} = await jiti.import("./lab-workflow.ts");

const roles = ["pi", "phd-1", "phd-2", "master-1", "master-2", "undergraduate"];

async function setup({ deliverTask, deliverMasterTask, deliverNotice, createChildSession, abortSession } = {}) {
  const root = await mkdtemp(join(tmpdir(), "medpi-lab-workflow-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  const meeting = {
    meetingId: randomUUID(),
    cwd: resolve(cwd),
    projectRoot: resolve(cwd),
    createdAt: new Date().toISOString(),
    status: "ready",
    members: roles.map((role) => ({
      role,
      label: role,
      sessionId: `session-${role}`,
      provider: "test",
      modelId: "test-model",
      thinkingLevel: "high",
      status: "ready",
    })),
  };
  let childSequence = 0;
  const options = {
    agentDir,
    runtimeId: "runtime-a",
    readMeeting: async (requestedCwd, meetingId) => (
      resolve(requestedCwd) === meeting.cwd && meetingId === meeting.meetingId ? meeting : null
    ),
    deliverTask: deliverTask ?? (async () => {}),
    deliverMasterTask: deliverMasterTask ?? (async () => {}),
    deliverNotice: deliverNotice ?? (async () => {}),
    createChildSession: createChildSession ?? (async () => ({ sessionId: `child-${++childSequence}` })),
    abortSession: abortSession ?? (async () => {}),
  };
  const call = (role, action, overrideOptions = {}) => orchestrateLabWorkflow({
    cwd: meeting.cwd,
    meetingId: meeting.meetingId,
    actorSessionId: role.startsWith("child-") ? role : `session-${role}`,
    action,
  }, { ...options, ...overrideOptions });
  return { root, cwd: meeting.cwd, agentDir, meeting, options, call };
}

function finalReport(workPackages, tasks) {
  return {
    title: "Final academic report",
    executiveSummary: "Integrated assessment of the accepted creative and robust routes.",
    creativeRoute: "Creative synthesis and its falsifiable mechanism.",
    robustRoute: "Robust synthesis and its conservative boundary.",
    conflictsAndLimitations: ["Evidence remains limited."],
    conclusions: ["The accepted evidence supports a bounded conclusion."],
    hypotheses: ["A falsifiable follow-up hypothesis."],
    proposedMethods: ["Run a preregistered validation experiment."],
    evidenceRefs: [
      ...workPackages.map((entry) => `doctor-synthesis:${entry.workPackageId}`),
      ...tasks.map((entry) => `undergrad-task:${entry.taskId}`),
    ],
    openQuestions: ["Will the result replicate in an independent cohort?"],
  };
}

function question(requestId = "ask-1") {
  return {
    action: "ask_clarification",
    requestId,
    card: {
      questionId: "scope",
      question: "Which disease scope should be used?",
      options: [{ id: "narrow", label: "Narrow" }, { id: "broad", label: "Broad" }],
      allowOther: true,
      required: true,
    },
  };
}

test("accepts a typed multi-question clarification card", () => {
  const action = parseLabOrchestrateAction({
    action: "ask_clarification",
    requestId: "clarify-1",
    card: {
      title: "Financing scope",
      description: "Confirm the assumptions before research starts.",
      questions: [
        { id: "jurisdiction", prompt: "Which market?", type: "single_select", options: [{ id: "cn", label: "China" }, { id: "us", label: "United States" }] },
        { id: "deliverables", prompt: "Which deliverables?", type: "multiple_select", options: [{ id: "memo", label: "Memo" }, { id: "deck", label: "Deck" }] },
      ],
      submitLabel: "Confirm",
    },
  });
  assert.equal(action.action, "ask_clarification");
  assert.deepEqual(action.cards.map(({ questionId, selectionMode }) => ({ questionId, selectionMode })), [
    { questionId: "jurisdiction", selectionMode: "single" },
    { questionId: "deliverables", selectionMode: "multiple" },
  ]);
  assert.equal(action.cards[0].title, "Financing scope");
  assert.equal(action.cards[1].title, undefined);
});

const brief = {
  title: "Test brief",
  objective: "Evaluate the biomedical question",
  scope: "Selected disease scope",
  constraints: ["Use verifiable literature"],
};

async function clarifyAndDispatch(context) {
  await context.call("pi", question());
  await context.call("pi", {
    action: "submit_clarification",
    requestId: "answer-1",
    questionId: "scope",
    selectedOptionIds: ["narrow"],
  });
  await context.call("pi", { action: "dispatch_doctor", requestId: "dispatch-1", doctorRole: "phd-1", brief });
  return context.call("pi", { action: "dispatch_doctor", requestId: "dispatch-2", doctorRole: "phd-2", brief });
}

function delegateAction(workPackageId, prefix, maxThreads = 1, databaseScope) {
  return {
    action: "delegate_undergrad",
    requestId: `${prefix}-delegate`,
    workPackageId,
    purpose: "scientific_retrieval",
    workType: "literature_search",
    ...(databaseScope ? { databaseScope } : {}),
    title: `${prefix} literature retrieval`,
    objective: "Find valid literature records",
    instructions: ["Search PubMed and validate identifiers"],
    inputRefs: [],
    acceptanceCriteria: ["Every record has DOI, PMID, or URL"],
    maxThreads,
  };
}

test("enforces undergraduate literature database scope from the real session and structured task", async () => {
  const context = await setup();
  let workflow = await clarifyAndDispatch(context);
  const workPackage = workflow.workPackages.find((entry) => entry.doctorRole === "phd-1");
  workflow = await context.call("phd-1", delegateAction(workPackage.workPackageId, "default-scope"));
  const defaultTask = workflow.undergradTasks.at(-1);
  assert.deepEqual(defaultTask.databaseScope, ["pubmed", "crossref"]);

  const authorize = (sessionId, taskId, database) => authorizeUndergraduateScienceDatabase({
    cwd: context.cwd,
    sessionId,
    undergradTaskId: taskId,
    database,
    operation: "search",
  }, context.options);
  await authorize("session-undergraduate", defaultTask.taskId, "pubmed");
  await authorize("session-undergraduate", defaultTask.taskId, "crossref");
  await assert.rejects(
    () => authorize("session-undergraduate", defaultTask.taskId, "arxiv"),
    (error) => error instanceof LabWorkflowError && error.code === "science_database_forbidden",
  );
  for (const database of ["pubchem", "ensembl", "uniprot", "reactome", "geo"]) {
    await assert.rejects(
      () => authorize("session-undergraduate", defaultTask.taskId, database),
      (error) => error instanceof LabWorkflowError && error.code === "science_database_forbidden",
    );
  }
  await assert.rejects(
    () => authorizeUndergraduateScienceDatabase({ cwd: context.cwd, sessionId: "session-undergraduate", database: "pubmed", operation: "search" }, context.options),
    (error) => error instanceof LabWorkflowError && error.code === "undergrad_task_required",
  );
  await assert.rejects(
    () => context.call("phd-1", delegateAction(workPackage.workPackageId, "forged-scope", 1, ["pubmed", "crossref", "geo"])),
    (error) => error instanceof LabWorkflowError && error.code === "invalid_action",
  );

  workflow = await context.call("undergraduate", {
    action: "spawn_undergrad_threads",
    requestId: "scope-spawn",
    taskId: defaultTask.taskId,
    threads: [threadSpec("scope")],
  });
  const child = workflow.undergradThreads.find((entry) => entry.parentTaskId === defaultTask.taskId);
  const childPolicy = await resolveLabWorkflowChildSessionPolicy(child.sessionId, context.agentDir);
  assert.deepEqual(childPolicy?.toolNames, ["science_search", "science_fetch", "lab_orchestrate"]);

  workflow = await context.call("phd-1", delegateAction(workPackage.workPackageId, "preprint-scope", 1, ["pubmed", "crossref", "arxiv"]));
  const preprintTask = workflow.undergradTasks.at(-1);
  await authorize("session-undergraduate", preprintTask.taskId, "arxiv");
  await assert.rejects(
    () => authorize(child.sessionId, preprintTask.taskId, "arxiv"),
    (error) => error instanceof LabWorkflowError && error.code === "undergrad_task_forbidden",
  );
  await assert.rejects(
    () => authorizeUndergraduateScienceDatabase({
      cwd: context.cwd,
      sessionId: child.sessionId,
      undergradTaskId: defaultTask.taskId,
      database: "arxiv",
      operation: "search",
    }, { ...context.options, readMeeting: async () => null }),
    (error) => error instanceof LabWorkflowError && error.code === "science_database_forbidden",
  );

  for (const sessionId of ["session-phd-1", "session-phd-2", "session-master-1", "session-master-2"]) {
    await authorizeUndergraduateScienceDatabase({
      cwd: context.cwd,
      sessionId,
      database: "pubmed",
      operation: "fetch",
    }, context.options);
  }
  await assert.rejects(
    () => authorizeUndergraduateScienceDatabase({
      cwd: context.cwd,
      sessionId: "session-phd-1",
      database: "pubmed",
      operation: "search",
    }, context.options),
    (error) => error instanceof LabWorkflowError && error.code === "science_database_forbidden",
  );

  await authorizeUndergraduateScienceDatabase({
    cwd: context.cwd,
    sessionId: "ordinary-science-session",
    database: "geo",
    operation: "search",
  }, context.options);
});

function threadSpec(prefix) {
  return {
    title: `${prefix} thread`,
    objective: "Retrieve records",
    inputRefs: [],
    acceptanceCriteria: ["Return bibliographic metadata only"],
  };
}

function literatureResult(title = "A valid paper") {
  return {
    summary: "Retrieved one record",
    records: [{
      title,
      authors: ["A. Researcher"],
      year: 2025,
      doi: "10.1000/test",
      source: "PubMed",
      retrievedAt: "2026-08-19T00:00:00.000Z",
      quoteOrMetadata: "Bibliographic metadata",
    }],
    artifactRefs: [],
    limitations: [],
  };
}

async function acceptRetrieval(context, doctorRole, workPackageId, prefix, revisionFirst = false) {
  let workflow = await context.call(doctorRole, delegateAction(workPackageId, prefix));
  const task = workflow.undergradTasks.find((candidate) => candidate.requesterRole === doctorRole && candidate.doctorWorkPackageId === workPackageId);
  workflow = await context.call("undergraduate", {
    action: "spawn_undergrad_threads",
    requestId: `${prefix}-spawn`,
    taskId: task.taskId,
    threads: [threadSpec(prefix)],
  });
  const thread = workflow.undergradThreads.find((candidate) => candidate.parentTaskId === task.taskId);
  await context.call(thread.sessionId, {
    action: "submit_undergrad_thread",
    requestId: `${prefix}-thread-submit`,
    taskId: task.taskId,
    threadId: thread.threadId,
    result: literatureResult(`${prefix} paper`),
  });
  await context.call("undergraduate", {
    action: "submit_undergrad_records",
    requestId: `${prefix}-parent-submit`,
    taskId: task.taskId,
    result: { ...literatureResult(`${prefix} paper`), threadIds: [thread.threadId] },
  });
  if (revisionFirst) {
    await context.call(doctorRole, {
      action: "review_undergrad_records",
      requestId: `${prefix}-revise`,
      taskId: task.taskId,
      decision: "revision_requested",
    });
    await context.call("undergraduate", {
      action: "submit_undergrad_records",
      requestId: `${prefix}-parent-resubmit`,
      taskId: task.taskId,
      result: { ...literatureResult(`${prefix} revised paper`), threadIds: [thread.threadId] },
    });
  }
  await context.call(doctorRole, {
    action: "review_undergrad_records",
    requestId: `${prefix}-accept`,
    taskId: task.taskId,
    decision: "accepted",
  });
  await context.call(doctorRole, {
    action: "submit_pre_master_judgment",
    requestId: `${prefix}-judgment`,
    workPackageId,
    judgment: `${prefix} independent judgment`,
    evidenceRefs: [`undergrad-task:${task.taskId}`],
  });
  return task;
}

test("lazily initializes one canonical workflow and enforces the PI clarification gate and real session identity", async () => {
  const context = await setup();
  const initial = await readLabWorkflow({
    cwd: context.cwd,
    meetingId: context.meeting.meetingId,
    actorSessionId: "session-pi",
  }, context.options);
  assert.equal(initial.status, "clarifying");
  await assert.rejects(
    () => readLabWorkflow({ cwd: context.cwd, meetingId: context.meeting.meetingId, actorSessionId: "session-outsider" }, context.options),
    (error) => error instanceof LabWorkflowError && error.code === "actor_forbidden",
  );
  await assert.rejects(
    () => context.call("pi", { action: "dispatch_doctor", requestId: "too-early", doctorRole: "phd-1", brief }),
    (error) => error instanceof LabWorkflowError && error.code === "clarification_required",
  );
  await context.call("pi", question());
  await assert.rejects(
    () => context.call("pi", { action: "submit_clarification", requestId: "bad-answer", questionId: "scope", selectedOptionIds: ["forged"] }),
    (error) => error instanceof LabWorkflowError && error.code === "invalid_action",
  );
  const answered = await context.call("pi", { action: "submit_clarification", requestId: "answer", questionId: "scope", selectedOptionIds: ["narrow"] });
  assert.equal(answered.status, "brief_ready");
  const duplicate = await context.call("pi", { action: "submit_clarification", requestId: "answer", questionId: "scope", selectedOptionIds: ["narrow"] });
  assert.equal(duplicate.clarificationResponses.length, 1);
  await context.call("pi", { action: "dispatch_doctor", requestId: "doctor-1", doctorRole: "phd-1", brief });
  const dispatched = await context.call("pi", { action: "dispatch_doctor", requestId: "doctor-2", doctorRole: "phd-2", brief });
  assert.deepEqual(dispatched.workPackages.map(({ doctorRole, mode }) => ({ doctorRole, mode })), [
    { doctorRole: "phd-1", mode: "creative" },
    { doctorRole: "phd-2", mode: "robust" },
  ]);
  const doctorView = await context.call("phd-1", { action: "get_state" });
  assert.deepEqual(doctorView.workPackages.map((entry) => entry.doctorRole), ["phd-1"]);
  assert.deepEqual(doctorView.idempotency, {});
});

test("persists workflow progress and a diagnostic when a wake-up notice fails", async () => {
  const context = await setup({ deliverNotice: async () => { throw new Error("recipient offline"); } });
  await context.call("pi", question("notice-failure-question"));
  const workflow = await context.call("pi", {
    action: "submit_clarification",
    requestId: "notice-failure-answer",
    questionId: "scope",
    selectedOptionIds: ["narrow"],
  });
  assert.equal(workflow.status, "brief_ready");
  const notice = workflow.notices.find((entry) => entry.event === "clarification_submitted");
  assert.equal(notice.status, "failed");
  assert.match(notice.error, /recipient offline/);
});

test("delivers structured undergraduate tasks, enforces records-only results, capacity, and no grandchildren", async () => {
  const delivered = [];
  const context = await setup({ deliverTask: async ({ task }) => delivered.push(task.taskId) });
  let workflow = await clarifyAndDispatch(context);
  const phd1 = workflow.workPackages.find((entry) => entry.doctorRole === "phd-1");
  const phd2 = workflow.workPackages.find((entry) => entry.doctorRole === "phd-2");
  await assert.rejects(
    () => context.call("phd-1", { ...delegateAction(phd1.workPackageId, "cross-meeting", 1), inputRefs: [`artifact://meetings/${randomUUID()}/foreign.csv`] }),
    (error) => error instanceof LabWorkflowError && error.code === "cross_meeting_ref",
  );
  workflow = await context.call("phd-1", delegateAction(phd1.workPackageId, "d1-a", 3));
  const task1 = workflow.undergradTasks.at(-1);
  assert.equal(task1.status, "running");
  assert.deepEqual(delivered, [task1.taskId]);
  workflow = await context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "spawn-a", taskId: task1.taskId, threads: [threadSpec("a"), threadSpec("b"), threadSpec("c")] });
  const child = workflow.undergradThreads.find((thread) => thread.parentTaskId === task1.taskId);
  await assert.rejects(
    () => context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "parent-fourth", taskId: task1.taskId, threads: [threadSpec("d")] }),
    (error) => error instanceof LabWorkflowError && error.code === "undergrad_capacity_exceeded",
  );
  await assert.rejects(
    () => context.call(child.sessionId, { action: "spawn_undergrad_threads", requestId: "grandchild", taskId: task1.taskId, threads: [threadSpec("nested")] }),
    (error) => error instanceof LabWorkflowError && error.code === "action_forbidden",
  );
  await assert.rejects(
    () => context.call(child.sessionId, { action: "submit_undergrad_thread", requestId: "interpret", taskId: task1.taskId, threadId: child.threadId, result: { ...literatureResult(), interpretation: "not allowed" } }),
    (error) => error instanceof LabWorkflowError && error.code === "invalid_action",
  );

  workflow = await context.call("phd-1", delegateAction(phd1.workPackageId, "d1-b", 3));
  const task2 = workflow.undergradTasks.at(-1);
  await context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "spawn-b", taskId: task2.taskId, threads: [threadSpec("d"), threadSpec("e"), threadSpec("f")] });
  workflow = await context.call("phd-2", delegateAction(phd2.workPackageId, "d2-a", 1));
  const task3 = workflow.undergradTasks.at(-1);
  await assert.rejects(
    () => context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "global-seventh", taskId: task3.taskId, threads: [threadSpec("g")] }),
    (error) => error instanceof LabWorkflowError && error.code === "undergrad_capacity_exceeded",
  );
});

test("runs both doctor modes through accepted evidence, atomic master reservations, PI review, and completion", async () => {
  const deliveredNotices = [];
  const context = await setup({ deliverNotice: async ({ notice }) => deliveredNotices.push({ event: notice.event, toRole: notice.toRole }) });
  let workflow = await clarifyAndDispatch(context);
  const phd1 = workflow.workPackages.find((entry) => entry.doctorRole === "phd-1");
  const phd2 = workflow.workPackages.find((entry) => entry.doctorRole === "phd-2");
  const task1 = await acceptRetrieval(context, "phd-1", phd1.workPackageId, "creative", true);
  const task2 = await acceptRetrieval(context, "phd-2", phd2.workPackageId, "robust");

  const claims = await Promise.allSettled([
    context.call("phd-1", { action: "claim_master", requestId: "claim-creative", workPackageId: phd1.workPackageId, preferredMasterRole: "master-1", inputRefs: [`undergrad-task:${task1.taskId}`], expectedOutput: "Interpret the evidence" }),
    context.call("phd-2", { action: "claim_master", requestId: "claim-robust", workPackageId: phd2.workPackageId, preferredMasterRole: "master-1", inputRefs: [`undergrad-task:${task2.taskId}`], expectedOutput: "Stress-test the evidence" }),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(claims.filter((result) => result.status === "rejected").length, 1);

  workflow = await context.call("pi", { action: "get_state" });
  const firstReservation = workflow.masterReservations[0];
  const firstPackage = workflow.workPackages.find((entry) => entry.workPackageId === firstReservation.workPackageId);
  const firstTask = firstPackage.doctorRole === "phd-1" ? task1 : task2;
  await context.call(firstReservation.masterRole, {
    action: "submit_master_analysis",
    requestId: "analysis-first",
    masterRequestId: firstReservation.requestId,
    submission: { analysis: "Analysis", interpretation: "Interpretation", assumptions: [], methodsUsed: ["Sensitivity analysis"], uncertainty: ["Limited sources"], artifactRefs: [] },
  });
  const firstCreative = firstPackage.mode === "creative";
  const firstSynthesis = {
    ownReasoning: `${firstPackage.mode} independent judgment`,
    masterInterpretations: ["Interpretation"],
    evidenceRefs: [`undergrad-task:${firstTask.taskId}`],
    conclusion: "Evidence-based conclusion",
    hypotheses: [firstCreative ? "Falsifiable creative hypothesis" : "Falsifiable robust hypothesis"],
    proposedMethods: [firstCreative ? "Validation experiment" : "Preregistered replication"],
    counterEvidence: ["A plausible counterexample"],
    sensitivityChecks: ["Leave-one-source-out sensitivity check"],
    uncertainties: ["Residual uncertainty"],
    limitations: ["Limited sources"],
    unansweredQuestions: [],
  };
  if (!firstCreative) {
    await assert.rejects(
      () => context.call(firstPackage.doctorRole, {
        action: "submit_doctor_synthesis",
        requestId: "robust-missing-checks-first",
        workPackageId: firstPackage.workPackageId,
        synthesis: { ...firstSynthesis, counterEvidence: [] },
      }),
      (error) => error instanceof LabWorkflowError && error.code === "stage_violation",
    );
  }
  await assert.rejects(
    () => context.call(firstPackage.doctorRole, {
      action: "submit_doctor_synthesis",
      requestId: "forged-master-interpretation",
      workPackageId: firstPackage.workPackageId,
      synthesis: { ...firstSynthesis, masterInterpretations: ["Forged interpretation"] },
    }),
    (error) => error instanceof LabWorkflowError && error.code === "stage_violation",
  );
  await context.call(firstPackage.doctorRole, {
    action: "submit_doctor_synthesis",
    requestId: "synthesis-first",
    workPackageId: firstPackage.workPackageId,
    synthesis: firstSynthesis,
  });
  await context.call("pi", { action: "review_doctor_synthesis", requestId: "review-first-revision", workPackageId: firstPackage.workPackageId, decision: "revision_requested" });
  await context.call(firstPackage.doctorRole, { action: "submit_doctor_synthesis", requestId: "synthesis-first-revised", workPackageId: firstPackage.workPackageId, synthesis: firstSynthesis });
  await context.call("pi", { action: "review_doctor_synthesis", requestId: "review-first", workPackageId: firstPackage.workPackageId, decision: "accepted" });

  const secondPackage = firstPackage.doctorRole === "phd-1" ? phd2 : phd1;
  const secondTask = secondPackage.doctorRole === "phd-1" ? task1 : task2;
  workflow = await context.call(secondPackage.doctorRole, { action: "claim_master", requestId: "claim-second", workPackageId: secondPackage.workPackageId, preferredMasterRole: "master-2", inputRefs: [`undergrad-task:${secondTask.taskId}`], expectedOutput: "Analyze the evidence" });
  const secondReservation = workflow.masterReservations.find((entry) => entry.workPackageId === secondPackage.workPackageId);
  await context.call(secondReservation.masterRole, { action: "submit_master_analysis", requestId: "analysis-second", masterRequestId: secondReservation.requestId, submission: { analysis: "Analysis", interpretation: "Interpretation", assumptions: [], methodsUsed: ["Replication"], uncertainty: ["Residual bias"], artifactRefs: [] } });
  const secondSynthesis = {
    ownReasoning: `${secondPackage.mode} independent judgment`,
    masterInterpretations: ["Interpretation"],
    evidenceRefs: [`undergrad-task:${secondTask.taskId}`],
    conclusion: "Second evidence-based conclusion",
    hypotheses: [secondPackage.mode === "creative" ? "Falsifiable creative hypothesis" : "Falsifiable robust hypothesis"],
    proposedMethods: [secondPackage.mode === "creative" ? "Validation experiment" : "Preregistered replication"],
    counterEvidence: ["A plausible counterexample"],
    sensitivityChecks: ["Leave-one-source-out sensitivity check"],
    uncertainties: ["Residual uncertainty"],
    limitations: ["Residual bias"],
    unansweredQuestions: [],
  };
  if (secondPackage.mode === "robust") {
    await assert.rejects(
      () => context.call(secondPackage.doctorRole, {
        action: "submit_doctor_synthesis",
        requestId: "robust-missing-checks-second",
        workPackageId: secondPackage.workPackageId,
        synthesis: { ...secondSynthesis, sensitivityChecks: [] },
      }),
      (error) => error instanceof LabWorkflowError && error.code === "stage_violation",
    );
  }
  await context.call(secondPackage.doctorRole, {
    action: "submit_doctor_synthesis",
    requestId: "synthesis-second",
    workPackageId: secondPackage.workPackageId,
    synthesis: secondSynthesis,
  });
  await context.call("pi", { action: "review_doctor_synthesis", requestId: "review-second", workPackageId: secondPackage.workPackageId, decision: "accepted" });
  workflow = await context.call("pi", { action: "get_state" });
  const phd1View = await context.call("phd-1", { action: "get_state" });
  assert.deepEqual(phd1View.workPackages.map((entry) => entry.doctorRole), ["phd-1"]);
  assert.ok(phd1View.undergradTasks.every((entry) => entry.requesterRole === "phd-1"));
  const master1View = await context.call("master-1", { action: "get_state" });
  assert.ok(master1View.masterReservations.every((entry) => entry.masterRole === "master-1"));
  assert.ok(master1View.workPackages.every((entry) => master1View.masterReservations.some((reservation) => reservation.workPackageId === entry.workPackageId)));
  const undergraduateView = await context.call("undergraduate", { action: "get_state" });
  assert.deepEqual(undergraduateView.workPackages, []);
  assert.deepEqual(undergraduateView.masterReservations, []);
  const firstThread = workflow.undergradThreads.find((entry) => entry.parentTaskId === task1.taskId);
  const childView = await context.call(firstThread.sessionId, { action: "get_state" });
  assert.deepEqual(childView.undergradTasks.map((entry) => entry.taskId), [task1.taskId]);
  assert.deepEqual(childView.undergradThreads.map((entry) => entry.threadId), [firstThread.threadId]);

  const report = finalReport(workflow.workPackages, [task1, task2]);
  await assert.rejects(
    () => context.call("pi", { action: "complete_meeting", requestId: "bad-complete", report: { ...report, evidenceRefs: report.evidenceRefs.slice(1) } }),
    (error) => error instanceof LabWorkflowError && error.code === "stage_violation",
  );
  const completed = await context.call("pi", { action: "complete_meeting", requestId: "complete", report });
  assert.equal(completed.status, "completed");
  assert.equal(completed.finalReport.title, report.title);
  for (const [event, toRole] of [
    ["clarification_submitted", "pi"],
    ["doctor_dispatched", "phd-1"],
    ["doctor_dispatched", "phd-2"],
    ["undergrad_thread_submitted", "undergraduate"],
    ["undergrad_records_submitted", "phd-1"],
    ["undergrad_revision_requested", "undergraduate"],
    ["master_analysis_submitted", "phd-1"],
    ["doctor_synthesis_submitted", "pi"],
    ["doctor_revision_requested", firstPackage.doctorRole],
  ]) {
    assert.ok(deliveredNotices.some((notice) => notice.event === event && notice.toRole === toRole), `${event} should notify ${toRole}`);
  }
  assert.ok(completed.notices.every((notice) => notice.status === "delivered"));
  assert.equal(completed.finalReportArtifact.path, `.medpi/meetings/${context.meeting.meetingId}/final-report.md`);
  const renderedReport = await readFile(join(context.cwd, completed.finalReportArtifact.path), "utf8");
  assert.match(renderedReport, /^# Final academic report/m);
  assert.equal(completed.finalReportArtifact.sha256, createHash("sha256").update(renderedReport).digest("hex"));
  assert.equal(completed.finalReportArtifact.size, Buffer.byteLength(renderedReport, "utf8"));
  const duplicateComplete = await context.call("pi", { action: "complete_meeting", requestId: "complete", report });
  assert.equal(duplicateComplete.finalReportArtifact.sha256, completed.finalReportArtifact.sha256);
  await assert.rejects(
    () => context.call("pi", { action: "complete_meeting", requestId: "replace-complete", report: { ...report, title: "Replacement report" } }),
    (error) => error instanceof LabWorkflowError && error.code === "stage_violation",
  );
  assert.equal(await readFile(join(context.cwd, completed.finalReportArtifact.path), "utf8"), renderedReport);
  const completedDoctorView = await context.call("phd-1", { action: "get_state" });
  assert.equal(completedDoctorView.finalReport, undefined);
  assert.equal(completedDoctorView.finalReportArtifact, undefined);
});

test("releases an atomic master reservation when structured task delivery fails", async () => {
  const context = await setup({ deliverMasterTask: async () => { throw new Error("recipient unavailable"); } });
  const workflow = await clarifyAndDispatch(context);
  const workPackage = workflow.workPackages.find((entry) => entry.doctorRole === "phd-1");
  const task = await acceptRetrieval(context, "phd-1", workPackage.workPackageId, "delivery-failure");
  await assert.rejects(
    () => context.call("phd-1", { action: "claim_master", requestId: "failed-delivery", workPackageId: workPackage.workPackageId, preferredMasterRole: "master-1", inputRefs: [`undergrad-task:${task.taskId}`], expectedOutput: "Analyze the evidence" }),
    (error) => error instanceof LabWorkflowError && error.code === "master_delivery_failed",
  );
  await assert.rejects(
    () => context.call("phd-1", { action: "claim_master", requestId: "failed-delivery", workPackageId: workPackage.workPackageId, preferredMasterRole: "master-1", inputRefs: [`undergrad-task:${task.taskId}`], expectedOutput: "Analyze the evidence" }),
    (error) => error instanceof LabWorkflowError && error.code === "idempotency_conflict",
  );
  const state = await context.call("pi", { action: "get_state" });
  assert.equal(state.masterReservations.length, 1);
  assert.equal(state.masterReservations[0].status, "released");
  assert.match(state.masterReservations[0].error, /recipient unavailable/);
  assert.equal(state.workPackages.find((entry) => entry.workPackageId === workPackage.workPackageId).status, "pre_master_judgment");
});

test("restart marks pending operations interrupted, requires a new request id, retries with a new attempt, and cancellation aborts once", async () => {
  const aborted = [];
  const context = await setup({ abortSession: async (sessionId) => aborted.push(sessionId) });
  let workflow = await clarifyAndDispatch(context);
  const workPackage = workflow.workPackages.find((entry) => entry.doctorRole === "phd-1");
  workflow = await context.call("phd-1", delegateAction(workPackage.workPackageId, "restart", 1));
  const task = workflow.undergradTasks.at(-1);
  workflow = await context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "initial-spawn", taskId: task.taskId, threads: [threadSpec("old")] });
  const oldThread = workflow.undergradThreads.find((entry) => entry.parentTaskId === task.taskId);

  const projectKey = createHash("sha256").update(resolve(context.cwd)).digest("hex");
  const path = join(context.agentDir, "meetings", projectKey, `${context.meeting.meetingId}.workflow.json`);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  persisted.idempotency["retry-spawn"] = { fingerprint: "crashed", status: "pending", updatedAt: persisted.updatedAt };
  await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`);

  workflow = await readLabWorkflow({ cwd: context.cwd, meetingId: context.meeting.meetingId, actorSessionId: "session-pi" }, { ...context.options, runtimeId: "runtime-b" });
  assert.equal(workflow.undergradThreads.find((entry) => entry.threadId === oldThread.threadId).status, "interrupted");
  assert.equal(workflow.undergradTasks.find((entry) => entry.taskId === task.taskId).status, "interrupted");
  const recovered = JSON.parse(await readFile(path, "utf8"));
  assert.equal(recovered.idempotency["retry-spawn"].status, "interrupted");
  await assert.rejects(
    () => context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "retry-spawn", taskId: task.taskId, threads: [threadSpec("retry")] }, { runtimeId: "runtime-b" }),
    (error) => error instanceof LabWorkflowError && error.code === "operation_interrupted",
  );

  workflow = await context.call("undergraduate", { action: "spawn_undergrad_threads", requestId: "retry-spawn-new", taskId: task.taskId, threads: [threadSpec("retry")] }, { runtimeId: "runtime-b" });
  const retryThread = workflow.undergradThreads.find((entry) => entry.parentTaskId === task.taskId && entry.attempt === 2);
  assert.ok(retryThread?.sessionId);
  const cancel = { action: "cancel_task", requestId: "cancel-retry", taskId: task.taskId };
  await context.call("phd-1", cancel, { runtimeId: "runtime-b" });
  await context.call("phd-1", cancel, { runtimeId: "runtime-b" });
  assert.deepEqual(aborted, [retryThread.sessionId]);
});

test("workflow route applies origin, JSON, cwd, session, and unified action checks", async () => {
  const source = await readFile(new URL("../app/api/meetings/[id]/workflow/route.ts", import.meta.url), "utf8");
  assert.match(source, /isApiRequestAllowed\(req\)/);
  assert.match(source, /hasJsonContentType\(req\)/);
  assert.match(source, /sessionId is required/);
  assert.match(source, /orchestrateLabWorkflow\(\{/);
  assert.match(source, /bindLabWorkflowRuntime\(\)/);
});
