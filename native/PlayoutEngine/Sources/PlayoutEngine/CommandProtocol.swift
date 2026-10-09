import Foundation

/// Newline-delimited JSON between Electron and this process.
///
/// Commands: load, play, pause, stop, seek, setRate, getState, fullscreen,
/// setDisplay, scheduledPlay.
///
/// scheduledPlay fields, all optional:
/// - seconds: item time to be at when playback starts
/// - rate: playback rate to apply
/// - hostTime: CACurrentMediaTime() value when that item time should be true
///
/// Stop pauses transport and returns the current item to 00:00. Pause does not seek.

enum CommandProtocol {
    static func object(from line: String) -> [String: Any]? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object
    }

    static func string(_ object: [String: Any], _ key: String) -> String? {
        object[key] as? String
    }

    static func double(_ object: [String: Any], _ key: String) -> Double? {
        if let number = object[key] as? NSNumber {
            let value = number.doubleValue
            return value.isFinite ? value : nil
        }
        return nil
    }

    static func int(_ object: [String: Any], _ key: String) -> Int? {
        guard let number = object[key] as? NSNumber else { return nil }
        return number.intValue
    }

    static func bool(_ object: [String: Any], _ key: String) -> Bool? {
        guard let number = object[key] as? NSNumber else { return nil }
        return number.boolValue
    }
}

final class JsonLineWriter {
    private let lock = NSLock()

    func write(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let line = String(data: data, encoding: .utf8) else {
            return
        }
        lock.lock()
        fputs(line + "\n", stdout)
        fflush(stdout)
        lock.unlock()
    }
}

func engineLog(_ message: String) {
    fputs(message + "\n", stderr)
    fflush(stderr)
}
