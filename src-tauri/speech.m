#import <AVFoundation/AVFoundation.h>
#import <string.h>

// Dashledge's own voice for spoken reminders. It plays through Dashledge's audio, so
// muting it or turning it down leaves the system volume and other apps alone.

static AVSpeechSynthesizer *synth(void) {
    static AVSpeechSynthesizer *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [[AVSpeechSynthesizer alloc] init]; });
    return shared;
}

// Speak `text` with the voice `identifier` (empty for the system voice) at `volume` 0…1.
void speech_say(const char *text, const char *identifier, float volume) {
    NSString *words = [NSString stringWithUTF8String:text];
    NSString *voiceId = [NSString stringWithUTF8String:identifier];
    if (!words.length) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:words];
        AVSpeechSynthesisVoice *voice = voiceId.length ? [AVSpeechSynthesisVoice voiceWithIdentifier:voiceId] : nil;
        utterance.voice = voice ?: [AVSpeechSynthesisVoice voiceWithLanguage:[AVSpeechSynthesisVoice currentLanguageCode]];
        utterance.volume = MAX(0.f, MIN(1.f, volume));
        [synth() speakUtterance:utterance];
    });
}

void speech_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [synth() stopSpeakingAtBoundary:AVSpeechBoundaryImmediate]; });
}

// Installed voices in the system language first: [{id, name, language, quality}], where
// quality is 1 default, 2 enhanced, 3 premium. The caller frees the string.
char *speech_voices(void) {
    @autoreleasepool {
        NSString *language = [[AVSpeechSynthesisVoice currentLanguageCode] componentsSeparatedByString:@"-"].firstObject ?: @"en";
        NSMutableArray *out = [NSMutableArray array];
        for (AVSpeechSynthesisVoice *voice in AVSpeechSynthesisVoice.speechVoices) {
            if (![voice.language hasPrefix:language]) continue;
            if (@available(macOS 14.0, *)) { if (voice.voiceTraits & AVSpeechSynthesisVoiceTraitIsNoveltyVoice) continue; }
            [out addObject:@{@"id":voice.identifier ?: @"", @"name":voice.name ?: @"", @"language":voice.language ?: @"",
                             @"quality":@((long)voice.quality)}];
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL];
        return json ? strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String) : NULL;
    }
}
