import AppKit
import Foundation
import WebKit

// Acceptance-only host. This file is never included in the shipping helper.
// Office APIs are explicitly simulated; the WKWebView and Web Inspector are real.
final class Delegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate
{
  var window: NSWindow!
  var web: WKWebView!
  let receipt = CommandLine.arguments[1]
  func record(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
      try? data.write(to: URL(fileURLWithPath: receipt), options: .atomic)
    }
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    // AppKit editing shortcuts use the host's normal Edit menu.
    let menu = NSMenu()
    let applicationItem = NSMenuItem()
    let applicationMenu = NSMenu(title: "Mac WebKit Test Host")
    applicationMenu.addItem(
      NSMenuItem(title: "Quit Test Host", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    applicationItem.submenu = applicationMenu
    menu.addItem(applicationItem)
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: "Edit")
    for (title, action, key) in [
      ("Select All", "selectAll:", "a"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"),
      ("Cut", "cut:", "x"), ("Undo", "undo:", "z"),
    ] {
      submenu.addItem(
        NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key))
    }
    edit.submenu = submenu
    menu.addItem(edit)
    NSApp.mainMenu = menu
    UserDefaults.standard.register(defaults: ["WebKitDeveloperExtras": true])
    let config = WKWebViewConfiguration()
    config.preferences.setValue(true, forKey: "developerExtrasEnabled")
    config.userContentController.add(self, name: "fixture")
    web = WKWebView(frame: .zero, configuration: config)
    web.isInspectable = true
    web.navigationDelegate = self
    window = NSWindow(
      contentRect: NSRect(x: 100, y: 240, width: 720, height: 540),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.title = "Mac WebKit Test Host — Office simulated"
    window.contentView = web
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    web.loadHTMLString(
      """
      <!doctype html><html><head><meta charset="utf-8"><title>Mac add-in fixture</title><style>
      body{font:16px -apple-system;background:#f4f7f5;padding:30px;color:#143124}small{color:#537466}h1{font-size:30px}button{padding:14px 22px;background:#187144;color:white;border:0;border-radius:8px;font-size:16px}input{padding:14px;border:1px solid #bdccbf;border-radius:8px;font-size:16px}#count{font-size:48px;color:#187144;margin:25px 0}.card{padding:24px;background:white;border:1px solid #cbd8cf;border-radius:12px}
      </style></head><body><small>REAL WKWEBVIEW · OFFICE APIS SIMULATED</small><h1>Mac external debugging fixture</h1><div class="card"><p id="count">Updates: 0</p><button id="update" onclick="updateWorkbook()">Update test workbook</button><p><input id="note" placeholder="Type a test note" oninput="report()"></p></div><p>Open this host’s real Web Inspector to debug it.</p><script>
      window.Office={context:{host:'FixtureExcel'}};window.Excel={simulated:true};let count=0;
      function report(){window.webkit.messageHandlers.fixture.postMessage({count,note:document.getElementById('note').value})}
      function updateWorkbook(){
        const localValue = 42;
        count += 1;
        document.getElementById('count').textContent='Updates: '+count;
        console.log('Simulated workbook update', count, localValue);
        report();
        return localValue;
      }
      console.log('Real WebKit runtime; Office APIs are simulated');report();
      </script></body></html>
      """, baseURL: URL(string: "https://fixture.invalid"))
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // Test-only SPI opens the fixture's own Inspector so the unattended test
    // need not navigate a user's Safari preferences or change Excel settings.
    let selector = NSSelectorFromString("_inspector")
    if webView.responds(to: selector),
      let inspector = webView.perform(selector)?.takeUnretainedValue() as? NSObject
    {
      inspector.perform(NSSelectorFromString("show"))
      inspector.perform(NSSelectorFromString("detach"))
    }
    record([
      "ready": true, "pid": ProcessInfo.processInfo.processIdentifier,
      "windowID": window.windowNumber, "count": 0, "note": "",
    ])
  }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    var body = message.body as? [String: Any] ?? [:]
    body["ready"] = true
    body["pid"] = ProcessInfo.processInfo.processIdentifier
    body["windowID"] = window.windowNumber
    record(body)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Delegate()
app.delegate = delegate
app.run()
