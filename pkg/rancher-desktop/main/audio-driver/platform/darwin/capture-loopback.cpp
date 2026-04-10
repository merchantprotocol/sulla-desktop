/**
 * capture-loopback — captures audio from a loopback/virtual input device
 * via CoreAudio HALOutput AudioUnit.
 *
 * Ported from sulla-audio's CoreAudioCaptureBackend (C++) which correctly
 * handles non-interleaved buffer management. Replaces the Swift version
 * which had memory management issues in the render callback.
 *
 * Output:
 *   stdout — JSON lines with RMS, peak, ZCR, variance, pitch, centroid, rolloff
 *   fd 3   — raw s16le PCM (16kHz mono, decimated 3:1 from 48kHz)
 *
 * Usage:
 *   capture-loopback                    # auto-detect loopback device
 *   capture-loopback BlackHole2ch_UID   # specific device UID
 *
 * Compile:
 *   clang++ -std=c++17 -O2 -framework CoreAudio -framework AudioToolbox \
 *     -framework CoreFoundation -o capture-loopback capture-loopback.cpp
 */

#include <CoreAudio/CoreAudio.h>
#include <AudioToolbox/AudioToolbox.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <csignal>
#include <atomic>
#include <vector>
#include <string>
#include <unistd.h>

// ─── Constants ──────────────────────────────────────────────────

static const uint32_t kSampleRate       = 48000;
static const uint32_t kChannels         = 2;
static const int      kDecimationFactor = 3;    // 48000 / 16000
static const int      kPCMFd            = 3;    // fd 3 for raw PCM output

// VAD / analysis constants
static const float kAttack = 0.3f;
static const float kDecay  = 0.05f;

// Pitch detection (AMDF)
static const int kMinLag = 30;   // ~1600 Hz at 48kHz
static const int kMaxLag = 400;  // ~120 Hz at 48kHz

// Variance window
static const int kVarianceWindow = 20;

// Spectral analysis
static const int kFFTFrames     = 512;
static const int kStartBin      = 2;    // skip DC and near-DC
static const float kRolloffThreshold = 0.85f;

// ─── Global state ───────────────────────────────────────────────

static std::atomic<bool> gRunning{true};
static AudioUnit gAudioUnit = nullptr;

// Smoothed level for meter
static float gSmoothedLevel = 0.0f;

// Variance tracking
static float gVarianceBuffer[kVarianceWindow] = {};
static int   gVarianceIndex = 0;

// Pitch tracking (steady pitch detection)
static float gPitchHistory[10] = {};
static int   gPitchHistoryIndex = 0;
static int   gPitchHistoryFilled = 0;

// Mono buffer for analysis (reused across callbacks)
static std::vector<float> gMonoBuffer(8192, 0.0f);

// PCM output buffer (reused)
static std::vector<int16_t> gPCMBuffer(4096, 0);

// Spectral magnitudes
static float gMagnitudes[kFFTFrames] = {};

// ─── Device lookup ──────────────────────────────────────────────

static AudioObjectID findDeviceByUID(const char* targetUID) {
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, nullptr, &size);
    int count = size / sizeof(AudioObjectID);
    std::vector<AudioObjectID> devices(count);
    AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, nullptr, &size, devices.data());

    for (auto dev : devices) {
        AudioObjectPropertyAddress uidAddr = {
            kAudioDevicePropertyDeviceUID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        CFStringRef uid = nullptr;
        UInt32 uidSize = sizeof(uid);
        if (AudioObjectGetPropertyData(dev, &uidAddr, 0, nullptr, &uidSize, &uid) == noErr && uid) {
            char buf[256];
            if (CFStringGetCString(uid, buf, sizeof(buf), kCFStringEncodingUTF8)) {
                if (strcmp(buf, targetUID) == 0) {
                    CFRelease(uid);
                    return dev;
                }
            }
            CFRelease(uid);
        }
    }
    return kAudioObjectUnknown;
}

