import AppKit

enum DisplayController {
    static func list() -> [[String: Any]] {
        NSScreen.screens.enumerated().map { index, screen in
            let frame = screen.frame
            return [
                "index": index,
                "name": screen.localizedName,
                "width": Int(frame.width),
                "height": Int(frame.height)
            ]
        }
    }

    static func screen(at index: Int) -> NSScreen? {
        let screens = NSScreen.screens
        guard index >= 0, index < screens.count else { return nil }
        return screens[index]
    }
}
