// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "sulla-runtime",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "sulla-runtime", targets: ["SullaRuntime"])],
    targets: [
        .executableTarget(
            name: "SullaRuntime",
            path: "Sources/SullaRuntime",
            swiftSettings: [.enableUpcomingFeature("BareSlashRegexLiterals")]
        ),
    ]
)
