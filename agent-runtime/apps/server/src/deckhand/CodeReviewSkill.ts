import * as Review from "@cinderdeck/contracts/deckhand/reviewerRpc";
import type { ChatFileAttachment } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { createDeterministicAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";

export class CodeReviewSkillError extends Schema.TaggedError<CodeReviewSkillError>()(
  "CodeReviewSkillError",
  { reason: Schema.Literals(["invalid_file", "invalid_content", "invalid_attachment"]) },
) {}

export const readCodeReviewSkill = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillPath = path.join(root, Review.CODE_REVIEW_SKILL_PATH);
  const configured = yield* fs.exists(skillPath);
  let content = Review.DEFAULT_CODE_REVIEW_SKILL;
  if (configured) {
    const stat = yield* fs.stat(skillPath);
    if (stat.type !== "File" || stat.size > 24000)
      return yield* new CodeReviewSkillError({ reason: "invalid_file" });
    content = yield* fs.readFileString(skillPath);
    if (!content.trim() || content.length > 6000)
      return yield* new CodeReviewSkillError({ reason: "invalid_content" });
  }
  return { path: skillPath, content, configured };
});

/** A normal, previewable file attachment. Its thread-scoped copy survives retries and
 * later workspace edits without inserting the skill text into the user's message. */
export const attachCodeReviewSkill = Effect.fn(function* (
  threadId: string,
  input: { readonly snapshot?: typeof Review.CodeReviewSkill.Type; readonly editRoot?: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const stableId = createDeterministicAttachmentId(threadId, "workspace-code-review-skill");
  if (!stableId || (!input.snapshot && !input.editRoot))
    return yield* new CodeReviewSkillError({ reason: "invalid_attachment" });
  const attachment: ChatFileAttachment = {
    type: "file",
    id: `${stableId}-md`,
    name: "Code Review Skill.md",
    mimeType: "text/markdown",
    sizeBytes: 1,
  };
  const savedPath = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
  if (!savedPath) return yield* new CodeReviewSkillError({ reason: "invalid_attachment" });
  if (!(yield* fs.exists(savedPath))) {
    const skill = input.snapshot ?? (yield* readCodeReviewSkill(input.editRoot!));
    // The editing session changes the workspace file, while the attachment records
    // what was supplied to this conversation. Never overwrite an existing skill.
    if (input.editRoot && !skill.configured) {
      yield* fs.makeDirectory(path.dirname(skill.path), { recursive: true });
      yield* fs.writeFileString(skill.path, skill.content, { flag: "wx" });
    }
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFileString(savedPath, skill.content, { flag: "wx", mode: 0o600 });
  }
  return { ...attachment, sizeBytes: Number((yield* fs.stat(savedPath)).size) };
});
