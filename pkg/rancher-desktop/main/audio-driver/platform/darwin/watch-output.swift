#!/usr/bin/env swift
//
// watch-output.swift — monitors default output device changes.
//
// Runs continuously. When the default output changes away from our
// mirror device, emits a JSON line so the Electron app can rebuild
// the mirror with the new physical device.
//
// Output (one JSON line per change):
//   {"event":"output-changed","uid":"BuiltInSpeakerDevice","name":"MacBook Air Speakers","id":118}
//
// Ignores changes TO our mirror device (those are us setting it).
//

import CoreAudio
import Foundation

let kMirrorUID = "AudioDriverMirror_UID"
let kLoopbackUIDs = ["AudioDriverLoopback2ch_UID", "BlackHole2ch_UID"]

// MARK: - Helpers

func getDefaultOutputDevice() -> AudioObjectID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceID: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID
    )
    return deviceID
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

// MARK: - Listener

// Debounce: macOS sometimes fires multiple rapid changes
var lastEventTime: Date = .distantPast
let debounceInterval: TimeInterval = 0.5

let listenerCallback: AudioObjectPropertyListenerProc = { _, _, _, _ in
    let now = Date()
    guard now.timeIntervalSince(lastEventTime) > debounceInterval else { return noErr }
    lastEventTime = now

    let deviceID = getDefaultOutputDevice()
    let uid = getDeviceUID(deviceID) ?? ""
    let name = getDeviceName(deviceID) ?? ""

    // Ignore changes TO our mirror or loopback devices
    if uid == kMirrorUID || kLoopbackUIDs.contains(uid) {
        return noErr
    }

    let json = "{\"event\":\"output-changed\",\"uid\":\"\(uid)\",\"name\":\"\(name)\",\"id\":\(deviceID)}"
    print(json)
    fflush(stdout)

    return noErr
}

// Register the listener
var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultOutputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)

let status = AudioObjectAddPropertyListener(
    AudioObjectID(kAudioObjectSystemObject),
    &address,
    listenerCallback,
    nil
)

if status != noErr {
    fputs("Error: failed to register output device listener (status: \(status))\n", stderr)
    exit(1)
}

fputs("[watch] Listening for output device changes...\n", stderr)

// Keep the process alive
RunLoop.current.run()
