import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./initial-navigation.ts");
}

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    meetingId: null,
    requestedCwd: "/work/project",
    sessionId: null,
  });
});

test("uses an explicit meeting instead of cwd or session", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    meeting: " meeting-id ",
    cwd: "/work/project",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    meetingId: "meeting-id",
    requestedCwd: "/work/project",
    sessionId: null,
  });
});

test("does not fall back to a session when a meeting has no cwd", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ meeting: "meeting-id", session: "saved-session" })),
    { meetingId: "meeting-id", requestedCwd: null, sessionId: null },
  );
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { meetingId: null, requestedCwd: null, sessionId: "saved-session" },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { meetingId: null, requestedCwd: null, sessionId: "saved-session" },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Cpi-web")),
    { meetingId: null, requestedCwd: "C:\\Projects\\pi-web", sessionId: null },
  );
});

test("builds a meeting URL with its project cwd", async () => {
  const { buildMeetingNavigationUrl } = await loadSubject();

  assert.equal(
    buildMeetingNavigationUrl("meeting/id", "C:\\Projects\\pi web"),
    "?meeting=meeting%2Fid&cwd=C%3A%5CProjects%5Cpi%20web",
  );
});
