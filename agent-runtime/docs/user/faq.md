# FAQ

## Is Cinderdeck a harness?

No. A harness is what turns an LLM into an agent: it gives the model tools, a way to call them, runs them, and hands the results back. Claude Code is kind of a harness. It is an interface (the TUI, the Code tab in the desktop app) plus a harness underneath (the Anthropic Agent SDK). Codex is the same split: the app plus the Codex App Server. Cinderdeck uses those harnesses. It is not a harness, and it does not work without one.

Chef = LLM. Kitchen = harness. Cinderdeck = the restaurant that lets you bring whatever kitchen you want. Our MCP is a cookbook we hand the kitchen, but the chef won't open it unless you tell them to :) I wrote the long version here: [What is a harness?](https://cinderdeck.gg/blog/post/what-is-a-harness)

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Kiro, Pi, Muse Code, or fx. [Provider setup](./install.md#providers)

## Why use Cinderdeck instead of Claude Code or the Codex app?

We were inspired by the Codex desktop app, Conductor, Claude Desktop, and Cursor Glass, but none met our bar. What you get:

- Bring your own sub. Claude, Codex, and whatever else you already have installed.
- Best in class remote. Run `cinderdeck up` on any box and drive it from anywhere.
- Best in class mobile app.
- Truly 100% open source. If we go the wrong direction, fork it.

Every harness feels nearly identical in here, so you can stop worrying about harnesses and focus on building :) [Install](./install.md)

## Can I use Cinderdeck with my Claude Code subscription?

Yes.

## How much does Cinderdeck cost?

Nothing. There's no way to pay us to use Cinderdeck. You bring your own sub. It is free and open source (MIT). You still pay your provider like you already do. Cinderdeck Connect is free too, for now. Every account can connect up to 3 machines running Cinderdeck. Phones and browsers that connect to them do not count. Need more? Link a paid Cinderdeck Chat account. [More machines](#can-i-connect-more-than-3-machines-with-t3-connect) We don't want to charge for this, but if the bill gets unacceptable we may have to change course. If you hit limits or have issues, you can always fork it, self host, or use Tailscale. [Install](./install.md)

## Can I connect more than 3 machines with Cinderdeck Connect?

Yes. Link your Cinderdeck Chat account and Cinderdeck Connect raises your limit: up to 10 machines with Cinderdeck Chat Pro, or 100 with Premier. Open your account menu in Cinderdeck, go to **Cinderdeck Chat**, and select **Link Cinderdeck Chat**. Sign in to Cinderdeck Chat and approve. The free Cinderdeck Chat plan keeps the normal limit of 3. [More machines with Cinderdeck Chat](./remote-access.md#more-machines-with-t3-chat)

## Why is my Claude 5-hour limit draining so fast?

It shouldn't anymore. Cinderdeck drives Claude through Anthropic's Agent SDK, and Anthropic's 5h meter used to charge Agent SDK usage about 1.7x more than using Claude Code directly. Weekly limits were never affected. Since v0.1.7, Claude in Cinderdeck drains your 5h limit at the same rate as Claude Code. Still seeing it? [Update Cinderdeck](./updating.md) on the machine that runs your agents. [My post on it](https://x.com/theo/status/2114166439813017873) · [Tracking issue](https://github.com/RyanCardin15/Cinderdeck/issues/24649)

## How do I use Cinderdeck remotely?

Your agents run wherever Cinderdeck runs: your desktop, a server, a VPS. You connect to it from anywhere. I do this constantly. Less than 5% of my prompts run on my laptop. Run `cinderdeck up` on that machine and you get really good remote support. Cinderdeck Connect is the easy path. LAN pairing and Tailscale work too, and [app.cinderdeck.codes](https://app.cinderdeck.codes) is the web client. [Remote access](./remote-access.md)

## How do I use Cinderdeck on my phone?

Get the [iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Android](https://play.google.com/store/apps/details?id=com.ryancardin.cinderdeck) app, then connect it to your computer with Cinderdeck Connect or a pairing link. The phone is a remote. Your computer does the work and needs to stay on. [Mobile setup](./install.md#mobile-app) · [Remote access](./remote-access.md)

## Why does Cinderdeck Connect keep disconnecting?

Cinderdeck Connect is our built-in alternative to Tailscale for remote connections. If it keeps dropping, open **Settings > Environments**, find the machine, and select **Details**. The first part marked as failed is the cause. I will not be disappointed if you set up Tailscale as a fallback (I do this personally). [Cinderdeck Connect troubleshooting](./cinderdeck-connect-troubleshooting.md)

## Will I get banned for using my subscription?

No. We work with all of the labs and Cinderdeck is within the TOS of Claude Code, Codex, and Google Antigravity. We worked directly with [SpaceXAI](https://x.com/SpaceXSI/status/2070195830192320600) to collaborate on the Grok Build and Cursor integrations. Everything else uses official ACP bindings.

If it works in Cinderdeck, you can trust it is safe.

## Can I add a bunch of accounts for one provider?

I don't think Cinderdeck is the right place to manage a pile of accounts. If we add an auto-switcher, we are risking TOS bans for our users.

A separate work account is fine. Setup for two: [Codex](./providers-codex.md#use-multiple-accounts) · [Claude](./providers-claude.md#separate-accounts-or-configurations). For a bigger pool, manage them outside Cinderdeck with a self-hosted proxy like [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). After you set up a hub, Cinderdeck can show its pooled limits under Usage. [Connect a hub](./usage.md#connect-a-cliproxyapi-hub)

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a full OpenRouter recipe. Your subscription setup stays untouched. [OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## Does Cinderdeck support local models?

No. Cinderdeck is a serious developer tool. Locally runnable models are not capable of meaningful engineering work.

## Does my code go to Cinderdeck servers?

No. Your code and prompts go from your machine to your provider (Anthropic, OpenAI, etc.), not to us. With Cinderdeck Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine). Our relay sets up the link. It does not proxy your HTTP or WebSocket sessions. Cinderdeck does send basic product usage events (provider, model, token totals, that kind of thing). No prompts, no file contents. That is the same on Tailscale, LAN, or Cinderdeck Connect. Set `T3CODE_TELEMETRY_ENABLED=false` if you want it off. [Product usage data](./telemetry.md)

## Worktrees are eating my disk. How do I clean them up?

Open **Settings → Worktrees → Cleanup** and turn on automatic worktree cleanup. You can also run it now from there. Worktrees add up fast. One user cleared 500 GB. [Storage cleanup](./project-settings.md#storage-cleanup)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default; you can opt in to a paired environment instead. Web and desktop require you to choose an environment first. The transcript goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes, all three. Desktop app, CLI, the works. One catch: there is no `cinderdeck` binary for Intel Macs, so use the desktop app there. Windows folks can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server. (Not your phone. The computer.) Log in on that machine first, like `codex login` or `claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version managers love to cause this one. [Provider setup](./install.md#providers)
