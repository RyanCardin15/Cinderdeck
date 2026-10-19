/** Whole-app fixture test. Launches the native host, automates its bundled renderer,
 * and intercepts only folder dialogs / OS URL dispatch in the test child process.
 * --real-obsidian delegates URLs to the OS and waits for manual registration/open verification.
 * --live-ai waits for an authorized real AI turn and checks the response against a secret fixture code.
 * Usage: node scripts/deckhand/obsidian-e2e.mjs /absolute/Cinderdeck\ Debug.app /absolute/new-artifacts
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
const require = NodeModule.createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
);
const { chromium } = require("playwright-core");
const app = process.argv[2],
  root = process.argv[3];
const realObsidian = process.argv.includes("--real-obsidian");
const liveAI = process.argv.includes("--live-ai");
if (!app?.endsWith(".app") || !root || !NodePath.isAbsolute(app) || !NodePath.isAbsolute(root))
  throw new Error("Supply an absolute whole-app bundle and a new artifact folder.");
await NodeFSP.mkdir(root);
const fixture = NodePath.join(root, "vault");
const project = NodePath.join(root, "project");
const skillFolder = NodePath.join(root, "skill");
await NodeFSP.mkdir(NodePath.join(fixture, ".obsidian"), { recursive: true });
await NodeFSP.mkdir(NodePath.join(fixture, "Projects"));
await NodeFSP.mkdir(project);
await NodeFSP.mkdir(NodePath.join(root, "stacks"));
await NodeFSP.writeFile(
  NodePath.join(root, "stacks/fixture.toml"),
  `name = "Fixture"\nroot = ${JSON.stringify(project)}\n`,
);
await NodeFSP.mkdir(NodePath.join(skillFolder, "references"), { recursive: true });
const verificationCode = `CINDERDECK-${NodeCrypto.randomUUID()}`;
const noteText = `---\ntags: [architecture]\n---\n# Aurora decision\n\nKeep [[Research]] and **reviewable decisions**.\n\nVerification code: ${verificationCode}\nLaunch color: cobalt\n`;
await NodeFSP.writeFile(NodePath.join(fixture, "Projects", "Aurora decision.md"), noteText);
await NodeFSP.writeFile(NodePath.join(fixture, "Research.md"), "# Research\nFixture background.");
await NodeFSP.writeFile(
  NodePath.join(skillFolder, "SKILL.md"),
  "---\nname: fixture-obsidian\ndescription: Fixture skill for the Obsidian whole-app test.\n---\n# Fixture instructions\nPreserve [[wikilinks]].\n",
);
await NodeFSP.writeFile(NodePath.join(skillFolder, "references", "rules.md"), "Fixture reference.");
async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const cdpPort = await freePort(),
  inspectorPort = await freePort();
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const wrapper = NodePath.join(root, "runtime-wrapper");
const runtime = NodePath.join(app, "Contents/Resources/Cinderdeck.app/Contents/MacOS/Cinderdeck");
await NodeFSP.writeFile(
  wrapper,
  `#!/bin/sh\nexec ${quote(runtime)} --remote-debugging-port=${cdpPort} --inspect=${inspectorPort}\n`,
  { mode: 0o700 },
);
const child = NodeChildProcess.spawn(NodePath.join(app, "Contents/MacOS/Cinderdeck"), [], {
  env: {
    ...process.env,
    CINDERDECK_STACKS_PREVIEW_ROOT: root,
    CINDERDECK_STACKS_SOCKET: NodePath.join(root, "control.sock"),
    CINDERDECK_RUNTIME_PATH: wrapper,
    DECKHAND_DISABLE_AUTO_UPDATE: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
  browser,
  socket,
  runtimePID,
  page;
child.stdout.on("data", (value) => {
  logs = (logs + value).slice(-500000);
});
child.stderr.on("data", (value) => {
  logs = (logs + value).slice(-500000);
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function endpoint(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) return await response.json();
    } catch {}
    if (child.exitCode !== null) throw new Error(`Host exited: ${child.exitCode}`);
    await sleep(500);
  }
  throw new Error(`Debug endpoint ${port} did not start.`);
}
const evidence = { hostPID: child.pid, checks: [] };
try {
  const inspector = (await endpoint(inspectorPort))[0];
  socket = new WebSocket(inspector.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const pending = new Map();
  let counter = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      callback?.(message);
    }
  };
  const evaluate = async (expression) => {
    const id = ++counter;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Inspector evaluation timed out."));
      }, 10000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result));
    return result.result.result.value;
  };
  runtimePID = await evaluate("process.pid");
  evidence.runtimePID = runtimePID;
  await evaluate(
    `globalThis.__knowledgeElectron = process.getBuiltinModule('module').createRequire(process.cwd() + '/fixture.cjs')('electron'); globalThis.__knowledgePick = null; globalThis.__knowledgeURLs = []; globalThis.__knowledgeOriginalOpen = __knowledgeElectron.shell.openExternal.bind(__knowledgeElectron.shell); __knowledgeElectron.dialog.showOpenDialog = async () => ({ canceled: !__knowledgePick, filePaths: __knowledgePick ? [__knowledgePick] : [] }); __knowledgeElectron.shell.openExternal = async url => { __knowledgeURLs.push(url); ${realObsidian ? "return await __knowledgeOriginalOpen(url);" : ""} }; true`,
  );
  await endpoint(cdpPort);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = browser.contexts()[0];
  for (let i = 0; i < 60; i++) {
    page = context.pages().find((p) => p.url().startsWith("deckhand://app"));
    if (page) break;
    await sleep(500);
  }
  NodeAssert.ok(page, "Main bundled renderer appeared");
  page.setDefaultTimeout(15000);
  // Provider version notices may arrive after setup and cover panel controls.
  // Dismiss them through the normal UI without installing or changing providers.
  await page.addLocatorHandler(
    page.getByRole("button", { name: "Dismiss notification", exact: true }).first(),
    async () => {
      for (const notice of await page
        .getByRole("button", { name: "Dismiss notification", exact: true })
        .all())
        await notice.click();
    },
  );
  await page.waitForFunction(() => window.desktopBridge?.knowledge !== undefined);
  NodeAssert.equal(await page.evaluate(() => window.desktopBridge.isNativeHost()), true);
  await page.evaluate(async () => {
    const current = await window.desktopBridge.getClientSettings();
    await window.desktopBridge.setClientSettings({
      ...current,
      onboardingCompletedAt: new Date().toISOString(),
    });
  });
  evidence.checks.push("native host owns bundled renderer");
  const settings = async () => {
    // Parent readiness can deliver its initial workspace route after hydration.
    // Navigate in the existing renderer and retry only that initial route race.
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        window.location.hash = "/settings/integrations";
      });
      try {
        await page
          .getByRole("button", { name: "Connect vault…", exact: true })
          .waitFor({ timeout: 1500 });
        return;
      } catch {
        if (i === 7) throw new Error("Integrations did not become available.");
      }
    }
  };
  await page.reload();
  await settings();
  for (const notification of await page
    .getByRole("button", { name: "Dismiss notification", exact: true })
    .all())
    await notification.click();
  await evaluate(`__knowledgePick = ${JSON.stringify(fixture)}`);
  await page.getByRole("textbox", { name: "Vault name", exact: true }).fill("Fixture notes");
  await page.getByRole("button", { name: "Connect vault…", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect Fixture notes", exact: true }).waitFor();
  evidence.checks.push("connect through native folder dialog and real IPC");
  await page.getByRole("button", { name: "Browse notes", exact: true }).click();
  await page.getByRole("textbox", { name: "Search notes", exact: true }).fill("aurora");
  await page.getByRole("button", { name: /Aurora decision/ }).click();
  await page.getByRole("heading", { name: "Aurora decision", exact: true }).waitFor();
  if (realObsidian) {
    await NodeFSP.writeFile(
      NodePath.join(root, "ready-for-obsidian.json"),
      JSON.stringify({
        vault: fixture,
        note: NodePath.join(fixture, "Projects/Aurora decision.md"),
      }),
    );
    console.log("Waiting for disposable vault registration in Obsidian.");
    for (let i = 0; i < 600; i++) {
      if (
        await NodeFSP.stat(NodePath.join(root, "obsidian-ready"))
          .then(() => true)
          .catch(() => false)
      )
        break;
      if (i === 599) throw new Error("Disposable Obsidian setup was not completed.");
      await sleep(1000);
    }
  }
  await page.getByRole("button", { name: "Open in Obsidian", exact: true }).click();
  const urls = await evaluate("__knowledgeURLs");
  NodeAssert.equal(
    new URL(urls.at(-1)).searchParams.get("path"),
    NodePath.join(fixture, "Projects/Aurora decision.md"),
  );
  evidence.checks.push(
    realObsidian
      ? "search, rendered preview and real OS Obsidian handoff"
      : "search, rendered preview and encoded OS handoff (intercepted)",
  );
  if (realObsidian)
    await NodeFSP.writeFile(NodePath.join(root, "obsidian-dispatched"), urls.at(-1));
  if (realObsidian) {
    console.log("Waiting for visible note-open verification in Obsidian.");
    for (let i = 0; i < 600; i++) {
      if (
        await NodeFSP.stat(NodePath.join(root, "obsidian-open-verified"))
          .then(() => true)
          .catch(() => false)
      )
        break;
      if (i === 599) throw new Error("The actual note was not verified in Obsidian.");
      await sleep(1000);
    }
    evidence.checks.push("actual Obsidian window visibly opens the exact fixture note");
  }
  await page.screenshot({ path: NodePath.join(root, "notes-preview.png") });
  await page.keyboard.press("Escape");
  await page.reload();
  await settings();
  await page.getByRole("button", { name: "Disconnect Fixture notes", exact: true }).waitFor();
  evidence.checks.push("connections survive renderer reload");
  // Install only into a disposable workspace, never a personal provider home.
  await evaluate(`__knowledgePick = ${JSON.stringify(project)}`);
  await page.getByRole("combobox", { name: "Connection and import scope", exact: true }).click();
  await page.getByRole("option", { name: "Workspace folder…", exact: true }).click();
  await page.getByText(`Workspace folder: ${project}`, { exact: true }).waitFor();
  await evaluate(`__knowledgePick = ${JSON.stringify(skillFolder)}`);
  await page.getByRole("button", { name: "Import skill folder…", exact: true }).click();
  await page.getByRole("dialog").getByText("Preserve [[wikilinks]].", { exact: false }).waitFor();
  NodeAssert.equal(
    await NodeFSP.stat(NodePath.join(project, ".agents/skills/fixture-obsidian"))
      .then(() => true)
      .catch(() => false),
    false,
  );
  await page.getByRole("button", { name: "Install skill", exact: true }).click();
  await page.getByText(/Imported fixture-obsidian for codex/).waitFor();
  NodeAssert.equal(
    await NodeFSP.readFile(
      NodePath.join(project, ".agents/skills/fixture-obsidian/references/rules.md"),
      "utf8",
    ),
    "Fixture reference.",
  );
  evidence.checks.push("reviewed skill import, selected provider and workspace destination");
  await page.getByRole("button", { name: "Import skill folder…", exact: true }).click();
  await page.getByRole("button", { name: "Install skill", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").filter({ hasText: "already exists" }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  evidence.checks.push("duplicate skill refused without overwriting");
  await page.screenshot({ path: NodePath.join(root, "integrations.png") });
  // Chat picker is reached from an actual draft; no provider request is sent.
  await page.evaluate(() => {
    window.location.hash = "/workspaces";
  });
  await page.getByRole("link", { name: "Fixture", exact: true }).first().hover();
  await page.getByRole("button", { name: "New session in Fixture", exact: true }).click();
  await page.getByRole("button", { name: "Add attachments", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add attachments", exact: true }).click();
  await page.getByRole("menuitem", { name: "Add Obsidian note", exact: true }).click();
  await page.getByRole("button", { name: /Aurora decision/ }).click();
  await page.getByRole("button", { name: "Attach note", exact: true }).click();
  await page.getByRole("dialog", { name: "Obsidian notes" }).waitFor({ state: "hidden" });
  await page.getByText("Aurora decision.md", { exact: true }).first().waitFor();
  await page.screenshot({ path: NodePath.join(root, "chat-attachment.png") });
  evidence.checks.push("composer picker attaches Markdown snapshot to a real draft");
  const attachments = NodePath.join(root, "Agent/AgentRuntime/userdata/attachments");
  let uploaded;
  for (let i = 0; i < 50 && !uploaded; i++) {
    for (const file of await NodeFSP.readdir(attachments).catch(() => [])) {
      if (!file.endsWith(".md")) continue;
      const value = await NodeFSP.readFile(NodePath.join(attachments, file), "utf8");
      if (value.includes(noteText) && value.includes("Obsidian vault: Fixture notes"))
        uploaded = { file, value };
    }
    if (!uploaded) await sleep(200);
  }
  NodeAssert.ok(uploaded, "The normal attachment upload persisted the Markdown snapshot");
  await NodeFSP.writeFile(
    NodePath.join(fixture, "Projects/Aurora decision.md"),
    "Changed after attachment.",
  );
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(attachments, uploaded.file), "utf8"),
    uploaded.value,
  );
  evidence.checks.push(
    "authenticated attachment upload persists exact snapshot independently of vault edits",
  );
  const sessionURL = page.url();
  const notesSection = page.getByRole("region", { name: "Notes", exact: true });
  if (!(await notesSection.isVisible()))
    await page.getByRole("button", { name: "Toggle thread details panel", exact: true }).click();
  await notesSection.getByRole("button", { name: /Aurora decision.md/ }).waitFor();
  await page.screenshot({ path: NodePath.join(root, "session-notes-list.png") });
  await notesSection.getByRole("button", { name: /Aurora decision.md/ }).click();
  const notePanel = page.getByRole("region", { name: "Obsidian note panel", exact: true });
  await notePanel.getByText("Changed after attachment.", { exact: true }).waitFor();
  await notePanel.getByRole("button", { name: "Source", exact: true }).click();
  await notePanel.getByText("Changed after attachment.", { exact: true }).waitFor();
  await NodeFSP.writeFile(
    NodePath.join(fixture, "Projects/Aurora decision.md"),
    "Live session note update.",
  );
  await notePanel.getByText("Live session note update.", { exact: true }).waitFor();
  await NodeFSP.writeFile(
    NodePath.join(fixture, "Projects/Aurora decision.md"),
    "Changed after attachment.",
  );
  await page.reload();
  await page
    .getByRole("region", { name: "Obsidian note panel", exact: true })
    .getByText("Changed after attachment.", { exact: true })
    .waitFor();
  NodeAssert.equal(page.url(), sessionURL);
  await page.screenshot({ path: NodePath.join(root, "session-notes.png") });
  if (!(await notesSection.isVisible()))
    await page.getByRole("button", { name: "Toggle thread details panel", exact: true }).click();
  await notesSection.getByRole("button", { name: /Aurora decision.md/ }).waitFor();
  evidence.checks.push(
    "session Notes list opens a persistent peer tab with source view and live vault updates",
  );

  if (liveAI) {
    await NodeFSP.writeFile(
      NodePath.join(root, "ready-for-live-turn"),
      "Fixture attachment uploaded.\n",
    );
    console.log("Waiting for live AI turn through the actual composer.");
    for (let i = 0; i < 900; i++) {
      if (
        await NodeFSP.stat(NodePath.join(root, "live-turn-complete"))
          .then(() => true)
          .catch(() => false)
      )
        break;
      if (i === 899) throw new Error("Live AI turn was not completed.");
      await sleep(1000);
    }
    const transcript = await page.locator("body").innerText();
    NodeAssert.ok(
      transcript.includes(verificationCode),
      "Live response includes the unpredictable code from the uploaded note",
    );
    NodeAssert.ok(
      transcript.toLowerCase().includes("cobalt"),
      "Live response includes the launch color from the note",
    );
    await page.screenshot({ path: NodePath.join(root, "live-ai-response.png") });
    await NodeFSP.writeFile(NodePath.join(root, "live-transcript.txt"), transcript);
    evidence.checks.push(
      "live AI response reads the uploaded note and returns its unpredictable verification code",
    );
    evidence.verificationCode = verificationCode;
  }
  await settings();
  await page.getByRole("button", { name: "Disconnect Fixture notes", exact: true }).click();
  NodeAssert.equal(
    await NodeFSP.readFile(NodePath.join(fixture, "Projects/Aurora decision.md"), "utf8"),
    "Changed after attachment.",
  );
  NodeAssert.equal(
    (await page.evaluate(() => window.desktopBridge.knowledge.listVaults())).length,
    0,
  );
  evidence.checks.push("disconnect removes access while preserving original notes");
  await NodeFSP.writeFile(
    NodePath.join(root, "chat-dom.txt"),
    await page.locator("body").innerText(),
  );
  evidence.chatPage = page.url();
  await NodeFSP.writeFile(NodePath.join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  await NodeFSP.writeFile(
    NodePath.join(root, "evidence.json"),
    JSON.stringify({ ...evidence, failure: String(error) }, null, 2),
  );
  if (page) {
    await NodeFSP.writeFile(
      NodePath.join(root, "failure-dom.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Unavailable"),
    );
    await page.screenshot({ path: NodePath.join(root, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  socket?.close();
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
  }
  if (runtimePID) {
    try {
      process.kill(runtimePID, "SIGTERM");
    } catch {}
  }
  await NodeFSP.writeFile(NodePath.join(root, "host.log"), logs);
}
