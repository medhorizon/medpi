import { NextResponse } from "next/server";
import {
  createGroupMeeting,
  GroupMeetingError,
  listGroupMeetings,
} from "@/lib/group-meeting-server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!isApiRequestAllowed(req)) {
      return NextResponse.json({ error: "Untrusted API request", code: "untrusted_request" }, { status: 403 });
    }
    if (!hasJsonContentType(req)) {
      return NextResponse.json({ error: "Content-Type must be application/json", code: "invalid_content_type" }, { status: 415 });
    }
    let body: { cwd?: unknown };
    try {
      body = await req.json() as { cwd?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
    }
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_cwd" }, { status: 400 });
    return NextResponse.json(await createGroupMeeting(cwd), { status: 201 });
  } catch (error) {
    if (error instanceof GroupMeetingError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
        ...(error.role ? { role: error.role } : {}),
        ...(error.meeting ? { meeting: error.meeting } : {}),
      }, {
        status: error.code === "access_denied" || error.code === "project_untrusted"
          ? 403
          : error.code === "invalid_cwd" ? 400 : 409,
      });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
    if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_cwd" }, { status: 400 });
    return NextResponse.json({ meetings: await listGroupMeetings(cwd) });
  } catch (error) {
    if (error instanceof GroupMeetingError) {
      const status = error.code === "access_denied" || error.code === "project_untrusted" ? 403 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
