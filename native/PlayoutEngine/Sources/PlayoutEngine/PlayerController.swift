import AppKit
import AVFoundation
import ExceptionCatcher
import QuartzCore

private enum Transport: String {
    case idle
    case loading
    case ready
    case playing
    case paused
    case stopped
    case ended
}

private final class VideoView: NSView {
    let playerLayer = AVPlayerLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        playerLayer.videoGravity = .resizeAspect
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        attachLayer()
    }

    private func attachLayer() {
        guard let layer = layer, playerLayer.superlayer == nil else { return }
        layer.addSublayer(playerLayer)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layout() {
        super.layout()
        attachLayer()
        playerLayer.frame = bounds
    }
}

final class PlayerController: NSObject, NSWindowDelegate {
    private let writer: JsonLineWriter
    private let player = AVPlayer()
    private let window: NSWindow
    private let videoView: VideoView
    private var status: Transport = .idle
    private var desiredRate: Double = 1
    private var loadedPath: String?
    private var knownDuration: Double?
    private var displayIndex: Int = 0
    private var fullscreen = false
    private var loadCompletion: ((String?) -> Void)?
    /// Increments on every load so an older load's async work never attaches.
    private var loadGeneration = 0
    /// Stop or Pause received while loading: the state to settle in once ready.
    private var settleAfterLoad: Transport?
    private var endObserver: NSObjectProtocol?
    private var failedObserver: NSObjectProtocol?
    private var timeObserver: Any?
    private var playerStatusObservation: NSKeyValueObservation?
    private struct DeferredAfterLoad {
        let run: () -> Void
        let fail: (String) -> Void
        /// Starts playback (play, scheduledPlay). Pause drops these; Stop drops all.
        let starts: Bool
    }
    private var pendingAfterLoad: [DeferredAfterLoad] = []
    private var wantsFullscreen: Bool?
    private var fullscreenCompletion: (() -> Void)?
    private var fullscreenTimeout: DispatchWorkItem?
    private var fullscreenAnimating = false
    private var placedWindow = false
    private var savedFrame: NSRect?
    private var hideWhenLeavingFullscreen = false
    private var cursorHidden = false
    private var cursorIdle: DispatchWorkItem?
    private var mouseMonitor: Any?
    private var sleepObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    private var wakeRunning = false
    private var wakeWaiters: [() -> Void] = []