static std::string getDeviceName(AudioObjectID dev) {
    AudioObjectPropertyAddress addr = {
        kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    CFStringRef name = nullptr;
    UInt32 size = sizeof(name);
    if (AudioObjectGetPropertyData(dev, &addr, 0, nullptr, &size, &name) == noErr && name) {
        char buf[256];
        CFStringGetCString(name, buf, sizeof(buf), kCFStringEncodingUTF8);
        CFRelease(name);
        return buf;
    }
    return "Unknown";
}

// ─── Render callback ────────────────────────────────────────────

static OSStatus inputCallback(
    void* /*inRefCon*/,
    AudioUnitRenderActionFlags* ioActionFlags,
    const AudioTimeStamp* inTimeStamp,
    UInt32 inBusNumber,
    UInt32 inNumberFrames,
    AudioBufferList* /*ioData*/)
{
    if (!gRunning.load()) return noErr;

    const int channels = kChannels;
    const size_t bufferSize = inNumberFrames * sizeof(float);
    const int frames = static_cast<int>(inNumberFrames);

    // ── Allocate AudioBufferList (proper RAII via std::vector) ────
    // sulla-audio pattern: use std::vector for both the ABL storage
    // and the per-channel data buffers. No manual memory management.
    std::vector<uint8_t> ablStorage(sizeof(AudioBufferList) + (channels - 1) * sizeof(AudioBuffer));
    auto* bufferList = reinterpret_cast<AudioBufferList*>(ablStorage.data());
    bufferList->mNumberBuffers = channels;

    std::vector<std::vector<float>> channelBuffers(channels, std::vector<float>(inNumberFrames));
    for (int ch = 0; ch < channels; ++ch) {
        bufferList->mBuffers[ch].mNumberChannels = 1;
        bufferList->mBuffers[ch].mDataByteSize = static_cast<UInt32>(bufferSize);
        bufferList->mBuffers[ch].mData = channelBuffers[ch].data();
    }

    // ── Render audio from the device ─────────────────────────────
    OSStatus status = AudioUnitRender(
        gAudioUnit, ioActionFlags, inTimeStamp, inBusNumber,
        inNumberFrames, bufferList);

    if (status != noErr) {
        static uint64_t errorCount = 0;
        errorCount++;
        if (errorCount <= 3 || errorCount % 500 == 0) {
            fprintf(stderr, "[capture] AudioUnitRender error: %d (count: %llu)\n",
                (int)status, (unsigned long long)errorCount);
        }
        return status;
    }

    // ── Compute RMS, peak, ZCR across all channels ───────────────
    double sumSq = 0.0;
    float peak = 0.0f;
    int zeroCrossings = 0;
    int totalSamples = 0;

    for (int ch = 0; ch < channels; ++ch) {
        float prev = 0.0f;
        for (int i = 0; i < frames; ++i) {
            float s = channelBuffers[ch][i];
            sumSq += (double)s * (double)s;
            float a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            if (i > 0 && ((s >= 0) != (prev >= 0))) {
                zeroCrossings++;
            }
            prev = s;
            totalSamples++;
        }
    }

    float rms = totalSamples > 0 ? (float)sqrt(sumSq / totalSamples) : 0.0f;
    float peakLevel = peak;
    float rawLevel = fminf(1.0f, rms * 3.0f);

    // ZCR normalized to 0-1
    int totalTransitions = channels * (frames > 1 ? frames - 1 : 1);
    float zcr = (float)zeroCrossings / (float)totalTransitions;

    // ── Variance tracking ────────────────────────────────────────
    gVarianceBuffer[gVarianceIndex % kVarianceWindow] = rawLevel;
    gVarianceIndex++;
    int filled = gVarianceIndex < kVarianceWindow ? gVarianceIndex : kVarianceWindow;
    float vMean = 0.0f;
    for (int i = 0; i < filled; i++) vMean += gVarianceBuffer[i];
    vMean /= (float)filled;
    float vSum = 0.0f;
    for (int i = 0; i < filled; i++) {
        float d = gVarianceBuffer[i] - vMean;
        vSum += d * d;
    }
    float variance = vSum / (float)filled;

    // ── Mono mix ─────────────────────────────────────────────────
    int monoFrames = frames;
    if (monoFrames > (int)gMonoBuffer.size()) {
        gMonoBuffer.resize(monoFrames);
    }
    for (int i = 0; i < monoFrames; ++i) {
        float s = 0.0f;
        for (int ch = 0; ch < channels; ++ch) {
            s += channelBuffers[ch][i];
        }
        gMonoBuffer[i] = s / (float)channels;
    }

    // ── Raw PCM output to fd 3 (s16le mono 16kHz) ────────────────
    // Downsample 48kHz → 16kHz by averaging groups of 3 samples
    int outFrames = monoFrames / kDecimationFactor;
    if (outFrames > (int)gPCMBuffer.size()) {
        gPCMBuffer.resize(outFrames);
    }
    for (int i = 0; i < outFrames; ++i) {
        int base = i * kDecimationFactor;
        float sum = 0.0f;
        for (int j = 0; j < kDecimationFactor; ++j) {
            sum += gMonoBuffer[base + j];
        }
        float avg = sum / (float)kDecimationFactor;
        float clamped = fmaxf(-1.0f, fminf(1.0f, avg));
        gPCMBuffer[i] = (int16_t)(clamped * 32767.0f);
    }
    if (outFrames > 0) {
        write(kPCMFd, gPCMBuffer.data(), outFrames * sizeof(int16_t));
    }

    // ── Pitch detection (AMDF) ───────────────────────────────────
    float pitchHz = -1.0f;
    int maxLagClamped = kMaxLag < monoFrames - 1 ? kMaxLag : monoFrames - 1;

    if (rms > 0.003f && maxLagClamped > kMinLag) {
        int bestLag = -1;
        float bestVal = 1e30f;

        for (int lag = kMinLag; lag <= maxLagClamped; ++lag) {
            float diff = 0.0f;
            int count = monoFrames - lag;
            for (int i = 0; i < count; ++i) {
                float d = gMonoBuffer[i] - gMonoBuffer[i + lag];
                diff += d < 0 ? -d : d;
            }
            diff /= (float)count;
            if (diff < bestVal) {
                bestVal = diff;
                bestLag = lag;
            }
        }

        if (bestLag > 0 && bestVal < 0.1f) {
            pitchHz = (float)kSampleRate / (float)bestLag;
        }
    }

    // Steady pitch tracking
    bool steadyPitch = false;
    float pitchStdDev = 0.0f;
    if (pitchHz > 0) {
        gPitchHistory[gPitchHistoryIndex % 10] = pitchHz;
        gPitchHistoryIndex++;
        if (gPitchHistoryFilled < 10) gPitchHistoryFilled++;
    }
    if (gPitchHistoryFilled >= 3) {
        float pMean = 0;
        for (int i = 0; i < gPitchHistoryFilled; i++) pMean += gPitchHistory[i];
        pMean /= gPitchHistoryFilled;
        float pVar = 0;
        for (int i = 0; i < gPitchHistoryFilled; i++) {
            float d = gPitchHistory[i] - pMean;
            pVar += d * d;
        }
        pitchStdDev = sqrtf(pVar / gPitchHistoryFilled);
        steadyPitch = pitchStdDev < 30.0f;
    }

    // ── Spectral analysis (DFT on mono buffer) ───────────────────
    float centroid = 0.0f;
    float rolloff = 0.0f;

    if (monoFrames >= kFFTFrames && rms > 0.001f) {
        int binCount = kFFTFrames / 2;
        float totalEnergy = 0.0f;

        for (int k = kStartBin; k < binCount; ++k) {
            float re = 0.0f, im = 0.0f;
            float freq = 2.0f * (float)M_PI * (float)k / (float)kFFTFrames;
            for (int n = 0; n < kFFTFrames; ++n) {
                float angle = freq * (float)n;
                re += gMonoBuffer[n] * cosf(angle);
                im -= gMonoBuffer[n] * sinf(angle);
            }
            float mag = sqrtf(re * re + im * im) / (float)kFFTFrames;
            gMagnitudes[k] = mag;
            totalEnergy += mag;
        }

        if (totalEnergy > 1e-10f) {
            float weightedSum = 0.0f;
            for (int k = kStartBin; k < binCount; ++k) {
                weightedSum += (float)k * gMagnitudes[k];
            }
            centroid = (weightedSum / totalEnergy) / (float)binCount;

            float cumEnergy = 0.0f;
            float target = totalEnergy * kRolloffThreshold;
            int rolloffBin = binCount - 1;
            for (int k = kStartBin; k < binCount; ++k) {
                cumEnergy += gMagnitudes[k];
                if (cumEnergy >= target) {
                    rolloffBin = k;
                    break;
                }
            }
            rolloff = (float)rolloffBin / (float)binCount;
        }
    }

    // ── Smoothed RMS for meter ───────────────────────────────────
    if (rawLevel > gSmoothedLevel) {
        gSmoothedLevel += (rawLevel - gSmoothedLevel) * kAttack;
    } else {
        gSmoothedLevel += (rawLevel - gSmoothedLevel) * kDecay;
    }
    float level = gSmoothedLevel;

    // ── JSON output to stdout ────────────────────────────────────
    char json[512];
    if (pitchHz > 0) {
        snprintf(json, sizeof(json),
            "{\"rms\":%.6f,\"peak\":%.6f,\"zcr\":%.6f,\"variance\":%.8f,"
            "\"pitch\":%.0f,\"steadyPitch\":%s,\"pitchStdDev\":%.1f,"
            "\"centroid\":%.4f,\"rolloff\":%.4f}\n",
            level, peakLevel, zcr, variance,
            pitchHz, steadyPitch ? "true" : "false", pitchStdDev,
            centroid, rolloff);
    } else {
        snprintf(json, sizeof(json),
            "{\"rms\":%.6f,\"peak\":%.6f,\"zcr\":%.6f,\"variance\":%.8f,"
            "\"pitch\":null,\"steadyPitch\":%s,\"pitchStdDev\":%.1f,"
            "\"centroid\":%.4f,\"rolloff\":%.4f}\n",
            level, peakLevel, zcr, variance,
            steadyPitch ? "true" : "false", pitchStdDev,
            centroid, rolloff);
    }
    write(STDOUT_FILENO, json, strlen(json));

    return noErr;
}

// ─── Signal handling ────────────────────────────────────────────

static void signalHandler(int) {
    gRunning.store(false);
}

// ─── Main ───────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
    // Line-buffer stdout so JSON flushes immediately
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IOLBF, 0);

    signal(SIGTERM, signalHandler);
    signal(SIGINT, signalHandler);

    // Find the loopback device
    const char* targetUID = argc > 1 ? argv[1] : nullptr;
    AudioObjectID deviceID = kAudioObjectUnknown;

    if (targetUID) {
        deviceID = findDeviceByUID(targetUID);
        if (deviceID == kAudioObjectUnknown) {
            fprintf(stderr, "[capture] Device not found: %s\n", targetUID);
            return 1;
        }
    } else {
        // Auto-detect: look for BlackHole or SullaLoopback
        const char* knownUIDs[] = {
            "BlackHole2ch_UID",
            "AudioDriverLoopback2ch_UID",
            "SullaLoopback2ch_UID",
            nullptr
        };
        for (int i = 0; knownUIDs[i]; ++i) {
            deviceID = findDeviceByUID(knownUIDs[i]);
            if (deviceID != kAudioObjectUnknown) {
                fprintf(stderr, "[capture] Auto-detected: %s (UID: %s)\n",
                    getDeviceName(deviceID).c_str(), knownUIDs[i]);
                break;
            }
        }
        if (deviceID == kAudioObjectUnknown) {
            fprintf(stderr, "[capture] No loopback device found\n");
            return 1;
        }
    }

    std::string name = getDeviceName(deviceID);
    fprintf(stderr, "[capture] Device: %s (UID: %s, ID: %u)\n",
        name.c_str(), targetUID ? targetUID : "auto", (unsigned)deviceID);

    // ── Set up AudioUnit ─────────────────────────────────────────

    AudioComponentDescription desc = {
        kAudioUnitType_Output,
        kAudioUnitSubType_HALOutput,
        kAudioUnitManufacturer_Apple,
        0, 0
    };

    AudioComponent component = AudioComponentFindNext(nullptr, &desc);
    if (!component) {
        fprintf(stderr, "[capture] HALOutput component not found\n");
        return 1;
    }

    OSStatus status = AudioComponentInstanceNew(component, &gAudioUnit);
    if (status != noErr || !gAudioUnit) {
        fprintf(stderr, "[capture] Failed to create AudioUnit (%d)\n", (int)status);
        return 1;
    }

    // Enable input on bus 1
    UInt32 enableIO = 1;
    AudioUnitSetProperty(gAudioUnit, kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Input, 1, &enableIO, sizeof(enableIO));

    // Disable output on bus 0
    UInt32 disableIO = 0;
    AudioUnitSetProperty(gAudioUnit, kAudioOutputUnitProperty_EnableIO,
        kAudioUnitScope_Output, 0, &disableIO, sizeof(disableIO));

    // Set input device
    status = AudioUnitSetProperty(gAudioUnit, kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global, 0, &deviceID, sizeof(deviceID));
    if (status != noErr) {
        fprintf(stderr, "[capture] Failed to set device (%d)\n", (int)status);
        return 1;
    }

    // Non-interleaved float32 format (matches BlackHole/loopback)
    AudioStreamBasicDescription format = {};
    format.mSampleRate       = kSampleRate;
    format.mFormatID         = kAudioFormatLinearPCM;
    format.mFormatFlags      = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
    format.mBytesPerPacket   = 4;
    format.mFramesPerPacket  = 1;
    format.mBytesPerFrame    = 4;
    format.mChannelsPerFrame = kChannels;
    format.mBitsPerChannel   = 32;

    status = AudioUnitSetProperty(gAudioUnit, kAudioUnitProperty_StreamFormat,
        kAudioUnitScope_Output, 1, &format, sizeof(format));
    if (status != noErr) {
        fprintf(stderr, "[capture] Failed to set format (%d)\n", (int)status);
        return 1;
    }

    // Set render callback
    AURenderCallbackStruct callbackStruct = { inputCallback, nullptr };
    AudioUnitSetProperty(gAudioUnit, kAudioOutputUnitProperty_SetInputCallback,
        kAudioUnitScope_Global, 0, &callbackStruct, sizeof(callbackStruct));

    // Initialize and start
    status = AudioUnitInitialize(gAudioUnit);
    if (status != noErr) {
        fprintf(stderr, "[capture] Failed to initialize AudioUnit (%d)\n", (int)status);
        return 1;
    }

    status = AudioOutputUnitStart(gAudioUnit);
    if (status != noErr) {
        fprintf(stderr, "[capture] Failed to start AudioUnit (%d)\n", (int)status);
        return 1;
    }

    fprintf(stderr, "[capture] Streaming RMS to stdout\n");

    // Run until signal
    while (gRunning.load()) {
        usleep(100000); // 100ms
    }

    // Cleanup
    fprintf(stderr, "[capture] Stopped\n");
    AudioOutputUnitStop(gAudioUnit);
    AudioUnitUninitialize(gAudioUnit);
    AudioComponentInstanceDispose(gAudioUnit);

    return 0;
}
