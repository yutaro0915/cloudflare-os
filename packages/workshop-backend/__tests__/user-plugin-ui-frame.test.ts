import { describe, expect, it } from "vitest";
import { buildUserPluginUiFrameHtml } from "../src/user-plugin-ui-frame.js";

describe("user plugin UI frame document", () => {
  it("renders only escaped inert content under a script-free CSP", () => {
    const html = buildUserPluginUiFrameHtml({
      schemaVersion: 1,
      blocks: [
        {kind: "text", text: "雪 </script>"},
        {kind: "notice", tone: "warning", text: "<img src=x>"},
        {kind: "list", items: ["<b>literal</b>"]},
      ],
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("worker-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("雪 &lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;literal&lt;/b&gt;");
  });
});
