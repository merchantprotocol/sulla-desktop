#!/usr/bin/env swift
//
// reset-default-output.swift — resets default output to a physical device
// if it's currently set to a loopback driver or stale mirror.
//
// Fixes broken state from a previous shutdown that didn't clean up.
//
// Exit 0 + prints message if reset was needed.
// Exit 1 silently if default is already a physical device.
//

import CoreAudio
import Foundation

let kLoopbackUIDs = ["AudioDriverLoopback2ch_UID", "BlackHole2ch_UID"]
let kMirrorUID = "AudioDriverMirror_UID"

func getDefaultOutputDeviceUID() -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceId: AudioObjectID = 0
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceId)

    var uidAddr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: CFString = "" as CFString
    var uidSize = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(deviceId, &uidAddr, 0, nil, &uidSize, &uid)
    return status == noErr ? uid as String : nil
}

func setDefaultOutputDevice(_ id: AudioObjectID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
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

func hasOutputChannels(_ id: AudioObjectID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size)
    guard status == noErr, size > 0 else { return false }

    let bufferListPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { bufferListPtr.deallocate() }
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, bufferListPtr)

    var channels = 0
    let count = Int(bufferListPtr.pointee.mNumberBuffers)
    withUnsafePointer(to: bufferListPtr.pointee.mBuffers) { ptr in
        for i in 0..<count {
            channels += Int(ptr.advanced(by: i).pointee.mNumberChannels)
        }
    }
    return channels > 0
}

// Check if default output needs resetting
guard let currentUID = getDefaultOutputDeviceUID() else {
    exit(1)
}

let isBroken = kLoopbackUIDs.contains(currentUID) || currentUID == kMirrorUID
if !isBroken {
    exit(1) // Already on a physical device
}

// Find a physical output device to switch to
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

for dev in devices {
    guard let uid = getDeviceUID(dev) else { continue }
    if kLoopbackUIDs.contains(uid) || uid == kMirrorUID { continue }
    if !hasOutputChannels(dev) { continue }

    // Skip virtual devices (Teams, Zoom, etc.)
    let name = getDeviceName(dev) ?? ""
    if name.contains("Microsoft") || name.contains("Zoom") { continue }

    if setDefaultOutputDevice(dev) {
        print("Reset default output to \(name) (was stuck on loopback)")
        exit(0)
    }
}

fputs("Error: no physical output device found to reset to\n", stderr)
exit(1)
