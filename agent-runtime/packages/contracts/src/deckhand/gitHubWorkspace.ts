import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";

export const GITHUB_WORKSPACE_METHOD = "deckhand.github.request";
const text = Schema.String.check(Schema.isMaxLength(4096));
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const identity = { account: id, hostname: id };
export const GitHubWorkspaceFilters = Schema.Struct({
  repository: Schema.NullOr(text),
  organization: Schema.NullOr(text),
  state: Schema.Literals(["all", "open", "draft", "merged", "closed"]),
  role: Schema.Literals(["anyone", "author", "review", "assigned", "involved"]),
  sort: Schema.Literals(["updated", "newest", "oldest", "comments"]),
  text,
  label: text,
  advanced: Schema.Boolean,
});
export type GitHubWorkspaceFilters = typeof GitHubWorkspaceFilters.Type;
const pageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const actor = Schema.Struct({ login: Schema.String });
export const GitHubWorkspaceRepository = Schema.Struct({
  id,
  nameWithOwner: text,
  isPrivate: Schema.Boolean,
  isArchived: Schema.Boolean,
  viewerHasStarred: Schema.Boolean,
  url: text,
  ownerAccount: Schema.optionalKey(Schema.NullOr(Schema.Struct({ kind: Schema.String }))),
});
export type GitHubWorkspaceRepository = typeof GitHubWorkspaceRepository.Type;
export const GitHubWorkspaceRequest = Schema.Struct({
  id,
  number: PositiveInt,
  title: Schema.String,
  url: text,
  state: Schema.String,
  isDraft: Schema.Boolean,
  author: Schema.optionalKey(Schema.NullOr(actor)),
  repository: Schema.Struct({ nameWithOwner: text }),
  updatedAt: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.optionalKey(
            Schema.NullOr(Schema.Struct({ state: Schema.String })),
          ),
        }),
      }),
    ),
  }),
});
export type GitHubWorkspaceRequest = typeof GitHubWorkspaceRequest.Type;
const activity = Schema.Struct({
  id,
  author: Schema.optionalKey(Schema.NullOr(actor)),
  body: Schema.String,
  createdAt: Schema.String,
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const GitHubWorkspaceDetail = Schema.Struct({
  id,
  body: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  headRefOid: id,
  state: Schema.String,
  isDraft: Schema.Boolean,
  author: Schema.optionalKey(Schema.NullOr(actor)),
  mergeable: Schema.String,
  reviewDecision: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reviews: Schema.Struct({
    nodes: Schema.Array(activity),
    totalCount: Schema.optionalKey(Schema.Number),
  }),
  comments: Schema.Struct({
    nodes: Schema.Array(activity),
    totalCount: Schema.optionalKey(Schema.Number),
  }),
});
export type GitHubWorkspaceDetail = typeof GitHubWorkspaceDetail.Type;
const file = Schema.Struct({
  filename: Schema.String,
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type GitHubWorkspaceFile = typeof file.Type;
export const GitHubWorkspacePreferences = Schema.Struct({
  ...identity,
  selectedViewID: id,
  filters: GitHubWorkspaceFilters,
  query: Schema.String,
  views: Schema.Array(
    Schema.Struct({
      id,
      name: Schema.String,
      builtIn: Schema.Boolean,
      filters: GitHubWorkspaceFilters,
      query: Schema.String,
    }),
  ),
});
export type GitHubWorkspacePreferences = typeof GitHubWorkspacePreferences.Type;
const after = { after: Schema.optionalKey(Schema.NullOr(text)) };
export const GitHubWorkspaceInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preferences") }),
  Schema.Struct({ action: Schema.Literals(["select", "delete"]), ...identity, id }),
  Schema.Struct({
    action: Schema.Literal("upsert"),
    ...identity,
    id,
    name: text,
    filters: GitHubWorkspaceFilters,
    select: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("workspace"),
    ...identity,
    id,
    filters: GitHubWorkspaceFilters,
  }),
  Schema.Struct({ action: Schema.Literal("reorder"), ...identity, ids: Schema.Array(id) }),
  Schema.Struct({
    action: Schema.Literal("repositories"),
    ...identity,
    ...after,
    organization: Schema.optionalKey(Schema.NullOr(text)),
  }),
  Schema.Struct({ action: Schema.Literal("organizations"), ...identity, ...after }),
  Schema.Struct({
    action: Schema.Literal("search"),
    ...identity,
    ...after,
    filters: GitHubWorkspaceFilters,
  }),
  Schema.Struct({ action: Schema.Literal("detail"), ...identity, id }),
  Schema.Struct({
    action: Schema.Literal("files"),
    ...identity,
    repository: text,
    number: PositiveInt,
    page: PositiveInt,
  }),
  Schema.Struct({
    action: Schema.Literal("star"),
    ...identity,
    repository: GitHubWorkspaceRepository,
    starred: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("review"),
    ...identity,
    request: GitHubWorkspaceRequest,
    detail: GitHubWorkspaceDetail,
    event: Schema.Literals(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: Schema.String.check(Schema.isMaxLength(65536)),
  }),
]);
export type GitHubWorkspaceInput = typeof GitHubWorkspaceInput.Type;
export const GitHubWorkspaceResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("preferences"), preferences: GitHubWorkspacePreferences }),
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    ...identity,
    page: Schema.Struct({
      nodes: Schema.Array(GitHubWorkspaceRepository),
      pageInfo: Schema.optionalKey(pageInfo),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("organizations"),
    ...identity,
    page: Schema.Struct({ nodes: Schema.Array(actor), pageInfo: Schema.optionalKey(pageInfo) }),
  }),
  Schema.Struct({
    kind: Schema.Literal("search"),
    ...identity,
    requests: Schema.Array(GitHubWorkspaceRequest),
    count: Schema.Number,
    pageInfo,
  }),
  Schema.Struct({ kind: Schema.Literal("detail"), ...identity, detail: GitHubWorkspaceDetail }),
  Schema.Struct({ kind: Schema.Literal("files"), ...identity, files: Schema.Array(file) }),
  Schema.Struct({
    kind: Schema.Literal("star"),
    ...identity,
    repositoryID: id,
    starred: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("review"), ...identity, submitted: Schema.Boolean }),
]);
export type GitHubWorkspaceResult = typeof GitHubWorkspaceResult.Type;
