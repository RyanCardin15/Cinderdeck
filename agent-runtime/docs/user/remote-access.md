# Connect the Cinderdeck companion

Cinderdeck runs its private agent runtime inside the native macOS app. Keep Cinderdeck open on the execution computer while using its mobile companion. Install the complete app using the [installation guide](./install.md).

## Pair a device

In Cinderdeck, open **Settings → Connections** and create a link under **Pairing links**. Enable the network access appropriate for your private network or tailnet. Scan the QR code with the companion, or paste the link into its environment connection screen.

Use a fresh one-time link for each device. Pairing authorizes future connections; links can be copied only from the client that created them while its Connections page remains open. If the page is closed or reloaded, create a new link.

A loopback address such as `127.0.0.1` reaches only the device opening the link. A companion on another device needs an address it can reach. Both devices must be on the same private network, or on a configured tailnet. If Tailscale HTTPS is configured, its link uses a hostname such as `https://machine.tailnet.ts.net/`.

## Choose where a thread runs

Connection settings and provider settings belong to the selected execution computer. The runtime uses that computer's configured provider home and authentication. The companion keeps its manual environment selection. Existing threads remain on their original execution computer.

If the host cannot be reached, check that Cinderdeck is running and that the network address in the link is reachable from the companion. Reopen **Settings → Connections** to inspect or revoke paired access. Provider authentication is separate from device pairing: configure providers on the execution computer.

## Runtime development

Use the [private runtime development instructions](../../AGENTS.md) with explicit disposable state. This runtime has no separately released CLI, hosted account service, browser product or standalone desktop installer. App updates are whole-app updates owned by Cinderdeck's native host; see [manual releases](../../../docs/RELEASES.md).
