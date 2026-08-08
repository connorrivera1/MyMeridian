/*
 * webshot — offscreen WKWebView page capture.
 *
 * The in-app browser pane can't be relied on for pixels: a hidden pane never
 * advances animation frames, so entrance animations hold the page at
 * opacity 0 and screenshots come back as flat sky. This renders the page in a
 * real (offscreen) WKWebView instead, jumps every CSS animation to its end
 * state, and snapshots at the window's backing scale.
 *
 *   swift scripts/webshot.swift <url> <out.png> <width> <height> [waitMs] [scrollY]
 */

import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 5,
      let url = URL(string: args[1]),
      let width = Double(args[3]),
      let height = Double(args[4])
else {
    print("usage: swift webshot.swift <url> <out.png> <width> <height> [waitMs] [scrollY]")
    exit(64)
}
let outPath = args[2]
let waitMs = args.count > 5 ? (Double(args[5]) ?? 1600) : 1600
let scrollY = args.count > 6 ? (Double(args[6]) ?? 0) : 0
let theme = args.count > 7 ? args[7] : ""

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let webView = WKWebView(
    frame: NSRect(x: 0, y: 0, width: width, height: height),
    configuration: WKWebViewConfiguration()
)

// A borderless window parked far offscreen: WKWebView only paints when it is
// in a window, and `orderBack` keeps it out of the user's way.
let window = NSWindow(
    contentRect: NSRect(x: -4000, y: -4000, width: width, height: height),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.orderBack(nil)

// Scroll first, then settle every animation at its final frame. Finished
// animations with fill:both hold their end state; infinite ones just pause so
// the snapshot catches a stable frame of them.
let freezeScript = """
(function () {
  if ("THEME".length) document.documentElement.dataset.theme = "THEME";
  // The splash rides its own React timers; frozen mid-sequence it would sit
  // over every capture, so it goes.
  document.querySelector(".splash")?.remove();
  window.scrollTo(0, SCROLL_Y);
  const settle = () => {
    document.getAnimations({ subtree: true }).forEach((a) => {
      try {
        const t = a.effect && a.effect.getComputedTiming();
        if (t && t.iterations !== Infinity && Number.isFinite(t.endTime)) {
          a.pause();
          a.currentTime = t.endTime;
        } else {
          a.pause();
        }
      } catch (e) {}
    });
  };
  settle();
  // A second pass catches animations whose delay had not started them yet.
  setTimeout(settle, 60);
  return true;
})()
"""
.replacingOccurrences(of: "SCROLL_Y", with: String(scrollY))
.replacingOccurrences(of: "THEME", with: theme)

final class Delegate: NSObject, WKNavigationDelegate {
    let onFinish: () -> Void
    init(_ onFinish: @escaping () -> Void) { self.onFinish = onFinish }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onFinish()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("navigation failed: \(error.localizedDescription)")
        exit(1)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("load failed: \(error.localizedDescription)")
        exit(1)
    }
}

let delegate = Delegate {
    // Give loaders, fonts and chart draws time to arrive before freezing.
    DispatchQueue.main.asyncAfter(deadline: .now() + waitMs / 1000) {
        webView.evaluateJavaScript(freezeScript) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                let config = WKSnapshotConfiguration()
                config.rect = NSRect(x: 0, y: 0, width: width, height: height)
                webView.takeSnapshot(with: config) { image, error in
                    guard
                        let image,
                        let tiff = image.tiffRepresentation,
                        let rep = NSBitmapImageRep(data: tiff),
                        let png = rep.representation(using: .png, properties: [:])
                    else {
                        print("snapshot failed: \(error?.localizedDescription ?? "unknown")")
                        exit(1)
                    }
                    do {
                        try png.write(to: URL(fileURLWithPath: outPath))
                        print("saved \(outPath) (\(Int(image.size.width))x\(Int(image.size.height)) points)")
                        exit(0)
                    } catch {
                        print("write failed: \(error.localizedDescription)")
                        exit(1)
                    }
                }
            }
        }
    }
}

webView.navigationDelegate = delegate
webView.load(URLRequest(url: url))

// Watchdog: a page that never finishes loading should fail loudly, not hang.
DispatchQueue.main.asyncAfter(deadline: .now() + 45) {
    print("timed out waiting for the page")
    exit(1)
}

app.run()
