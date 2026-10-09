import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let writer = JsonLineWriter()
    private var player: PlayerController?
    private var allowQuit = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let player = PlayerController(writer: writer)
        self.player = player
        player.startup()
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willPowerOffNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.allowQuit = true
        }
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty { continue }
                DispatchQueue.main.async {
                    player.handle(line: trimmed)
                }
            }
            DispatchQueue.main.async {
                self.allowQuit = true
                NSApp.terminate(nil)
            }
        }
    }

    /// Parallel Playout owns this process and closes stdin when it quits.
    /// A Quit sent to the helper alone would leave the app without a player.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        allowQuit ? .terminateNow : .terminateCancel
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

private let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
