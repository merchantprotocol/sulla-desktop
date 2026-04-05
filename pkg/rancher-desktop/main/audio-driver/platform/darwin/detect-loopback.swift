#!/usr/bin/env swift
//
// detect-loopback.swift — finds our loopback driver in the system.
//
// Tries AudioDriverLoopback first (our custom signed driver),
// falls back to BlackHole 2ch (pre-signed, installed via Homebrew).
//
// Usage:
//   swift detect-loopback.swift
//
// Output (JSON):
//   {"found":true,"deviceId":88,"uid":"AudioDriverLoopback2ch_UID","name":"AudioDriverLoopback 2ch","channels":2,"sampleRate":48000,"driver":"custom"}
//   {"found":true,"deviceId":91,"uid":"BlackHole2ch_UID","name":"BlackHole 2ch","channels":2,"sampleRate":48000,"driver":"blackhole"}
//   {"found":false}
//

import CoreAudio
import Foundation

// Our custom driver (once signed and installed)
let kCustomUID = "AudioDriverLoopback2ch_UID"
// Fallback: stock BlackHole (signed, via Homebrew)
let kBlackHoleUID = "BlackHole2ch_UID"

struct DeviceInfo: Codable {
    let found: Bool
    let deviceId: UInt32?
    let uid: String?
    let name: String?
    let channels: Int?
    let sampleRate: Double?
    let driver: String? // "custom" or "blackhole"
}

// MARK: - CoreAudio helpers

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

func getInputChannelCount(_ id: AudioObjectID) -> Int {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size)
    guard status == noErr, size > 0 else { return 0 }

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
    return channels
}

func getSampleRate(_ id: AudioObjectID) -> Double {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var rate: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, &rate)
    return rate
}

func findDeviceByUID(_ targetUID: String) -> AudioObjectID? {
    for device in getAllDevices() {
        if getDeviceUID(device) == targetUID {
            return device
        }
    }
    return nil
}

func makeResult(_ device: AudioObjectID, uid: String, driverType: String) -> DeviceInfo {
    return DeviceInfo(
        found: true,
        deviceId: device,
        uid: uid,
        name: getDeviceName(device),
        channels: getInputChannelCount(device),
        sampleRate: getSampleRate(device),
        driver: driverType
    )
}

func output(_ info: DeviceInfo) {
    let data = try! JSONEncoder().encode(info)
    print(String(data: data, encoding: .utf8)!)
}

// MARK: - Detection

// 1. Try our custom driver first
if let device = findDeviceByUID(kCustomUID) {
    let channels = getInputChannelCount(device)
    if channels > 0 {
        output(makeResult(device, uid: kCustomUID, driverType: "custom"))
        exit(0)
    }
}

// 2. Fall back to BlackHole 2ch
if let device = findDeviceByUID(kBlackHoleUID) {
    let channels = getInputChannelCount(device)
    if channels > 0 {
        output(makeResult(device, uid: kBlackHoleUID, driverType: "blackhole"))
        exit(0)
    }
}

// 3. Not found
output(DeviceInfo(found: false, deviceId: nil, uid: nil, name: nil, channels: nil, sampleRate: nil, driver: nil))
exit(1)
