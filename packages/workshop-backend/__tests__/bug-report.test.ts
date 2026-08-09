import { describe, expect, it, vi } from "vitest";
import type { BugReportInput } from "@gadgets/workshop-shared/api";
import {
  BUG_REPORT_LABEL,
  BUG_REPORT_REPO,
  createBugReportIssue,
  formatBugReportIssueBody,
} from "../src/bug-report.js";

const reporter = { id: "user@example.com", name: "Test User" };

function makeReport(overrides: Partial<BugReportInput> = {}): BugReportInput {
  return {
    description: "The sidebar disappears when resizing.",
    url: "https://os.cherie-lab.com/gatekeepers",
    route: "/gatekeepers",
    userAgent: "TestBrowser/1.0",
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
}

describe("createBugReportIssue", () => {
  it("creates a labeled GitHub issue and returns its URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ html_url: "https://github.com/yutaro0915/cloudflare-os/issues/42" }),
      { status: 201 },
    ));

    const result = await createBugReportIssue(
      { GITHUB_BUG_REPORT_TOKEN: "test-token" }, reporter, makeReport(), fetchMock,
    );

    expect(result).toEqual({ issueUrl: "https://github.com/yutaro0915/cloudflare-os/issues/42" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${BUG_REPORT_REPO}/issues`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(init.body);
    expect(body.labels).toEqual([BUG_REPORT_LABEL]);
    expect(body.title).toContain("The sidebar disappears");
    expect(body.body).toContain("https://os.cherie-lab.com/gatekeepers");
    expect(body.body).toContain("Test User");
  });

  it("throws a clear error when the token is not configured", async () => {
    const fetchMock = vi.fn();
    await expect(createBugReportIssue({}, reporter, makeReport(), fetchMock))
      .rejects.toThrow(/GITHUB_BUG_REPORT_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty description without calling GitHub", async () => {
    const fetchMock = vi.fn();
    await expect(createBugReportIssue(
      { GITHUB_BUG_REPORT_TOKEN: "t" }, reporter, makeReport({ description: "  " }), fetchMock,
    )).rejects.toThrow(/description/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces GitHub API failures with the status code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Bad credentials", { status: 401 }));
    await expect(createBugReportIssue(
      { GITHUB_BUG_REPORT_TOKEN: "t" }, reporter, makeReport(), fetchMock,
    )).rejects.toThrow(/status 401/);
  });
});

describe("formatBugReportIssueBody", () => {
  it("puts the DOM excerpt in a details block and truncates it", () => {
    const body = formatBugReportIssueBody(makeReport({
      elementSelector: "div#app > button.submit",
      elementHtml: "<button>".padEnd(10_000, "x"),
    }), reporter);

    expect(body).toContain("<details>");
    expect(body).toContain("div#app > button.submit");
    // Truncated to the 4000-char cap, not the full 10000.
    expect(body.length).toBeLessThan(6_000);
  });

  it("omits the details block when no element was picked", () => {
    const body = formatBugReportIssueBody(makeReport(), reporter);
    expect(body).not.toContain("<details>");
    expect(body).toContain("- Viewport: 1280x800");
  });
});
