#!/usr/bin/env swift
//
// capture-loopback.swift — captures audio from the loopback driver
// via CoreAudio HALOutput AudioUnit and writes RMS levels to stdout.
//
// Based on sulla-audio's CoreAudioCaptureBackend.h — uses non-interleaved
// format with separate buffers per channel, matching how BlackHole delivers data.
//
// Usage:
//   swift capture-loopback.swift                    # auto-detect
//   swift capture-loopback.swift BlackHole2ch_UID   # specific device
//
// Output (JSON lines, ~50ms interval):
//   {"rms":0.1234}
//
// Runs until killed (SIGTERM/SIGINT).
//

import AudioToolbox
import CoreAudio
import Foundation

// ─── Configuration ───────────────────────────────────────────

let kLoopbackUIDs = ["AudioDriverLoopback2ch_UID", "BlackHole2ch_UID"]
let kChannels: UInt32 = 2

// ─── Smoothing ──────────────────────────────────────────────
// Standard VU meter ballistics: fast attack, slow decay.
// Attack: respond quickly when level rises (track transients)
// Decay: fall off slowly when level drops (readable meter)

let kAttack: Float = 0.3    // Higher = faster rise (0–1)
let kDecay: Float = 0.05    // Lower = slower fall (0–1)
var gSmoothedLevel: Float = 0

// ─── Pitch detection config ─────────────────────────────────

let kSampleRate: Float = 48000
let kMinPitchHz: Float = 80       // Lowest human pitch
let kMaxPitchHz: Float = 400      // Highest human pitch
let kMinLag = Int(kSampleRate / kMaxPitchHz)  // 120
let kMaxLag = Int(kSampleRate / kMinPitchHz)  // 600
let kAMDFClarityThreshold: Float = 0.3

// Pitch stability tracking
let kPitchHistorySize = 10
let kSteadyPitchThreshold: Float = 5.0  // Hz stddev below this = steady

// ─── Spectral config ────────────────────────────────────────

let kFFTSize = 512
let kStartBin = 3                 // Skip DC and sub-bass
let kRolloffThreshold: Float = 0.85

// ─── Globals ─────────────────────────────────────────────────

var gAudioUnit: AudioComponentInstance?
var gRunning = true

// Variance tracking: ring buffer of recent RMS values
let kVarianceWindow = 20
var gVarianceBuffer = [Float](repeating: 0, count: 20)
var gVarianceIndex = 0

// Pitch history: ring buffer for stability tracking
var gPitchHistory = [Float](repeating: 0, count: 10)
var gPitchHistoryIndex = 0
var gPitchHistoryFilled = 0

// Pre-allocated mono mix buffer for analysis (avoid allocs in callback)
var gMonoBuffer = [Float](repeating: 0, count: 4096)

// Pre-allocated FFT magnitude buffer
var gMagnitudes = [Float](repeating: 0, count: 256)

// Pre-allocated s16le conversion buffer for raw PCM output (fd 3)
// Output at 16kHz (3:1 decimation from 48kHz) for gateway/ElevenLabs
var gPCMBuffer = [Int16](repeating: 0, count: 2048)
let kPCMFd: Int32 = 3  // File descriptor 3 for raw PCM output
let kDecimationFactor = 3  // 48000 / 16000 = 3

// ─── CoreAudio helpers ───────────────────────────────────────

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

func getDeviceName(_ id: AudioObjectID) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name)
    return name as String
}

// ─── Render callback ─────────────────────────────────────────
//
// Key insight from sulla-audio: BlackHole delivers NON-INTERLEAVED
// audio. Each channel gets its own buffer. We must allocate
// mNumberBuffers = channels, each with mNumberChannels = 1.

