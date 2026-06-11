#!/usr/bin/env swift
//
// volume-control.swift — get/set/adjust volume on a specific audio device.
//
// Used by the Electron app to apply volume changes when the system output
// is a Multi-Output aggregate device (which has no hardware volume controls).
//
// Usage:
//   swift volume-control.swift get    <deviceUID>
//   swift volume-control.swift set    <deviceUID> <0.0-1.0>
//   swift volume-control.swift inc    <deviceUID> [step]
//   swift volume-control.swift dec    <deviceUID> [step]
//   swift volume-control.swift mute   <deviceUID>
//   swift volume-control.swift unmute <deviceUID>
//   swift volume-control.swift toggle-mute <deviceUID>
//
// Output (JSON):
//   {"ok":true,"volume":0.75,"muted":false}
//

import AudioToolbox
import CoreAudio
import Foundation

let kDefaultStep: Float32 = 0.0625  // 1/16 — standard macOS volume step

// ─── Find device by UID ────────────────────────────────────────

func findDeviceByUID(_ targetUID: String) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    ) == noErr else { return nil }

    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var devices = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices
    ) == noErr else { return nil }

    for device in devices {
        var uidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: CFString = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        if AudioObjectGetPropertyData(device, &uidAddr, 0, nil, &uidSize, &uid) == noErr {
            if (uid as String) == targetUID { return device }
        }
    }
    return nil
}

// ─── Volume control ────────────────────────────────────────────

func getVolume(_ device: AudioObjectID) -> Float32? {
    // Try VirtualMainVolume first (works on most devices)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var volume: Float32 = 0
    var size = UInt32(MemoryLayout<Float32>.size)

    if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &volume) == noErr {
        return volume
    }

    // Fallback: per-channel volume (channel 1)
    address.mSelector = kAudioDevicePropertyVolumeScalar
    address.mElement = 1
    if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &volume) == noErr {
        return volume
    }

    return nil
}

func setVolume(_ device: AudioObjectID, _ volume: Float32) -> Bool {
    var vol = max(0.0, min(1.0, volume))

    // Try VirtualMainVolume first
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )

    if AudioObjectSetPropertyData(device, &address, 0, nil,
        UInt32(MemoryLayout<Float32>.size), &vol) == noErr {
        return true
    }

    // Fallback: set both channels
    address.mSelector = kAudioDevicePropertyVolumeScalar
    var ok = true
    for ch: UInt32 in 1...2 {
        address.mElement = ch
        if AudioObjectSetPropertyData(device, &address, 0, nil,
            UInt32(MemoryLayout<Float32>.size), &vol) != noErr {
            ok = false
        }
    }
    return ok
}

func getMuted(_ device: AudioObjectID) -> Bool? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var muted: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)

    if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &muted) == noErr {
        return muted != 0
    }
    return nil
}

func setMuted(_ device: AudioObjectID, _ muted: Bool) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var value: UInt32 = muted ? 1 : 0
    return AudioObjectSetPropertyData(device, &address, 0, nil,
        UInt32(MemoryLayout<UInt32>.size), &value) == noErr
}

// ─── Output ────────────────────────────────────────────────────

func output(device: AudioObjectID) {
    let vol = getVolume(device) ?? -1
    let muted = getMuted(device) ?? false
    print("{\"ok\":true,\"volume\":\(vol),\"muted\":\(muted)}")
}

func outputError(_ msg: String) {
    print("{\"ok\":false,\"error\":\"\(msg)\"}")
}

// ─── Default output query ──────────────────────────────────────

func getDefaultOutputUID() -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceID: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID
    ) == noErr else { return nil }

    var uidAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: CFString = "" as CFString
    var uidSize = UInt32(MemoryLayout<CFString>.size)
    guard AudioObjectGetPropertyData(deviceID, &uidAddr, 0, nil, &uidSize, &uid) == noErr else {
        return nil
    }
    return uid as String
}

// ─── Main ──────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else {
    outputError("Usage: volume-control <cmd> <deviceUID> [value]")
    exit(1)
}

let cmd = args[1]

// Special command that doesn't need a device UID
if cmd == "default-uid" {
    if let uid = getDefaultOutputUID() {
        print("{\"ok\":true,\"uid\":\"\(uid)\"}")
    } else {
        outputError("Could not get default output UID")
    }
    exit(0)
}

guard args.count >= 3 else {
    outputError("Usage: volume-control <cmd> <deviceUID> [value]")
    exit(1)
}

let deviceUID = args[2]

guard let device = findDeviceByUID(deviceUID) else {
    outputError("Device not found: \(deviceUID)")
    exit(1)
}

switch cmd {
case "get":
    output(device: device)

case "set":
    guard args.count >= 4, let vol = Float32(args[3]) else {
        outputError("Missing volume value")
        exit(1)
    }
    _ = setVolume(device, vol)
    output(device: device)

case "inc":
    let step = args.count >= 4 ? (Float32(args[3]) ?? kDefaultStep) : kDefaultStep
    let current = getVolume(device) ?? 0
    _ = setVolume(device, current + step)
    // Unmute on volume up
    _ = setMuted(device, false)
    output(device: device)

case "dec":
    let step = args.count >= 4 ? (Float32(args[3]) ?? kDefaultStep) : kDefaultStep
    let current = getVolume(device) ?? 0
    _ = setVolume(device, current - step)
    output(device: device)

case "mute":
    _ = setMuted(device, true)
    output(device: device)

case "unmute":
    _ = setMuted(device, false)
    output(device: device)

case "toggle-mute":
    let current = getMuted(device) ?? false
    _ = setMuted(device, !current)
    output(device: device)

default:
    outputError("Unknown command: \(cmd)")
    exit(1)
}
