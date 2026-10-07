// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  copilotMcpServerFromWire,
  copilotMcpToolsFromWire,
  listCopilotMcpServers,
} from "./CopilotMcpInventory.ts";

const fixture = `#!${process.execPath}
import fs from 'node:fs';
let buffer = Buffer.alloc(0);
function send(value) {
 const body = JSON.stringify(value);
 const frame = Buffer.from('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body);
 process.stdout.write(frame.subarray(0, 7)); process.stdout.write(frame.subarray(7));
}
process.stdin.on('data', chunk => {
 buffer = Buffer.concat([buffer,chunk]);
 for (;;) {
  const index=buffer.indexOf('\\r\\n\\r\\n'); if(index<0)return;
  const length=Number(buffer.subarray(0,index).toString().split(':')[1]);
  if(buffer.length<index+4+length)return;
  const request=JSON.parse(buffer.subarray(index+4,index+4+length));buffer=buffer.subarray(index+4+length);
  if(!request.method)continue;
  fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify(request)+'\\n');
  let result={};
  switch(request.method) {
   case 'ping': result={protocolVersion:3};break;
   case 'session.create': result={sessionId:request.params.sessionId};break;
   case 'session.mcp.list': result={servers:[{name:'docs',status:'connected',source:'user',url:'https://secret:token@example.test/mcp?key=value'},{name:'broken',status:'failed',error:'secret-value'},{name:'deckhand',status:'connected'}]};break;
   case 'session.mcp.listTools': result={tools:[{name:'read',description:'Find a document'}]};break;
   case 'session.destroy': case 'session.delete': result={success:true};break;
   default: send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'unsupported'}});continue;
  }
  send({jsonrpc:'2.0',method:'session.event',params:{ignored:true}});
  send({jsonrpc:'2.0',id:request.id,result});
 }
});
`;

describe("Copilot MCP protocol inventory", () => {
  it("normalizes metadata without credential URLs, raw errors or internal servers", () => {
    expect(
      copilotMcpServerFromWire(
        {
          name: "docs",
          status: "connected",
          source: "plugin",
          url: "https://user:password@example.test/mcp?token=secret",
        },
        [],
      ),
    ).toMatchObject({
      name: "docs",
      source: "plugin",
      origin: "example.test",
      status: "connected",
    });
    expect(copilotMcpServerFromWire({ name: "deckhand", status: "connected" }, [])).toBeUndefined();
    expect(copilotMcpServerFromWire({ name: "auth", status: "needs-auth" }, [])?.status).toBe(
      "needsAuth",
    );
    expect(
      JSON.stringify(
        copilotMcpServerFromWire({ name: "bad", status: "failed", error: "private-token" }, []),
      ),
    ).not.toContain("private-token");
    expect(
      copilotMcpToolsFromWire({
        tools: [{ name: "read" }, { name: "search", description: "Find" }],
      }),
    ).toEqual([{ name: "read" }, { name: "search", description: "Find" }]);
  });

  it.effect(
    "uses a disposable no-prompt session, handles split frames and deletes only its session",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cinderdeck-copilot-mcp-test-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const command = NodePath.join(root, "fixture.mjs");
        const calls = NodePath.join(root, "calls.jsonl");
        yield* Effect.promise(() => NodeFSP.writeFile(command, fixture, { mode: 0o700 }));
        const result = yield* listCopilotMcpServers({
          command,
          cwd: root,
          environment: { ...process.env, HOME: root, COPILOT_HOME: root, FIXTURE_CALLS: calls },
        });
        expect(result).toMatchObject([
          { name: "broken", status: "failed" },
          { name: "docs", origin: "example.test", tools: [{ name: "read" }] },
        ]);
        expect(JSON.stringify(result)).not.toMatch(/secret|token/);
        const logged = yield* Effect.promise(() => NodeFSP.readFile(calls, "utf8"));
        const requests = logged
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(requests.map((request) => request.method)).toEqual([
          "ping",
          "session.create",
          "session.mcp.list",
          "session.mcp.listTools",
          "session.destroy",
          "session.delete",
        ]);
        const sessionId = requests[1].params.sessionId;
        expect(requests.slice(2).every((request) => request.params.sessionId === sessionId)).toBe(
          true,
        );
        expect(requests[1].params.tools).toEqual([]);
        expect(requests[1].params.enableConfigDiscovery).toBe(true);
      }).pipe(Effect.scoped),
  );
});