let inputCallback: AURenderCallback = {
    (inRefCon, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, _) -> OSStatus in

    guard let unit = gAudioUnit else { return noErr }

    let channels = Int(kChannels)
    let frameSizeBytes = inNumberFrames * UInt32(MemoryLayout<Float32>.size)

    // Allocate one buffer per channel (non-interleaved)
    let channelData = (0..<channels).map { _ in
        UnsafeMutablePointer<Float32>.allocate(capacity: Int(inNumberFrames))
    }

    // Build AudioBufferList with separate buffer per channel
    let ablSize = MemoryLayout<AudioBufferList>.size + (channels - 1) * MemoryLayout<AudioBuffer>.size
    let ablPtr = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: ablSize)
    ablPtr.pointee.mNumberBuffers = UInt32(channels)

    withUnsafeMutablePointer(to: &ablPtr.pointee.mBuffers) { buffersPtr in
        for ch in 0..<channels {
            let buf = buffersPtr.advanced(by: ch)
            buf.pointee.mNumberChannels = 1
            buf.pointee.mDataByteSize = frameSizeBytes
            buf.pointee.mData = UnsafeMutableRawPointer(channelData[ch])
        }
    }

    // Pull audio from the device
    let status = AudioUnitRender(unit, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, ablPtr)

    if status == noErr {
        let frames = Int(inNumberFrames)

        // Compute RMS, peak, and zero-crossing rate across all channels
        var sum: Float64 = 0
        var peak: Float = 0
        var zeroCrossings = 0
        var totalSamples = 0

        for ch in 0..<channels {
            var prevSample: Float = 0
            for i in 0..<frames {
                let s = channelData[ch][i]
                sum += Float64(s) * Float64(s)
                let absS = abs(s)
                if absS > peak { peak = absS }

                // Zero-crossing: count sign changes
                if i > 0 && ((s >= 0) != (prevSample >= 0)) {
                    zeroCrossings += 1
                }
                prevSample = s
                totalSamples += 1
            }
        }

        let rms = Float(sqrt(sum / Float64(max(totalSamples, 1))))
        let rawLevel = min(1.0, rms * 3.0)
        let peakLevel = min(1.0, peak * 3.0)

        // Zero-crossing rate normalized to 0–1 per channel
        let totalTransitions = channels * max(frames - 1, 1)
        let zcr = Float(zeroCrossings) / Float(totalTransitions)

        // Short-term variance: track over recent callbacks
        gVarianceBuffer[gVarianceIndex % kVarianceWindow] = rawLevel
        gVarianceIndex += 1
        let filled = min(gVarianceIndex, kVarianceWindow)
        var vMean: Float = 0
        for i in 0..<filled { vMean += gVarianceBuffer[i] }
        vMean /= Float(filled)
        var vSum: Float = 0
        for i in 0..<filled {
            let d = gVarianceBuffer[i] - vMean
            vSum += d * d
        }
        let variance = vSum / Float(filled)

        // ── Mono mix for pitch and spectral analysis ────────────
        // Average channels into mono buffer
        let monoFrames = min(frames, gMonoBuffer.count)
        for i in 0..<monoFrames {
            var s: Float = 0
            for ch in 0..<channels { s += channelData[ch][i] }
            gMonoBuffer[i] = s / Float(channels)
        }

        // ── Raw PCM output to fd 3 (s16le mono 16kHz for gateway) ──
        // Downsample 48kHz → 16kHz by averaging groups of 3 samples,
        // then convert to int16. Averaging acts as a simple low-pass
        // filter to reduce aliasing.
        let outFrames = monoFrames / kDecimationFactor
        for i in 0..<outFrames {
            let base = i * kDecimationFactor
            var sum: Float = 0
            for j in 0..<kDecimationFactor {
                sum += gMonoBuffer[base + j]
            }
            let avg = sum / Float(kDecimationFactor)
            let clamped = max(-1.0, min(1.0, avg))
            gPCMBuffer[i] = Int16(clamped * 32767.0)
        }
        if outFrames > 0 {
            gPCMBuffer.withUnsafeBufferPointer { ptr in
                let raw = UnsafeRawPointer(ptr.baseAddress!)
                let byteCount = outFrames * MemoryLayout<Int16>.size
                _ = write(kPCMFd, raw, byteCount)
            }
        }

        // ── Pitch detection (AMDF) ──────────────────────────────
        var pitchHz: Float = -1  // -1 = no pitch detected
        let maxLagClamped = min(kMaxLag, monoFrames - 1)

        if rms > 0.003 && maxLagClamped > kMinLag {
            var bestLag = -1
            var bestVal: Float = .infinity

            for lag in kMinLag...maxLagClamped {
                var amdfSum: Float = 0
                let count = monoFrames - lag
                for i in 0..<count {
                    amdfSum += abs(gMonoBuffer[i] - gMonoBuffer[i + lag])
                }
                let avg = amdfSum / Float(count)
                if avg < bestVal {
                    bestVal = avg
                    bestLag = lag
                }
            }

            // Accept only if dip is clear relative to signal level
            if bestLag > 0 && bestVal < rms * kAMDFClarityThreshold {
                pitchHz = kSampleRate / Float(bestLag)
            }
        }

        // Pitch stability tracking
        var steadyPitch = false
        var pitchStdDev: Float = 0
        if pitchHz > 0 {
            gPitchHistory[gPitchHistoryIndex % kPitchHistorySize] = pitchHz
            gPitchHistoryIndex += 1
            if gPitchHistoryFilled < kPitchHistorySize { gPitchHistoryFilled += 1 }
        }
        if gPitchHistoryFilled >= kPitchHistorySize {
            var pSum: Float = 0
            for i in 0..<kPitchHistorySize { pSum += gPitchHistory[i] }
            let pMean = pSum / Float(kPitchHistorySize)
            var pVarSum: Float = 0
            for i in 0..<kPitchHistorySize {
                let d = gPitchHistory[i] - pMean
                pVarSum += d * d
            }
            pitchStdDev = sqrt(pVarSum / Float(kPitchHistorySize))
            steadyPitch = pitchStdDev < kSteadyPitchThreshold
        }

        // ── Spectral centroid and rolloff (simple DFT on mono) ──
        // Use first kFFTSize frames (or fewer if not enough)
        var centroid: Float = 0
        var rolloff: Float = 0
        let fftFrames = min(kFFTSize, monoFrames)
        let binCount = fftFrames / 2

        if fftFrames >= 64 && binCount <= gMagnitudes.count {
            // Compute magnitude spectrum via DFT (real-valued input)
            // Only compute bins we need (kStartBin to binCount)
            var totalEnergy: Float = 0
            for k in kStartBin..<binCount {
                var re: Float = 0
                var im: Float = 0
                let freq = 2.0 * Float.pi * Float(k) / Float(fftFrames)
                for n in 0..<fftFrames {
                    let angle = freq * Float(n)
                    re += gMonoBuffer[n] * cos(angle)
                    im -= gMonoBuffer[n] * sin(angle)
                }
                let mag = sqrt(re * re + im * im) / Float(fftFrames)
                gMagnitudes[k] = mag
                totalEnergy += mag
            }

            if totalEnergy > 1e-10 {
                // Centroid: weighted mean of bin indices
                var weightedSum: Float = 0
                for k in kStartBin..<binCount {
                    weightedSum += Float(k) * gMagnitudes[k]
                }
                centroid = (weightedSum / totalEnergy) / Float(binCount)

                // Rolloff: bin below which 85% of energy sits
                var cumEnergy: Float = 0
                let target = totalEnergy * kRolloffThreshold
                var rolloffBin = binCount - 1
                for k in kStartBin..<binCount {
                    cumEnergy += gMagnitudes[k]
                    if cumEnergy >= target {
                        rolloffBin = k
                        break
                    }
                }
                rolloff = Float(rolloffBin) / Float(binCount)
            }
        }

        // ── Smoothed RMS for meter ──────────────────────────────
        if rawLevel > gSmoothedLevel {
            gSmoothedLevel += (rawLevel - gSmoothedLevel) * kAttack
        } else {
            gSmoothedLevel += (rawLevel - gSmoothedLevel) * kDecay
        }
        let level = gSmoothedLevel

        // ── Output ──────────────────────────────────────────────
        let pitchField = pitchHz > 0 ? String(format: "%.0f", pitchHz) : "null"
        let json = "{\"rms\":\(level),\"peak\":\(peakLevel),\"zcr\":\(zcr),\"variance\":\(variance),\"pitch\":\(pitchField),\"steadyPitch\":\(steadyPitch),\"pitchStdDev\":\(String(format: "%.1f", pitchStdDev)),\"centroid\":\(String(format: "%.4f", centroid)),\"rolloff\":\(String(format: "%.4f", rolloff))}\n"
        json.withCString { ptr in
            _ = write(STDOUT_FILENO, ptr, strlen(ptr))
        }
    } else {
        // Log errors (throttled)
        struct ErrorState { static var count = 0 }
        ErrorState.count += 1
        if ErrorState.count <= 3 || ErrorState.count % 500 == 0 {
            fputs("[capture] AudioUnitRender error: \(status) (count: \(ErrorState.count))\n", stderr)
        }
    }

    // Clean up
    for ch in 0..<channels {
        channelData[ch].deallocate()
    }
    ablPtr.deallocate()

    return noErr
}

