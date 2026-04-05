#!/usr/bin/env swift
//
// create-multi-output — creates a Multi-Output Device combining
// the default output device with SullaLoopback, then sets it as
// the system default output so all audio mirrors to the loopback driver.
//
// Usage:
//   swift create-multi-output.swift          # create + set default
//   swift create-multi-output.swift --check  # exit 0 if already exists
//   swift create-multi-output.swift --remove # destroy the device
//

import CoreAudio
import Foundation

let kDeviceUID  = "AudioDriverMirror_UID"
let kLoopbackUIDs = ["AudioDriverLoopback2ch_UID", "BlackHole2ch_UID"]

// Dynamic name: use --name "X" or default
let kDeviceName: String = {
    if let idx = CommandLine.arguments.firstIndex(of: "--name"),
       idx + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[idx + 1]
    }
    return "Audio Driver Mirror"
}()

// Optional: wrap a specific device UID instead of current default
let kForDeviceUID: String? = {
    if let idx = CommandLine.arguments.firstIndex(of: "--for-device"),
       idx + 1 < CommandLine.arguments.count {
        return CommandLine.arguments[idx + 1]
    }
    return nil
}()

// MARK: - Helpers

func getDefaultOutputDeviceUID() -> String? {
    var deviceID = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID
    )
    guard status == noErr else { return nil }

    // Now get UID string from device ID
    var uidAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var uid: CFString = "" as CFString
    var uidSize = UInt32(MemoryLayout<CFString>.size)
    let uidStatus = AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, &uid)
    guard uidStatus == noErr else { return nil }
    return uid as String
}

func findDeviceByUID(_ targetUID: String) -> AudioObjectID? {
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

    for device in devices {
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: CFString = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        let status = AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize, &uid)
        if status == noErr && (uid as String) == targetUID {
            return device
        }
    }
    return nil
}

func setDefaultOutputDevice(_ deviceID: AudioObjectID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var mutableID = deviceID
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil,
        UInt32(MemoryLayout<AudioObjectID>.size), &mutableID
    )
    return status == noErr
}

// MARK: - Commands

func checkExists() -> Bool {
    return findDeviceByUID(kDeviceUID) != nil
}

