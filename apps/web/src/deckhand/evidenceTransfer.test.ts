import { assert, describe, it } from "vite-plus/test";
import { sha256 } from "@noble/hashes/sha2";
import { downloadEvidenceAssets, type EvidenceAsset } from "./evidenceTransfer";
const bytes = new TextEncoder().encode("test evidence");
const hash = [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const asset: EvidenceAsset = {
  id: "logs",
  name: "recording.log",
  kind: "logs",
  mimeType: "text/plain",
  size: bytes.length,
  sha256: hash,
  state: "ready",
  detail: null,
};
describe("Evidence asset preparation", () => {
  it("creates an actual file only from matching prepared bytes and checksum", async () => {
    const result = await downloadEvidenceAssets([asset], async () => new Response(bytes));
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0]!.name, "recording.log");
    assert.equal(await result.files[0]!.text(), "test evidence");
    assert.equal(result.transfers[0]!.state, "prepared");
  });
  it("reports changed content and oversized body instead of attaching it", async () => {
    const result = await downloadEvidenceAssets(
      [{ ...asset, sha256: "0".repeat(64) }, asset],
      async (value) =>
        new Response(value.sha256 === hash ? new Uint8Array(bytes.length + 1) : bytes),
    );
    assert.equal(result.files.length, 0);
    assert.match(result.transfers[0]!.detail, /checksum changed/);
    assert.match(result.transfers[1]!.detail, /exceeds/);
  });
  it("retains missing/oversized resources and limits outgoing attachments before download", async () => {
    let reads = 0;
    const result = await downloadEvidenceAssets(
      [
        { ...asset, size: 51 * 1024 * 1024, kind: "video" },
        { ...asset, state: "missing", detail: "Video absent" },
        ...Array.from({ length: 10 }, (_, index) => ({ ...asset, id: `log${index}` })),
      ],
      async () => {
        reads++;
        return new Response(bytes);
      },
    );
    assert.equal(reads, 8);
    assert.equal(result.files.length, 8);
    assert.equal(result.transfers.filter((item) => item.state === "excluded").length, 4);
    assert.match(result.transfers[0]!.detail, /size limit/);
    assert.equal(result.transfers[1]!.detail, "Video absent");
  });
});
