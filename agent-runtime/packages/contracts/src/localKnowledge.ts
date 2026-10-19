/** Device-local connections. Vault contents are read only; notes enter a provider only as attachments. */
export interface ObsidianVault {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** Null makes the vault available to all chats on this Mac. */
  readonly workspacePath: string | null;
}
export interface ObsidianNoteSummary {
  readonly path: string;
  readonly title: string;
  readonly excerpt: string;
}
export interface ObsidianSearchResult {
  readonly notes: readonly ObsidianNoteSummary[];
  readonly limited: boolean;
}
export interface ObsidianNote extends ObsidianNoteSummary {
  readonly vaultName: string;
  readonly content: string;
  readonly modifiedAt: number;
}
export type SkillImportAgent = "codex" | "claude" | "cursor" | "copilot";
export interface SkillImportPreview {
  readonly token: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly files: readonly string[];
  readonly bytes: number;
}
export interface ImportedSkill {
  readonly id: string;
  readonly name: string;
  readonly agent: SkillImportAgent;
  readonly path: string;
  readonly importedAt: string;
}
export interface LocalKnowledgeBridge {
  listVaults: (workspacePath?: string | null | undefined) => Promise<readonly ObsidianVault[]>;
  connectVault: (input: {
    name: string;
    workspacePath: string | null;
  }) => Promise<ObsidianVault | null>;
  disconnectVault: (id: string) => Promise<void>;
  searchNotes: (input: {
    vaultID: string;
    query: string;
    workspacePath?: string | null | undefined;
  }) => Promise<ObsidianSearchResult>;
  readNote: (input: {
    vaultID: string;
    path: string;
    workspacePath?: string | null | undefined;
  }) => Promise<ObsidianNote>;
  openNote: (input: {
    vaultID: string;
    path: string;
    workspacePath?: string | null | undefined;
  }) => Promise<void>;
  previewSkill: () => Promise<SkillImportPreview | null>;
  importSkill: (input: {
    token: string;
    agent: SkillImportAgent;
    workspacePath: string | null;
  }) => Promise<ImportedSkill>;
  listImportedSkills: () => Promise<readonly ImportedSkill[]>;
  removeImportedSkill: (id: string) => Promise<void>;
}
export const LOCAL_KNOWLEDGE_CHANNEL = "cinderdeck:local-knowledge";
