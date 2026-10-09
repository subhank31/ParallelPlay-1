// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PlayoutEngine",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "PlayoutEngine", targets: ["PlayoutEngine"])
    ],
    targets: [
        .target(
            name: "ExceptionCatcher",
            path: "Sources/ExceptionCatcher",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "PlayoutEngine",
            dependencies: ["ExceptionCatcher"],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("AppKit"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("QuartzCore")
            ]
        )
    ]
)
