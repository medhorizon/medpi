import { NextResponse } from "next/server";
import { GroupMeetingError, readGroupMeeting } from "@/lib/group-meeting-server";

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