    init(writer: JsonLineWriter) {
        self.writer = writer
        videoView = VideoView(frame: NSRect(x: 0, y: 0, width: 960, height: 540))
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 540),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.title = "Sri Sathya Sai Parallel Playout"
        window.contentView = videoView
        videoView.autoresizingMask = [.width, .height]
        window.delegate = self
        window.collectionBehavior = [.fullScreenPrimary]
        window.isReleasedWhenClosed = false
        videoView.playerLayer.player = player
        window.acceptsMouseMovedEvents = true
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]) { [weak self] event in
            DispatchQueue.main.async {
                self?.notePointerActivity()
            }
            return event
        }
        if ProcessInfo.processInfo.environment["PLAYOUT_MUTE"] == "1" {
            player.volume = 0
        }
        player.automaticallyWaitsToMinimizeStalling = false
        center(on: 0)
        let interval = CMTime(seconds: 1, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
            guard let self = self, self.status == .playing else { return }
            self.emit(event: "position")
        }
    }

    func startup() {
        let center = NSWorkspace.shared.notificationCenter
        sleepObserver = center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emit(event: "sleep")
        }
        wakeObserver = center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.startWakeRecovery()
        }
        emit(event: "ready")
    }

    func handle(line: String) {
        guard let object = CommandProtocol.object(from: line) else {
            reply(id: nil, ok: false, type: "error", error: "Command was not valid JSON.")
            return
        }
        let id = CommandProtocol.string(object, "id")
        let type = CommandProtocol.string(object, "type") ?? ""
        switch type {
        case "load":
            guard let path = CommandProtocol.string(object, "path"), !path.isEmpty else {
                reply(id: id, ok: false, type: "error", error: "load requires a path.")
                return
            }
            load(path: path) { [weak self] error in
                if let error {
                    self?.reply(id: id, ok: false, type: "error", error: error)
                } else {
                    self?.reply(id: id, ok: true, type: "loaded")
                }
            }
        case "play":
            perform(id: id, type: "playing") { self.play() }
        case "pause":
            perform(id: id, type: "paused") { self.pause() }
        case "stop":
            stop { [weak self] error in
                if let error {
                    self?.reply(id: id, ok: false, type: "error", error: error)
                } else {
                    self?.reply(id: id, ok: true, type: "stopped")
                }
            }
        case "seek":
            guard let seconds = CommandProtocol.double(object, "seconds"), seconds >= 0 else {
                reply(id: id, ok: false, type: "error", error: "seek requires seconds >= 0.")
                return
            }
            seek(to: seconds) { [weak self] error in
                if let error {
                    self?.reply(id: id, ok: false, type: "error", error: error)
                } else {
                    self?.reply(id: id, ok: true, type: "seeked")
                }
            }
        case "setRate":
            guard let rate = CommandProtocol.double(object, "rate"), rate > 0, rate <= 4 else {
                reply(id: id, ok: false, type: "error", error: "setRate requires a rate from above 0 through 4.")
                return
            }
            perform(id: id, type: "rate") { self.setRate(rate) }
        case "getState":
            reply(id: id, ok: true, type: "state")
        case "recover":
            wakeWaiters.append { [weak self] in
                self?.reply(id: id, ok: true, type: "wake")
            }
            startWakeRecovery()
        case "inspect":
            guard let path = CommandProtocol.string(object, "path"), !path.isEmpty else {
                reply(id: id, ok: false, type: "error", error: "inspect requires a path.")
                return
            }
            inspect(path: path) { [weak self] error, duration, mediaType in
                if let error {
                    self?.reply(id: id, ok: false, type: "error", error: error)
                } else {
                    var extra: [String: Any] = ["path": path]
                    if let mediaType { extra["mediaType"] = mediaType }
                    if let duration { extra["duration"] = duration }
                    self?.reply(id: id, ok: true, type: "inspected", extra: extra)
                }
            }
        case "fullscreen":
            guard let enabled = CommandProtocol.bool(object, "enabled") else {
                reply(id: id, ok: false, type: "error", error: "fullscreen requires enabled true or false.")
                return
            }
            setFullscreen(enabled) { [weak self] in
                self?.reply(id: id, ok: true, type: "fullscreen")
            }
        case "setDisplay":
            guard let index = CommandProtocol.int(object, "displayIndex"), index >= 0 else {
                reply(id: id, ok: false, type: "error", error: "setDisplay requires a displayIndex of 0 or greater.")
                return
            }
            if let error = setDisplay(index) {
                reply(id: id, ok: false, type: "error", error: error)
            } else {
                reply(id: id, ok: true, type: "display")
            }
        case "scheduledPlay":
            scheduledPlay(
                seconds: CommandProtocol.double(object, "seconds"),
                rate: CommandProtocol.double(object, "rate"),
                hostTime: CommandProtocol.double(object, "hostTime")
            ) { [weak self] error in
                if let error {
                    self?.reply(id: id, ok: false, type: "error", error: error)
                } else {
                    self?.reply(id: id, ok: true, type: "scheduled")
                }
            }
        default:
            reply(id: id, ok: false, type: "error", error: "Unknown command: \(type)")
        }
    }

    private func perform(id: String?, type: String, _ work: () -> String?) {
        if let error = work() {
            reply(id: id, ok: false, type: "error", error: error)
        } else {
            reply(id: id, ok: true, type: type)
        }
    }

    private static let supportedExtensions: Set<String> = [
        "mp4", "mov", "m4v",
        "mp3", "wav", "aac", "m4a", "m4b", "flac", "ogg", "opus", "aiff", "aif", "caf"
    ]

    private static func mediaType(for ext: String) -> String {
        let audio: Set<String> = ["mp3", "wav", "aac", "m4a", "m4b", "flac", "ogg", "opus", "aiff", "aif", "caf"]
        return audio.contains(ext) ? "audio" : "video"
    }

    private func load(path: String, completion: @escaping (String?) -> Void) {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        if !Self.supportedExtensions.contains(ext) {
            let shown = ext.isEmpty ? "This format" : ".\(ext)"
            completion("Unable to play this file. \(shown) is not supported.")
            return
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            completion("File not found: \(path)")
            return
        }

        loadCompletion?( "Load was replaced by a newer load request.")
        loadCompletion = completion
        failPending("The command was replaced by a newer load request.")
        loadGeneration += 1
        let generation = loadGeneration
        settleAfterLoad = nil
        status = .loading
        loadedPath = path
        knownDuration = nil
        removeItemObservers()
        playerStatusObservation?.invalidate()
        playerStatusObservation = nil
        player.pause()

        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        Task {
            do {
                let playable = try await asset.load(.isPlayable)
                let duration = try await asset.load(.duration)
                await MainActor.run {
                    guard self.loadGeneration == generation else { return }
                    if !playable {
                        self.finishLoad("Unable to play this file. The selected media format or codec is not supported.")
                        return
                    }
                    self.attach(asset: asset, duration: duration.seconds, path: path)
                }
            } catch {
                await MainActor.run {
                    guard self.loadGeneration == generation else { return }
                    self.finishLoad(error.localizedDescription)
                }
            }
        }
        revealForCurrentItem()
    }

    /// Reads duration without replacing the current item, so a playlist probe does not restart playback.
    private func inspect(path: String, completion: @escaping (String?, Double?, String?) -> Void) {
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        let kind = Self.mediaType(for: ext)
        if !Self.supportedExtensions.contains(ext) {
            let shown = ext.isEmpty ? "This format" : ".\(ext)"
            completion("Unable to play this file. \(shown) is not supported.", nil, nil)
            return
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            completion("File not found: \(path)", nil, nil)
            return
        }
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        Task {
            do {
                let playable = try await asset.load(.isPlayable)
                let duration = try await asset.load(.duration)
                await MainActor.run {
                    if !playable {
                        completion("Unable to play this file. The selected media format or codec is not supported.", nil, kind)
                        return
                    }
                    let seconds = duration.seconds
                    completion(nil, seconds.isFinite && seconds >= 0 ? seconds : 0, kind)
                }
            } catch {
                await MainActor.run {
                    completion(error.localizedDescription, nil, kind)
                }
            }
        }
    }

    private func attach(asset: AVURLAsset, duration: Double, path: String) {
        removeItemObservers()
        let item = AVPlayerItem(asset: asset)
        player.replaceCurrentItem(with: item)
        knownDuration = duration.isFinite ? duration : nil
        playerStatusObservation?.invalidate()
        playerStatusObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                self?.handlePlayerStatus(item)
            }
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            self?.status = .ended
            self?.player.pause()
            self?.emit(event: "ended")
        }
        failedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] notification in
            let message = (notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription
                ?? "Playback failed before the end of the file."
            self?.emit(event: "error", error: message)
        }
        engineLog("opened \(path) duration=\(knownDuration ?? -1), waiting for readyToPlay")
    }

    private func handlePlayerStatus(_ item: AVPlayerItem) {
        guard status == .loading, item === player.currentItem else { return }
        switch item.status {
        case .readyToPlay:
            status = .ready
            engineLog("player ready")
            finishLoad(nil)
        case .failed:
            finishLoad(item.error?.localizedDescription ?? "AVPlayer could not open this file.")
        default:
            break
        }
    }

    private func failPending(_ reason: String) {
        let pending = pendingAfterLoad
        pendingAfterLoad = []
        pending.forEach { $0.fail(reason) }
    }

    /// Commands sent while loading run in the order they arrived once the item is ready.
    private func deferUntilLoaded(starts: Bool = false, run: @escaping () -> Void, fail: @escaping (String) -> Void) {
        pendingAfterLoad.append(DeferredAfterLoad(run: run, fail: fail, starts: starts))
    }

    /// Stop or Pause while loading: answer now, drop commands queued before it,
    /// and let the load finish into this state instead of waiting for it.
    private func settleWhileLoading(_ state: Transport, reason: String) {
        if state == .paused {
            // Keep a queued seek: the Master's Pause sends its position first.
            let dropped = pendingAfterLoad.filter { $0.starts }
            pendingAfterLoad = pendingAfterLoad.filter { !$0.starts }
            dropped.forEach { $0.fail(reason) }
        } else {
            failPending(reason)
        }
        settleAfterLoad = state
        player.pause()
        refreshCursor()
    }

    private func finishLoad(_ error: String?) {
        let completion = loadCompletion
        loadCompletion = nil
        if let error {
            status = .idle
            loadedPath = nil
            player.replaceCurrentItem(with: nil)
            completion?(error)
            failPending("The file could not be loaded.")
            return
        }
        if let settle = settleAfterLoad {
            settleAfterLoad = nil
            status = settle
            refreshCursor()
        }
        let pending = pendingAfterLoad
        pendingAfterLoad = []
        completion?(nil)
        pending.forEach { $0.run() }
    }

    private func play() -> String? {
        if status == .loading {
            settleAfterLoad = nil
            deferUntilLoaded(starts: true, run: { [weak self] in _ = self?.play() }, fail: { _ in })
            return nil
        }
        guard player.currentItem != nil else { return "No file is loaded." }
        player.playImmediately(atRate: Float(desiredRate))
        status = .playing
        engineLog(String(format: "play at %.2f", player.currentTime().seconds))
        refreshCursor()
        return nil
    }

    private func pause() -> String? {
        if status == .loading {
            settleWhileLoading(.paused, reason: "Paused before the file finished loading.")
            return nil
        }
        guard player.currentItem != nil else { return "No file is loaded." }
        player.pause()
        if status != .ended {
            status = .paused
        }
        engineLog(String(format: "pause at %.2f", player.currentTime().seconds))
        refreshCursor()
        return nil
    }

    /// Stops and returns the current item to 00:00. Pause does not seek.
    private func stop(completion: @escaping (String?) -> Void) {
        if status == .loading {
            // A freshly loaded item already starts at 00:00.
            settleWhileLoading(.stopped, reason: "Stopped before the file finished loading.")
            completion(nil)
            return
        }
        guard player.currentItem != nil else {
            completion("No file is loaded.")
            return
        }
        player.pause()
        status = .stopped
        refreshCursor()
        let start = CMTime(seconds: 0, preferredTimescale: 600)
        player.seek(to: start, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if !finished {
                    // A newer seek or load interrupted the return to 0. Playback
                    // is already paused, so Stop still succeeded; the newer
                    // command decides the position.
                    engineLog("stop: return to 0 interrupted by a newer command")
                    completion(nil)
                    return
                }
                self.player.pause()
                self.status = .stopped
                self.refreshCursor()
                engineLog("stop at 0")
                completion(nil)
            }
        }
    }

    private func seek(to seconds: Double, completion: @escaping (String?) -> Void) {
        if status == .loading {
            deferUntilLoaded(
                run: { [weak self] in self?.seek(to: seconds, completion: completion) },
                fail: { reason in completion(reason) }
            )
            return
        }
        guard player.currentItem != nil else {
            completion("No file is loaded.")
            return
        }
        let time = CMTime(seconds: seconds, preferredTimescale: 600)
        let wasPlaying = status == .playing
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if !finished {
                    completion("Seek did not finish.")
                    return
                }
                if self.status == .ended {
                    self.status = wasPlaying ? .playing : .paused
                }
                completion(nil)
            }
        }
    }

    private func setRate(_ rate: Double) -> String? {
        desiredRate = rate
        if status == .playing {
            player.playImmediately(atRate: Float(rate))
        }
        return nil
    }

    private func currentItemIsAudio() -> Bool {
        guard let path = loadedPath else { return false }
        let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
        let audio: Set<String> = ["mp3", "wav", "aac", "m4a", "m4b", "flac", "ogg", "opus", "aiff", "aif", "caf"]
        return audio.contains(ext)
    }

    private func finishFullscreenReply() {
        fullscreenTimeout?.cancel()
        fullscreenTimeout = nil
        let done = fullscreenCompletion
        fullscreenCompletion = nil
        done?()
    }

    /// Replies after the window has entered or left fullscreen.
    /// An already-fullscreen window does not toggle again.
    private func setFullscreen(_ enabled: Bool, completion: @escaping () -> Void) {
        if enabled && currentItemIsAudio() {
            completion()
            return
        }
        let isFull = window.styleMask.contains(.fullScreen)
        if !enabled && currentItemIsAudio() {
            hideWhenLeavingFullscreen = true
        }
        if enabled == isFull && !fullscreenAnimating {
            fullscreen = isFull
            wantsFullscreen = nil
            if hideWhenLeavingFullscreen && !isFull {
                hideWhenLeavingFullscreen = false
                window.orderOut(nil)
            }
            completion()
            return
        }
        if enabled {
            presentVideoWindow()
        }
        finishFullscreenReply()
        fullscreenCompletion = completion
        wantsFullscreen = enabled
        applyFullscreen()
        if !fullscreenAnimating {
            finishFullscreenReply()
            return
        }
        let work = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            // No enter/exit callback arrived (e.g. the window was ordered out).
            // Clear the flag so later fullscreen commands are not ignored.
            if self.fullscreenAnimating {
                engineLog("fullscreen change did not complete; resetting")
                self.fullscreenAnimating = false
                self.fullscreen = self.window.styleMask.contains(.fullScreen)
                self.wantsFullscreen = nil
            }
            self.finishFullscreenReply()
        }
        fullscreenTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    private var hidesCursorForPlayback: Bool {
        window.styleMask.contains(.fullScreen) && status == .playing && !currentItemIsAudio()
    }

    private func notePointerActivity() {
        showCursor()
        cursorIdle?.cancel()
        guard hidesCursorForPlayback else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.hideCursorIfNeeded()
        }
        cursorIdle = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: work)
    }

    private func hideCursorIfNeeded() {
        guard hidesCursorForPlayback else {
            showCursor()
            return
        }
        if !cursorHidden {
            NSCursor.hide()
            cursorHidden = true
        }
    }

    private func showCursor() {
        cursorIdle?.cancel()
        cursorIdle = nil
        if cursorHidden {
            NSCursor.unhide()
            cursorHidden = false
        }
    }

    private func refreshCursor() {
        if hidesCursorForPlayback {
            hideCursorIfNeeded()
        } else {
            showCursor()
        }
    }

    private func applyFullscreen() {
        guard !fullscreenAnimating, let wants = wantsFullscreen else { return }
        let isFull = window.styleMask.contains(.fullScreen)
        fullscreen = isFull
        if wants == isFull {
            wantsFullscreen = nil
            return
        }
        fullscreenAnimating = true
        placeOnSelectedDisplay()
        window.toggleFullScreen(nil)
    }

    /// Fullscreen uses whichever screen this Mac has selected. The window is
    /// moved only when it is on a different screen, so its size is unchanged.
    private func placeOnSelectedDisplay() {
        guard let screen = DisplayController.screen(at: displayIndex) else { return }
        if window.screen == screen { return }
        if window.styleMask.contains(.fullScreen) { return }
        let visible = screen.visibleFrame
        let size = window.frame.size
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.midY - size.height / 2
        )
        window.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    private func setDisplay(_ index: Int) -> String? {
        guard let screen = DisplayController.screen(at: index) else {
            return "No display at index \(index)."
        }
        displayIndex = index
        if window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)
        }
        window.setFrame(screen.visibleFrame, display: true)
        savedFrame = window.frame
        placedWindow = true
        if !currentItemIsAudio() && !window.isVisible {
            window.orderFront(nil)
        }
        return nil
    }

    private func scheduledPlay(seconds: Double?, rate: Double?, hostTime: Double?, completion: @escaping (String?) -> Void) {
        guard player.currentItem != nil || status == .loading else {
            completion("No file is loaded.")
            return
        }
        if let rate {
            if rate <= 0 || rate > 4 {
                completion("scheduledPlay rate must be from above 0 through 4.")
                return
            }
            desiredRate = rate
        }
        if status == .loading {
            settleAfterLoad = nil
            deferUntilLoaded(
                starts: true,
                run: { [weak self] in
                    self?.scheduledPlay(seconds: seconds, rate: rate, hostTime: hostTime, completion: completion)
                },
                fail: { reason in completion(reason) }
            )
            return
        }
        let itemSeconds = seconds ?? currentSeconds()
        let itemTime = CMTime(seconds: itemSeconds, preferredTimescale: 600)
        let playRate = Float(desiredRate)
        if player.currentItem?.status != .readyToPlay {
            if status == .loading {
                deferUntilLoaded(
                    run: { [weak self] in
                        self?.scheduledPlay(seconds: seconds, rate: rate, hostTime: hostTime, completion: completion)
                    },
                    fail: { reason in completion(reason) }
                )
                return
            }
            completion("AVPlayer is not ready for scheduled playback.")
            return
        }
        if let hostTime, hostTime > CACurrentMediaTime() + 0.02 {
            let host = CMTime(seconds: hostTime, preferredTimescale: 60_000)
            let failure = PPTry {
                self.player.setRate(playRate, time: itemTime, atHostTime: host)
            }
            if let failure {
                completion(failure)
                return
            }
            status = .playing
            engineLog(String(format: "scheduled play at %.2f, host %.3f", itemTime.seconds, hostTime))
            completion(nil)
            return
        }
        player.seek(to: itemTime, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if !finished {
                    completion("Scheduled seek did not finish.")
                    return
                }
                self.player.playImmediately(atRate: playRate)
                self.status = .playing
                engineLog(String(format: "scheduled play at %.2f, immediate", itemTime.seconds))
                completion(nil)
            }
        }
    }

    /// Video keeps the window that is already on screen. Audio does not open one.
    private func revealForCurrentItem() {
        if currentItemIsAudio() {
            concealWindow()
            return
        }
        presentVideoWindow()
    }

    private func presentVideoWindow() {
        if window.styleMask.contains(.fullScreen) { return }
        if let savedFrame, placedWindow {
            if !framesMatch(window.frame, savedFrame) {
                window.setFrame(savedFrame, display: true)
            }
        } else {
            center(on: displayIndex)
            placedWindow = true
            savedFrame = window.frame
        }
        if !window.isVisible {
            window.orderFront(nil)
        }
    }

    private func concealWindow() {
        if window.styleMask.contains(.fullScreen) {
            hideWhenLeavingFullscreen = true
            wantsFullscreen = false
            if !fullscreenAnimating {
                applyFullscreen()
            }
            return
        }
        window.orderOut(nil)
    }

    private func rememberFrame() {
        guard window.isVisible, !fullscreenAnimating, !window.styleMask.contains(.fullScreen) else { return }
        let frame = window.frame
        guard frame.width > 1, frame.height > 1 else { return }
        savedFrame = frame
        placedWindow = true
    }

    private func framesMatch(_ left: NSRect, _ right: NSRect) -> Bool {
        abs(left.origin.x - right.origin.x) < 0.5 &&
            abs(left.origin.y - right.origin.y) < 0.5 &&
            abs(left.size.width - right.size.width) < 0.5 &&
            abs(left.size.height - right.size.height) < 0.5
    }

    private func showWindow() {
        presentVideoWindow()
    }

    private func center(on index: Int) {
        let screen = DisplayController.screen(at: index) ?? NSScreen.main
        guard let screen else { return }
        let visible = screen.visibleFrame
        let size = NSSize(width: min(960, visible.width), height: min(540, visible.height))
        let origin = NSPoint(
            x: visible.midX - size.width / 2,
            y: visible.midY - size.height / 2
        )
        window.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    private func currentSeconds() -> Double {
        let seconds = player.currentTime().seconds
        if seconds.isFinite, seconds >= 0 { return seconds }
        return 0
    }

    /// Read the live AVPlayer after sleep. Incomplete media is stopped instead of reported as playing.
    private func startWakeRecovery() {
        if wakeRunning { return }
        wakeRunning = true
        recoverAfterWake(attempt: 0)
    }

    private func recoverAfterWake(attempt: Int) {
        let item = player.currentItem
        let path = loadedPath
        let seconds = player.currentTime().seconds
        let itemDuration = item?.duration.seconds
        let duration = itemDuration?.isFinite == true ? itemDuration : knownDuration
        let rate = Double(player.rate)
        let active = status == .playing || status == .paused || status == .ready || status == .stopped || status == .ended
        if !active {
            finishWakeRecovery()
            return
        }
        let timeReady = seconds.isFinite && seconds >= 0
        let durationReady = duration?.isFinite == true && (duration ?? 0) > 0
        let itemReady = item != nil && path != nil && !(path ?? "").isEmpty
        let needsDuration = status == .playing || status == .paused || status == .ended
        if itemReady && timeReady && (!needsDuration || durationReady) {
            if status == .playing && rate <= 0.01 {
                if attempt < 8 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                        self?.recoverAfterWake(attempt: attempt + 1)
                    }
                    return
                }
                status = .paused
            }
            finishWakeRecovery()
            return
        }
        if attempt < 8 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.recoverAfterWake(attempt: attempt + 1)
            }
            return
        }
        player.pause()
        if player.currentItem != nil {
            stop { [weak self] _ in
                self?.emit(event: "error", error: "Playback could not be restored after wake.")
                self?.finishWakeRecovery()
            }
            return
        }
        status = .idle
        loadedPath = nil
        emit(event: "error", error: "Playback could not be restored after wake.")
        finishWakeRecovery()
    }

    private func finishWakeRecovery() {
        wakeRunning = false
        emit(event: "wake")
        let waiters = wakeWaiters
        wakeWaiters = []
        waiters.forEach { $0() }
    }

    private func jsonNumber(_ value: Double) -> Any {
        value.isFinite ? value : NSNull()
    }

    private func stateDictionary() -> [String: Any] {
        let duration = knownDuration ?? player.currentItem?.duration.seconds
        let finiteDuration: Any = (duration?.isFinite == true && (duration ?? 0) >= 0) ? duration! : NSNull()
        let actual = Double(player.rate)
        return [
            "path": loadedPath ?? NSNull(),
            "position": currentSeconds(),
            "duration": finiteDuration,
            "status": status.rawValue,
            "rate": jsonNumber(desiredRate),
            "actualRate": actual.isFinite ? actual : 0,
            "fullscreen": window.styleMask.contains(.fullScreen),
            "windowX": Int(window.frame.origin.x.rounded()),
            "windowY": Int(window.frame.origin.y.rounded()),
            "windowWidth": Int(window.frame.width.rounded()),
            "windowHeight": Int(window.frame.height.rounded()),
            "windowVisible": window.isVisible,
            "cursorHidden": cursorHidden,
            "displayIndex": displayIndex,
            "hostTime": CACurrentMediaTime(),
            "displays": DisplayController.list()
        ]
    }

    private func reply(id: String?, ok: Bool, type: String, error: String? = nil, extra: [String: Any] = [:]) {
        var object: [String: Any] = [
            "ok": ok,
            "type": type,
            "state": stateDictionary()
        ]
        if let id { object["id"] = id }
        if let error { object["error"] = error }
        for (key, value) in extra {
            object[key] = value
        }
        writer.write(object)
    }

    private func emit(event: String, error: String? = nil) {
        var object: [String: Any] = [
            "type": "event",
            "event": event,
            "state": stateDictionary()
        ]
        if let error { object["error"] = error }
        writer.write(object)
    }

    private func removeItemObservers() {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        if let failedObserver {
            NotificationCenter.default.removeObserver(failedObserver)
            self.failedObserver = nil
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        fullscreenAnimating = false
        fullscreen = true
        finishFullscreenReply()
        emit(event: "fullscreen")
        DispatchQueue.main.async { [weak self] in
            self?.applyFullscreen()
            self?.refreshCursor()
        }
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        fullscreenAnimating = false
        fullscreen = window.styleMask.contains(.fullScreen)
        wantsFullscreen = nil
        engineLog("fullscreen: failed to enter")
        finishFullscreenReply()
        emit(event: "fullscreen")
    }

    func windowDidFailToExitFullScreen(_ window: NSWindow) {
        fullscreenAnimating = false
        fullscreen = window.styleMask.contains(.fullScreen)
        wantsFullscreen = nil
        engineLog("fullscreen: failed to exit")
        finishFullscreenReply()
        emit(event: "fullscreen")
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        fullscreenAnimating = false
        fullscreen = false
        finishFullscreenReply()
        showCursor()
        rememberFrame()
        if hideWhenLeavingFullscreen {
            hideWhenLeavingFullscreen = false
            window.orderOut(nil)
        }
        emit(event: "fullscreen")
        DispatchQueue.main.async { [weak self] in
            self?.applyFullscreen()
            self?.refreshCursor()
        }
    }

    func windowDidMove(_ notification: Notification) {
        rememberFrame()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        rememberFrame()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        rememberFrame()
    }

    deinit {
        if let sleepObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver)
        }
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
        if let mouseMonitor {
            NSEvent.removeMonitor(mouseMonitor)
        }
        if cursorHidden {
            NSCursor.unhide()
        }
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        playerStatusObservation?.invalidate()
        removeItemObservers()
    }
}
