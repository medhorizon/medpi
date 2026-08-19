export interface InitialNavigation {
  meetingId: string | null;
  requestedCwd: string | null;
  sessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const meetingId = searchParams.get("meeting")?.trim() || null;
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    meetingId,
    requestedCwd,
    sessionId: meetingId || requestedCwd ? null : searchParams.get("session"),
  };
}

export function buildMeetingNavigationUrl(meetingId: string, cwd: string): string {
  return `?meeting=${encodeURIComponent(meetingId)}&cwd=${encodeURIComponent(cwd)}`;
}
