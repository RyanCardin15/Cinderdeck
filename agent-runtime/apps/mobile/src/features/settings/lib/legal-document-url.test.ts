import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://github.com/RyanCardin15/Cinderdeck/blob/main/NOTICE",
    "https://github.com/RyanCardin15/Cinderdeck/blob/main/NOTICE/",
    "https://github.com/RyanCardin15/Cinderdeck/blob/main/NOTICE?source=app",
    "https://github.com/RyanCardin15/Cinderdeck/blob/main/NOTICE#licenses",
    "https://github.com/RyanCardin15/Cinderdeck/blob/main/SECURITY.md",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://abc.test/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