func createMultiOutput() -> Bool {
    // If already exists, just ensure it's the default output
    if let existingID = findDeviceByUID(kDeviceUID) {
        if let currentUID = getDefaultOutputDeviceUID(), currentUID != kDeviceUID {
            if setDefaultOutputDevice(existingID) {
                print("Mirror exists — re-set as default output.")
            } else {
                fputs("Warning: mirror exists but failed to set as default.\n", stderr)
            }
        } else {
            print("Mirror exists and is already the default output.")
        }
        return true
    }

    // Get the physical device to wrap: either from --for-device or current default
    let defaultUID: String
    if let forDevice = kForDeviceUID {
        guard findDeviceByUID(forDevice) != nil else {
            fputs("Error: device \(forDevice) not found.\n", stderr)
            return false
        }
        defaultUID = forDevice
    } else {
        guard let currentDefault = getDefaultOutputDeviceUID() else {
            fputs("Error: could not determine default output device.\n", stderr)
            return false
        }
        defaultUID = currentDefault
    }

    // Don't create if target is already the loopback driver (would create a loop)
    if kLoopbackUIDs.contains(defaultUID) {
        fputs("Error: target output is a loopback device. Set a physical output device first.\n", stderr)
        return false
    }

    // Don't create if target is already our mirror device
    if defaultUID == kDeviceUID {
        print("Multi-Output Device is already the default output.")
        return true
    }

    // Verify loopback driver exists
    // Find whichever loopback driver is available
    var activeLoopbackUID: String? = nil
    for uid in kLoopbackUIDs {
        if findDeviceByUID(uid) != nil {
            activeLoopbackUID = uid
            break
        }
    }
    guard let loopbackUID = activeLoopbackUID else {
        fputs("Error: No loopback driver found (tried BlackHole2ch, SullaLoopback2ch). Install one first.\n", stderr)
        return false
    }

    // Create the aggregate device description
    // Main device = physical output (speakers), sub-device = loopback driver
    // kAudioAggregateDeviceIsStackedKey = 1 makes it Multi-Output (stacked)
    let description: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: kDeviceName,
        kAudioAggregateDeviceUIDKey as String: kDeviceUID,
        kAudioAggregateDeviceIsStackedKey as String: 1 as UInt32,
        kAudioAggregateDeviceMasterSubDeviceKey as String: defaultUID,
        kAudioAggregateDeviceSubDeviceListKey as String: [
            [kAudioSubDeviceUIDKey as String: defaultUID],
            [
                kAudioSubDeviceUIDKey as String: loopbackUID,
                kAudioSubDeviceDriftCompensationKey as String: 1 as UInt32,
            ],
        ]
    ]

    var aggregateID: AudioObjectID = 0
    let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateID)

    if status != noErr {
        fputs("Error: AudioHardwareCreateAggregateDevice failed with status \(status)\n", stderr)
        return false
    }

    print("Created Multi-Output Device '\(kDeviceName)' (ID: \(aggregateID))")

    // Set as default output
    if setDefaultOutputDevice(aggregateID) {
        print("Set '\(kDeviceName)' as default output device.")
    } else {
        fputs("Warning: created device but failed to set as default output.\n", stderr)
        fputs("Set it manually in System Settings > Sound > Output.\n", stderr)
    }

    // Reset BlackHole volume to 1.0 — macOS often scales it down when it
    // becomes part of an aggregate, causing silence on the capture side.
    if let bhDevice = findDeviceByUID(loopbackUID) {
        var volAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var volume: Float32 = 1.0
        let volStatus = AudioObjectSetPropertyData(
            bhDevice, &volAddr, 0, nil,
            UInt32(MemoryLayout<Float32>.size), &volume
        )
        if volStatus == noErr {
            print("Set BlackHole output volume to 1.0")
        }

        // Also unmute just in case
        var muteAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var unmuted: UInt32 = 0
        AudioObjectSetPropertyData(bhDevice, &muteAddr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &unmuted)
    }

    return true
}

func removeMultiOutput() -> Bool {
    guard let deviceID = findDeviceByUID(kDeviceUID) else {
        print("Multi-Output Device not found. Nothing to remove.")
        return true
    }

    // Before destroying, switch default output back to something else
    // Find the first non-aggregate output device
    if let defaultUID = getDefaultOutputDeviceUID(), defaultUID == kDeviceUID {
        // Find a physical device to fall back to
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
            var uidAddr = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceUID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            var uid: CFString = "" as CFString
            var uidSize = UInt32(MemoryLayout<CFString>.size)
            AudioObjectGetPropertyData(dev, &uidAddr, 0, nil, &uidSize, &uid)
            let uidStr = uid as String
            if uidStr != kDeviceUID && !kLoopbackUIDs.contains(uidStr) && !uidStr.isEmpty {
                // Check it has output channels
                var outputAddr = AudioObjectPropertyAddress(
                    mSelector: kAudioDevicePropertyStreamConfiguration,
                    mScope: kAudioObjectPropertyScopeOutput,
                    mElement: kAudioObjectPropertyElementMain
                )
                var bufSize: UInt32 = 0
                AudioObjectGetPropertyDataSize(dev, &outputAddr, 0, nil, &bufSize)
                if bufSize > 0 {
                    let _ = setDefaultOutputDevice(dev)
                    print("Switched default output back to device: \(uidStr)")
                    break
                }
            }
        }
    }

    let status = AudioHardwareDestroyAggregateDevice(deviceID)
    if status != noErr {
        fputs("Error: AudioHardwareDestroyAggregateDevice failed with status \(status)\n", stderr)
        return false
    }

    print("Removed Multi-Output Device '\(kDeviceName)'.")
    return true
}

// MARK: - Main

let args = CommandLine.arguments
if args.contains("--check") {
    exit(checkExists() ? 0 : 1)
} else if args.contains("--remove") {
    exit(removeMultiOutput() ? 0 : 1)
} else {
    exit(createMultiOutput() ? 0 : 1)
}
