#import <AVFoundation/AVFoundation.h>
#import <string.h>

// Dashledge's own voice for spoken reminders. It plays through Dashledge's audio, so
// muting it or turning it down leaves the system volume and other apps alone.

// Siri's neural voices are installed for Siri and read well; Apple lists them with
// placeholder names ("Voice 4"), so the real name comes from the identifier.
static BOOL isSiri(AVSpeechSynthesisVoice *voice) {
    NSString *id = voice.identifier ?: @"";
    return [id containsString:@".siri."] || [id containsString:@"gryphon-neural"];
}

static NSString *siriName(AVSpeechSynthesisVoice *voice) {
    NSString *id = voice.identifier ?: @"";
    NSArray *parts = [id containsString:@"gryphon-neural_"] ? [[id componentsSeparatedByString:@"gryphon-neural_"].lastObject componentsSeparatedByString:@"_"]
                                                             : @[[id componentsSeparatedByString:@"."].lastObject ?: @""];
    NSString *name = parts.firstObject ?: @"";
    return name.length ? name.capitalizedString : voice.name;
}

// Higher is better: Siri natural, Siri neural, premium, enhanced, default.
static NSInteger rank(AVSpeechSynthesisVoice *voice) {
    if ([voice.identifier containsString:@".siri.natural."]) return 5;
    if (isSiri(voice)) return 4;
    return (NSInteger)voice.quality;
}

static BOOL usable(AVSpeechSynthesisVoice *voice, NSString *language) {
    if (![voice.language hasPrefix:language]) return NO;
    if (@available(macOS 14.0, *)) { if (voice.voiceTraits & AVSpeechSynthesisVoiceTraitIsNoveltyVoice) return NO; }
    return YES;
}

static NSString *systemLanguage(void) {
    return [[AVSpeechSynthesisVoice currentLanguageCode] componentsSeparatedByString:@"-"].firstObject ?: @"en";
}

// The best installed voice in the system language, preferring the exact region.
static AVSpeechSynthesisVoice *bestVoice(void) {
    NSString *language = systemLanguage(), *region = [AVSpeechSynthesisVoice currentLanguageCode];
    AVSpeechSynthesisVoice *best = nil;
    NSInteger bestScore = -1;
    for (AVSpeechSynthesisVoice *voice in AVSpeechSynthesisVoice.speechVoices) {
        if (!usable(voice, language)) continue;
        NSInteger score = rank(voice) * 2 + ([voice.language isEqualToString:region] ? 1 : 0);
        if (score > bestScore) { best = voice; bestScore = score; }
    }
    return best;
}

// The natural voice's audio: a WAV the runtime wrote, played at Dashledge's volume.
static AVAudioPlayer *player;

static AVSpeechSynthesizer *synth(void) {
    static AVSpeechSynthesizer *shared;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ shared = [[AVSpeechSynthesizer alloc] init]; });
    return shared;
}

// Speak `text` with the voice `identifier` (empty for the best installed) at `volume` 0…1.
void speech_say(const char *text, const char *identifier, float volume) {
    NSString *words = [NSString stringWithUTF8String:text];
    NSString *voiceId = [NSString stringWithUTF8String:identifier];
    if (!words.length) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        [player stop];
        [synth() stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
        AVSpeechUtterance *utterance = [AVSpeechUtterance speechUtteranceWithString:words];
        AVSpeechSynthesisVoice *voice = voiceId.length ? [AVSpeechSynthesisVoice voiceWithIdentifier:voiceId] : nil;
        utterance.voice = voice ?: bestVoice() ?: [AVSpeechSynthesisVoice voiceWithLanguage:[AVSpeechSynthesisVoice currentLanguageCode]];
        utterance.volume = MAX(0.f, MIN(1.f, volume));
        [synth() speakUtterance:utterance];
    });
}


void speech_play_file(const char *path, float volume) {
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    dispatch_async(dispatch_get_main_queue(), ^{
        [synth() stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
        [player stop];
        NSError *error = nil;
        player = [[AVAudioPlayer alloc] initWithContentsOfURL:url error:&error];
        player.volume = MAX(0.f, MIN(1.f, volume));
        [player play];
    });
}

void speech_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [synth() stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
        [player stop];
    });
}

// Installed voices in the system language, best first: [{id, name, language, quality,
// siri, best}], where quality is 1 default, 2 enhanced, 3 premium and `best` marks the
// one an empty choice uses. The caller frees the string.
char *speech_voices(void) {
    @autoreleasepool {
        NSString *language = systemLanguage();
        NSString *bestId = bestVoice().identifier ?: @"";
        NSMutableArray *voices = [NSMutableArray array];
        for (AVSpeechSynthesisVoice *voice in AVSpeechSynthesisVoice.speechVoices)
            if (usable(voice, language)) [voices addObject:voice];
        [voices sortUsingComparator:^NSComparisonResult(AVSpeechSynthesisVoice *a, AVSpeechSynthesisVoice *b) {
            if (rank(a) != rank(b)) return rank(a) > rank(b) ? NSOrderedAscending : NSOrderedDescending;
            return [a.name localizedCaseInsensitiveCompare:b.name];
        }];
        NSMutableArray *out = [NSMutableArray array];
        for (AVSpeechSynthesisVoice *voice in voices) {
            BOOL siri = isSiri(voice);
            [out addObject:@{@"id":voice.identifier ?: @"", @"name":(siri ? siriName(voice) : voice.name) ?: @"", @"language":voice.language ?: @"",
                             @"quality":@((long)voice.quality), @"siri":@(siri), @"best":@([voice.identifier isEqualToString:bestId])}];
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:NULL];
        return json ? strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String) : NULL;
    }
}