// ─── Setup ───────────────────────────────────────────────────

func start(deviceID: AudioObjectID) -> Bool {
    var desc = AudioComponentDescription(
        componentType: kAudioUnitType_Output,
        componentSubType: kAudioUnitSubType_HALOutput,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0,
        componentFlagsMask: 0
    )

    guard let component = AudioComponentFindNext(nil, &desc) else {
        fputs("[capture] HALOutput component not found\n", stderr)
        return false
    }

    var status = AudioComponentInstanceNew(component, &gAudioUnit)
    guard status == noErr, let unit = gAudioUnit else {
        fputs("[capture] Failed to create AudioUnit (\(status))\n", stderr)
        return false
    }

    // Enable input on bus 1
    var enableIO: UInt32 = 1
    AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input, 1, &enableIO, UInt32(MemoryLayout<UInt32>.size))

    // Disable output on bus 0
    var disableIO: UInt32 = 0
    AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Output, 0, &disableIO, UInt32(MemoryLayout<UInt32>.size))

    // Set input device
    var deviceId = deviceID
    status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global, 0, &deviceId, UInt32(MemoryLayout<AudioObjectID>.size))
    guard status == noErr else {
        fputs("[capture] Failed to set device (\(status))\n", stderr)
        return false
    }

    // NON-INTERLEAVED float32 format (matches BlackHole/loopback driver)
    // mBytesPerFrame = 4 (one float per channel buffer, NOT interleaved)
    var format = AudioStreamBasicDescription(
        mSampleRate: 48000,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: kChannels,
        mBitsPerChannel: 32,
        mReserved: 0
    )
    status = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output, 1, &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
    guard status == noErr else {
        fputs("[capture] Failed to set format (\(status))\n", stderr)
        return false
    }

    // Set render callback
    var callbackStruct = AURenderCallbackStruct(inputProc: inputCallback, inputProcRefCon: nil)
    AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback,
        kAudioUnitScope_Global, 0, &callbackStruct, UInt32(MemoryLayout<AURenderCallbackStruct>.size))

    // Initialize and start
    status = AudioUnitInitialize(unit)
    guard status == noErr else {
        fputs("[capture] Failed to initialize AudioUnit (\(status))\n", stderr)
        return false
    }

    status = AudioOutputUnitStart(unit)
    guard status == noErr else {
        fputs("[capture] Failed to start AudioUnit (\(status))\n", stderr)
        return false
    }

    return true
}

// ─── Signal handling ─────────────────────────────────────────

signal(SIGTERM) { _ in gRunning = false }
signal(SIGINT)  { _ in gRunning = false }

// ─── Main ────────────────────────────────────────────────────

var targetUID: String? = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil

var deviceID: AudioObjectID? = nil
if let uid = targetUID {
    deviceID = findDeviceByUID(uid)
} else {
    for uid in kLoopbackUIDs {
        if let id = findDeviceByUID(uid) {
            deviceID = id
            targetUID = uid
            break
        }
    }
}

guard let devID = deviceID, let uid = targetUID else {
    fputs("[capture] No loopback driver found\n", stderr)
    exit(1)
}

fputs("[capture] Device: \(getDeviceName(devID)) (UID: \(uid), ID: \(devID))\n", stderr)
setbuf(stdout, nil)

guard start(deviceID: devID) else { exit(1) }
fputs("[capture] Streaming RMS to stdout\n", stderr)

while gRunning {
    Thread.sleep(forTimeInterval: 0.1)
}

if let unit = gAudioUnit {
    AudioOutputUnitStop(unit)
    AudioUnitUninitialize(unit)
    AudioComponentInstanceDispose(unit)
}
fputs("[capture] Stopped\n", stderr)
