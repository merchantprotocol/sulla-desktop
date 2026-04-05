#!/usr/bin/env swift
//
// set-system-device.swift — sets the macOS default input or output device.
//
// Usage:
//   swift set-system-device.swift --output "MacBook Air Speakers"
//   swift set-system-device.swift --input "MacBook Air Microphone"
//
// Matches by device name (substring match, case-insensitive).
// Exits 0 on success, 1 on failure.
//

import CoreAudio
import Foundation

// MARK: - Helpers

func getAllDevices() -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var devices = [AudioObjectID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices)
    return devices
}

func getDeviceName(_ id: AudioObjectID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name)
    return status == noErr ? name as String : nil
}

func getDeviceUID(_ id: AudioObjectID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &uid)
    return status == noErr ? uid as String : nil
}

func hasChannels(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: scope,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size)
    guard status == noErr, size > 0 else { return false }
    let ptr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { ptr.deallocate() }
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, ptr)
    var channels = 0
    let count = Int(ptr.pointee.mNumberBuffers)
    withUnsafePointer(to: ptr.pointee.mBuffers) { p in
        for i in 0..<count { channels += Int(p.advanced(by: i).pointee.mNumberChannels) }
    }
    return channels > 0
}

func setDefaultDevice(_ id: AudioObjectID, output: Bool) -> Bool {
    let selector = output
        ? kAudioHardwarePropertyDefaultOutputDevice
        : kAudioHardwarePropertyDefaultInputDevice
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceId = id
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
        UInt32(MemoryLayout<AudioObjectID>.size), &deviceId
    )
    return status == noErr
}

// MARK: - Main

let args = CommandLine.arguments
let isOutput = args.contains("--output")
let isInput = args.contains("--input")

guard isOutput || isInput else {
    fputs("Usage: swift set-system-device.swift --output \"Device Name\"\n", stderr)
    fputs("       swift set-system-device.swift --input \"Device Name\"\n", stderr)
    exit(1)
}

let flagIndex = args.firstIndex(of: isOutput ? "--output" : "--input")!
guard flagIndex + 1 < args.count else {
    fputs("Error: missing device name after flag\n", stderr)
    exit(1)
}
let targetName = args[flagIndex + 1].lowercased()

let scope: AudioObjectPropertyScope = isOutput
    ? kAudioObjectPropertyScopeOutput
    : kAudioObjectPropertyScopeInput

// Find matching device
for device in getAllDevices() {
    guard let name = getDeviceName(device) else { continue }
    guard hasChannels(device, scope: scope) else { continue }

    // Match by substring (the Web Audio API label often has extra text)
    if name.lowercased().contains(targetName) || targetName.contains(name.lowercased()) {
        if setDefaultDevice(device, output: isOutput) {
            let uid = getDeviceUID(device) ?? "?"
            print("{\"ok\":true,\"name\":\"\(name)\",\"uid\":\"\(uid)\",\"id\":\(device)}")
            exit(0)
        } else {
            fputs("Error: failed to set \(name) as default\n", stderr)
            exit(1)
        }
    }
}

fputs("Error: no device matching '\(args[flagIndex + 1])' found\n", stderr)
exit(1)
