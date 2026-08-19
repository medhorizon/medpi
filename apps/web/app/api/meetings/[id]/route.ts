import { NextResponse } from "next/server";
import { GroupMeetingError, readGroupMeeting, updateGroupMeetingSettings } from "@/lib/group-meeting-server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
    if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_cwd" }, { status: 400 });
    const { id } = await context.params;
    const meeting = await readGroupMeeting(cwd, id);
    if (!meeting) return NextResponse.json({ error: "Meeting not found", code: "meeting_not_found" }, { status: 404 });
    return NextResponse.json(meeting);
  } catch (error) {
    if (error instanceof GroupMeetingError) {
      const status = error.code === "access_denied" || error.code === "project_untrusted" ? 403 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!isApiRequestAllowed(req)) {
      return NextResponse.json({ error: "Untrusted API request", code: "untrusted_request" }, { status: 403 });
    }
    if (!hasJsonContentType(req)) {
      return NextResponse.json({ error: "Content-Type must be application/json", code: "invalid_content_type" }, { status: 415 });
    }
    const cwd = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
    if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_cwd" }, { status: 400 });
    let body: { members?: unknown };
    try {
      body = await req.json() as { members?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
    }
    const { id } = await context.params;
    return NextResponse.json(await updateGroupMeetingSettings(cwd, id, body.members));
  } catch (error) {
    if (error instanceof GroupMeetingError) {
      const status = error.code === "access_denied" || error.code === "project_untrusted"
        ? 403
        : error.code === "meeting_not_found"
          ? 404
          : error.code === "invalid_cwd" || error.code === "invalid_settings"
            ? 400
            : 409;
      return NextResponse.json({
        error: error.message,
        code: error.code,
        ...(error.role ? { role: error.role } : {}),
      }, { status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
