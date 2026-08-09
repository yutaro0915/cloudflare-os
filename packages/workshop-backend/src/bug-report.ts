// In-app bug reporting: turns a user-submitted report into a GitHub issue on the source
// repository. Requires the deployment secret GITHUB_BUG_REPORT_TOKEN (a fine-grained PAT with
// issues:write on the target repo); without it, submission fails with a clear message.
import type { BugReportInput, BugReportResult } from "@gadgets/workshop-shared/api";

export const BUG_REPORT_REPO = "yutaro0915/cloudflare-os";
export const BUG_REPORT_LABEL = "bug-report";

// Keep issue bodies bounded even if the client sends an oversized DOM excerpt.
const MAX_DESCRIPTION_CHARS = 10_000;
const MAX_ELEMENT_HTML_CHARS = 4_000;

export type BugReportEnv = {
  GITHUB_BUG_REPORT_TOKEN?: string;
};

export type BugReporterInfo = {
  id: string;
  name: string;
};

export function formatBugReportIssueBody(report: BugReportInput, reporter: BugReporterInfo): string {
  const description = report.description.slice(0, MAX_DESCRIPTION_CHARS);
  const lines = [
    "## 説明",
    "",
    description,
    "",
    "## 発生環境",
    "",
    `- URL: ${report.url}`,
    `- Route: ${report.route}`,
    `- UserAgent: ${report.userAgent}`,
    `- Viewport: ${report.viewport.width}x${report.viewport.height}`,
    `- 報告ユーザー: ${reporter.name} (${reporter.id})`,
  ];
  if (report.elementSelector) {
    lines.push(`- 対象要素セレクタ: \`${report.elementSelector}\``);
  }
  if (report.elementHtml) {
    const html = report.elementHtml.slice(0, MAX_ELEMENT_HTML_CHARS);
    lines.push(
      "",
      "<details>",
      "<summary>対象要素の DOM 抜粋</summary>",
      "",
      "```html",
      html,
      "```",
      "",
      "</details>",
    );
  }
  lines.push("", "---", "アプリ内バグ報告フォームから自動作成されました。");
  return lines.join("\n");
}

// Create a GitHub issue for the report. `fetchImpl` is injectable for tests.
export async function createBugReportIssue(
  env: BugReportEnv,
  reporter: BugReporterInfo,
  report: BugReportInput,
  fetchImpl: typeof fetch = fetch,
): Promise<BugReportResult> {
  if (!report.description.trim()) {
    throw new Error("Bug report description must not be empty.");
  }
  const token = env.GITHUB_BUG_REPORT_TOKEN;
  if (!token) {
    // 501-equivalent: the deployment has not configured bug reporting.
    throw new Error(
      "Bug reporting is not configured on this deployment " +
      "(missing GITHUB_BUG_REPORT_TOKEN secret).",
    );
  }

  const title = `[Bug Report] ${report.description.trim().split("\n")[0].slice(0, 80)}`;
  const response = await fetchImpl(`https://api.github.com/repos/${BUG_REPORT_REPO}/issues`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-os-bug-report",
    },
    body: JSON.stringify({
      title,
      body: formatBugReportIssueBody(report, reporter),
      labels: [BUG_REPORT_LABEL],
    }),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`Failed to create GitHub issue (status ${response.status}): ${detail}`);
  }

  const issue = await response.json() as { html_url?: string };
  if (typeof issue.html_url !== "string") {
    throw new Error("GitHub issue creation returned an unexpected response.");
  }
  return { issueUrl: issue.html_url };
}
