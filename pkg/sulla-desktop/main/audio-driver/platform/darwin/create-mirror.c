/*
 * create-mirror.c — creates a Multi-Output aggregate device
 * using CoreFoundation directly (same approach as sulla-audio C++).
 *
 * Usage:
 *   ./create-mirror                    # create and set as default
 *   ./create-mirror --check            # exit 0 if exists
 *   ./create-mirror --remove           # destroy
 *
 * Compile:
 *   clang -framework CoreAudio -framework CoreFoundation -o create-mirror create-mirror.c
 */

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>

static const char* kMirrorName = "Audio Driver Mirror";
static const char* kMirrorUID  = "AudioDriverMirror_UID";
static const char* kLoopbackUIDs[] = { "AudioDriverLoopback2ch_UID", "BlackHole2ch_UID", NULL };

/* ─── Helpers ──────────────────────────────────────────────── */

static AudioObjectID findDeviceByUID(const char* targetUID) {
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = 0;
    AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size);
    int count = size / sizeof(AudioObjectID);
    AudioObjectID devices[count];
    AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, devices);

    for (int i = 0; i < count; i++) {
        AudioObjectPropertyAddress uidAddr = {
            kAudioDevicePropertyDeviceUID,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        CFStringRef uid = NULL;
        UInt32 uidSize = sizeof(uid);
        if (AudioObjectGetPropertyData(devices[i], &uidAddr, 0, NULL, &uidSize, &uid) == noErr && uid) {
            char buf[256];
            if (CFStringGetCString(uid, buf, sizeof(buf), kCFStringEncodingUTF8)) {
                if (strcmp(buf, targetUID) == 0) {
                    return devices[i];
                }
            }
        }
    }
    return kAudioObjectUnknown;
}

static int getDefaultOutputUID(char* outUID, size_t maxLen) {
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    AudioObjectID devID = 0;
    UInt32 size = sizeof(devID);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, &devID) != noErr)
        return 0;

    AudioObjectPropertyAddress uidAddr = {
        kAudioDevicePropertyDeviceUID,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    CFStringRef uid = NULL;
    UInt32 uidSize = sizeof(uid);
    if (AudioObjectGetPropertyData(devID, &uidAddr, 0, NULL, &uidSize, &uid) != noErr || !uid)
        return 0;

    return CFStringGetCString(uid, outUID, maxLen, kCFStringEncodingUTF8);
}

static int setDefaultOutput(AudioObjectID devID) {
    AudioObjectPropertyAddress addr = {
        kAudioHardwarePropertyDefaultOutputDevice,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    return AudioObjectSetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL,
        sizeof(devID), &devID) == noErr;
}

/* ─── Commands ─────────────────────────────────────────────── */

static int cmd_check(void) {
    return findDeviceByUID(kMirrorUID) != kAudioObjectUnknown ? 0 : 1;
}

static int cmd_remove(void) {
    AudioObjectID dev = findDeviceByUID(kMirrorUID);
    if (dev == kAudioObjectUnknown) {
        printf("Mirror not found.\n");
        return 0;
    }

    /* Restore default output to a physical device before destroying */
    char currentUID[256];
    if (getDefaultOutputUID(currentUID, sizeof(currentUID)) && strcmp(currentUID, kMirrorUID) == 0) {
        /* Find first non-mirror, non-loopback output device */
        AudioObjectPropertyAddress addr = {
            kAudioHardwarePropertyDevices,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        UInt32 size = 0;
        AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size);
        int count = size / sizeof(AudioObjectID);
        AudioObjectID devices[count];
        AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, devices);

        for (int i = 0; i < count; i++) {
            if (devices[i] == dev) continue;
            AudioObjectPropertyAddress uidAddr = {
                kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain
            };
            CFStringRef uid = NULL;
            UInt32 us = sizeof(uid);
            AudioObjectGetPropertyData(devices[i], &uidAddr, 0, NULL, &us, &uid);
            if (!uid) continue;
            char uidBuf[256];
            CFStringGetCString(uid, uidBuf, sizeof(uidBuf), kCFStringEncodingUTF8);

            int isLoopback = 0;
            for (int j = 0; kLoopbackUIDs[j]; j++) {
                if (strcmp(uidBuf, kLoopbackUIDs[j]) == 0) { isLoopback = 1; break; }
            }
            if (isLoopback || strcmp(uidBuf, kMirrorUID) == 0) continue;

            /* Check it has output channels */
            AudioObjectPropertyAddress outAddr = {
                kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput, kAudioObjectPropertyElementMain
            };
            UInt32 outSize = 0;
            AudioObjectGetPropertyDataSize(devices[i], &outAddr, 0, NULL, &outSize);
            if (outSize > 0) {
                setDefaultOutput(devices[i]);
                printf("Restored default to device %u\n", devices[i]);
                break;
            }
        }
    }

    OSStatus status = AudioHardwareDestroyAggregateDevice(dev);
    if (status != noErr) {
        fprintf(stderr, "Error: destroy failed (%d)\n", (int)status);
        return 1;
    }
    printf("Removed mirror.\n");
    return 0;
}

