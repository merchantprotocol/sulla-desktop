// swift-tools-version: 5.9
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
