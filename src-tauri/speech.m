#import <AVFoundation/AVFoundation.h>

// Plays the natural voice's audio: WAV files the speech runtime wrote, at Dashledge's
// own volume, so muting it or turning it down leaves the system volume and other apps
// alone.

static AVAudioPlayer *player;

// Plays `path` at `volume` 0…1, replacing whatever is playing. Returns its length in
// seconds, or 0 when it can't be played.
double speech_play_file(const char *path, float volume) {
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    NSError *error = nil;
    AVAudioPlayer *next = [[AVAudioPlayer alloc] initWithContentsOfURL:url error:&error];
    if (!next) return 0;
    next.volume = MAX(0.f, MIN(1.f, volume));
    [next prepareToPlay];
    double seconds = next.duration;
    dispatch_async(dispatch_get_main_queue(), ^{
        [player stop];
        player = next;
        [player play];
    });
    return seconds;
}

void speech_stop(void) {
    dispatch_async(dispatch_get_main_queue(), ^{ [player stop]; });
}