static int cmd_create(void) {
    /* If already exists, ensure it's the default */
    AudioObjectID existing = findDeviceByUID(kMirrorUID);
    if (existing != kAudioObjectUnknown) {
        char currentUID[256];
        if (getDefaultOutputUID(currentUID, sizeof(currentUID)) && strcmp(currentUID, kMirrorUID) != 0) {
            setDefaultOutput(existing);
            printf("Mirror exists — re-set as default.\n");
        } else {
            printf("Mirror exists and is default.\n");
        }
        return 0;
    }

    /* Get current default output */
    char physUID[256];
    if (!getDefaultOutputUID(physUID, sizeof(physUID))) {
        fprintf(stderr, "Error: no default output.\n");
        return 1;
    }

    /* Don't wrap a loopback device */
    for (int i = 0; kLoopbackUIDs[i]; i++) {
        if (strcmp(physUID, kLoopbackUIDs[i]) == 0) {
            fprintf(stderr, "Error: default is already a loopback device.\n");
            return 1;
        }
    }

    /* Find available loopback driver */
    const char* loopbackUID = NULL;
    for (int i = 0; kLoopbackUIDs[i]; i++) {
        if (findDeviceByUID(kLoopbackUIDs[i]) != kAudioObjectUnknown) {
            loopbackUID = kLoopbackUIDs[i];
            break;
        }
    }
    if (!loopbackUID) {
        fprintf(stderr, "Error: no loopback driver found.\n");
        return 1;
    }

    printf("Physical: %s\nLoopback: %s\n", physUID, loopbackUID);

    /* Build sub-device list */
    CFMutableArrayRef subDevices = CFArrayCreateMutable(kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);

    CFStringRef physUIDRef = CFStringCreateWithCString(kCFAllocatorDefault, physUID, kCFStringEncodingUTF8);
    CFMutableDictionaryRef physDict = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(physDict, CFSTR(kAudioSubDeviceUIDKey), physUIDRef);
    CFArrayAppendValue(subDevices, physDict);
    CFRelease(physDict);

    CFStringRef bhUIDRef = CFStringCreateWithCString(kCFAllocatorDefault, loopbackUID, kCFStringEncodingUTF8);
    CFMutableDictionaryRef bhDict = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(bhDict, CFSTR(kAudioSubDeviceUIDKey), bhUIDRef);
    CFArrayAppendValue(subDevices, bhDict);
    CFRelease(bhDict);

    /* Build aggregate descriptor — EXACTLY like sulla-audio C++ */
    CFMutableDictionaryRef desc = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);

    CFStringRef nameRef = CFStringCreateWithCString(kCFAllocatorDefault, kMirrorName, kCFStringEncodingUTF8);
    CFStringRef uidRef = CFStringCreateWithCString(kCFAllocatorDefault, kMirrorUID, kCFStringEncodingUTF8);

    CFDictionarySetValue(desc, CFSTR(kAudioAggregateDeviceNameKey), nameRef);
    CFDictionarySetValue(desc, CFSTR(kAudioAggregateDeviceUIDKey), uidRef);
    CFDictionarySetValue(desc, CFSTR(kAudioAggregateDeviceSubDeviceListKey), subDevices);

    /* kAudioAggregateDeviceIsStackedKey = 1 → Multi-Output */
    int stacked = 1;
    CFNumberRef stackedRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &stacked);
    CFDictionarySetValue(desc, CFSTR(kAudioAggregateDeviceIsStackedKey), stackedRef);

    /* Master sub-device for volume control */
    CFDictionarySetValue(desc, CFSTR(kAudioAggregateDeviceMasterSubDeviceKey), physUIDRef);

    AudioObjectID newMirror = kAudioObjectUnknown;
    OSStatus status = AudioHardwareCreateAggregateDevice(desc, &newMirror);

    CFRelease(stackedRef);
    CFRelease(uidRef);
    CFRelease(nameRef);
    CFRelease(physUIDRef);
    CFRelease(bhUIDRef);
    CFRelease(subDevices);
    CFRelease(desc);

    if (status != noErr) {
        fprintf(stderr, "Error: AudioHardwareCreateAggregateDevice failed (%d)\n", (int)status);
        return 1;
    }

    printf("Created mirror (ID: %u)\n", newMirror);

    if (setDefaultOutput(newMirror)) {
        printf("Set as default output.\n");
    } else {
        fprintf(stderr, "Warning: failed to set as default.\n");
    }

    return 0;
}

/* ─── Main ─────────────────────────────────────────────────── */

int main(int argc, char** argv) {
    if (argc > 1 && strcmp(argv[1], "--check") == 0) return cmd_check();
    if (argc > 1 && strcmp(argv[1], "--remove") == 0) return cmd_remove();
    return cmd_create();
}
