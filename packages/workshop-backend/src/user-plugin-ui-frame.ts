const FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "worker-src 'none'",
].join("; ");

import type {DeclarativePluginUiDocument} from "./plugin-manifest-registry.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDocument(document: DeclarativePluginUiDocument): string {
  return document.blocks.map(block => {
    if (block.kind === "text") return `<p>${escapeHtml(block.text)}</p>`;
    if (block.kind === "notice") {
      return `<aside class="notice ${block.tone}">${escapeHtml(block.text)}</aside>`;
    }
    return `<ul>${block.items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }).join("");
}

/** Builds an inert opaque-origin document from already-validated isolated renderer output. */
export function buildUserPluginUiFrameHtml(document: DeclarativePluginUiDocument): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<meta name="referrer" content="no-referrer">
<style>html{color-scheme:light dark}body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif}p{white-space:pre-wrap}.notice{padding:8px 10px;border:1px solid #8886;border-radius:8px}.warning{border-color:#b87800}li+li{margin-top:4px}</style>
</head><body>${renderDocument(document)}</body></html>`;
}
