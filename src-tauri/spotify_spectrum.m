#import <AppKit/AppKit.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <Accelerate/Accelerate.h>
#include <stdatomic.h>
#include <time.h>

enum { bands = 32, wavePoints = 256, fftPower = 11, frames = 1 << fftPower };
typedef struct {
    FFTSetup fft;
    float window[frames], samples[frames], real[frames/2], imag[frames/2], power[frames/2];
    unsigned ends[bands], used;
    atomic_uchar levels[bands], wave[wavePoints];
    atomic_uint_fast64_t lastFrame;
} Spectrum;

static uint64_t nowNS(void) { return clock_gettime_nsec_np(CLOCK_UPTIME_RAW); }

static void prepare(Spectrum *s, double rate) {
    s->used=0;
    vDSP_hann_window(s->window, frames, vDSP_HANN_NORM);
    unsigned start=1;
    for(unsigned b=0;b<bands;b++) {
        double hz=50.0*pow(fmin(16000.0,rate/2)/50.0,(b+1.0)/bands);
        s->ends[b]=MIN(frames/2, MAX(start+1,(unsigned)ceil(hz*frames/rate)));
        start=s->ends[b];
        atomic_store(&s->levels[b],0);
    }
    atomic_store(&s->lastFrame,0);
}

static void calculate(Spectrum *s) {
    // Trigger the trace on a rising zero crossing to steady periodic signals.
    unsigned startSample=0;
    for(unsigned i=1;i<frames/2;i++){
        if(s->samples[i-1]<=0 && s->samples[i]>0){startSample=i;break;}
    }
    for(unsigned i=0;i<wavePoints;i++){
        float sample=fminf(1,fmaxf(-1,s->samples[startSample+i]));
        atomic_store_explicit(&s->wave[i],(unsigned char)lrintf(128+127*sample),memory_order_relaxed);
    }
    vDSP_vmul(s->samples,1,s->window,1,s->samples,1,frames);
    DSPSplitComplex z={s->real,s->imag};
    vDSP_ctoz((DSPComplex *)s->samples,2,&z,1,frames/2);
    vDSP_fft_zrip(s->fft,&z,1,fftPower,FFT_FORWARD);
    vDSP_zvmags(&z,1,s->power,1,frames/2);
    unsigned start=1;
    for(unsigned b=0;b<bands;b++) {
        float peak=0;
        for(unsigned i=start;i<s->ends[b];i++) peak=fmaxf(peak,s->power[i]);
        float db=10*log10f(fmaxf(peak/(frames*frames),1e-12f));
        atomic_store_explicit(&s->levels[b],(unsigned char)(255*fminf(1,fmaxf(0,(db+65)/65))),memory_order_relaxed);
        start=s->ends[b];
    }
    atomic_store(&s->lastFrame,nowNS());
}

static OSStatus receive(AudioObjectID dev,const AudioTimeStamp *now,const AudioBufferList *input,
                        const AudioTimeStamp *inTime,AudioBufferList *output,const AudioTimeStamp *outTime,void *context) {
    (void)dev;(void)now;(void)inTime;(void)output;(void)outTime;
    if(!input||!input->mNumberBuffers)return noErr;
    const AudioBuffer *buffer=&input->mBuffers[0];
    if(!buffer->mData||buffer->mNumberChannels!=1)return noErr;
    const float *data=buffer->mData;
    unsigned count=buffer->mDataByteSize/sizeof(float);
    Spectrum *s=context;
    while(count) {
        unsigned n=MIN(count,frames-s->used);
        memcpy(s->samples+s->used,data,n*sizeof(float));
        s->used+=n;data+=n;count-=n;
        if(s->used==frames){calculate(s);s->used=0;}
    }
    return noErr;
}

static NSArray<NSNumber *> *audioProcesses(NSString *identifier) API_AVAILABLE(macos(14.2)) {
    AudioObjectPropertyAddress list={kAudioHardwarePropertyProcessObjectList,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    UInt32 size=0;
    if(AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&list,0,NULL,&size)||!size)return @[];
    NSMutableData *storage=[NSMutableData dataWithLength:size];
    AudioObjectID *ids=storage.mutableBytes;
    if(AudioObjectGetPropertyData(kAudioObjectSystemObject,&list,0,NULL,&size,ids))return @[];
    NSMutableArray *matches=[NSMutableArray array];
    AudioObjectPropertyAddress prop={kAudioProcessPropertyBundleID,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    for(unsigned i=0;i<size/sizeof(*ids);i++){
        CFStringRef raw=NULL;UInt32 len=sizeof(raw);
        if(AudioObjectGetPropertyData(ids[i],&prop,0,NULL,&len,&raw))continue;
        NSString *bundle=CFBridgingRelease(raw);
        if(bundle && ([bundle caseInsensitiveCompare:identifier]==NSOrderedSame||[bundle.lowercaseString hasPrefix:[identifier.lowercaseString stringByAppendingString:@"."]]))
            [matches addObject:@(ids[i])];
    }
    // Some HAL process objects expose a PID without bundle metadata.
    if(!matches.count){
        AudioObjectPropertyAddress translate={kAudioHardwarePropertyTranslatePIDToProcessObject,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
        for(NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:identifier]){
            pid_t pid=app.processIdentifier;
            AudioObjectID object=kAudioObjectUnknown;
            UInt32 bytes=sizeof(object);
            if(!AudioObjectGetPropertyData(kAudioObjectSystemObject,&translate,sizeof(pid),&pid,&bytes,&object) && object!=kAudioObjectUnknown)
                [matches addObject:@(object)];
        }
    }
    return matches;
}

@interface EWMusicCapture : NSObject {
Spectrum analyzer;
AudioObjectID tap, device;
AudioDeviceIOProcID ioProc;
dispatch_source_t watchdog;
uint64_t lastPoll,started;
}
@end
@implementation EWMusicCapture
- (void)stop API_AVAILABLE(macos(14.2)) {
    if(watchdog){dispatch_source_cancel(watchdog);watchdog=nil;}
    if(ioProc){AudioDeviceStop(device,ioProc);AudioDeviceDestroyIOProcID(device,ioProc);ioProc=NULL;}
    if(device){AudioHardwareDestroyAggregateDevice(device);device=0;}
    if(tap){AudioHardwareDestroyProcessTap(tap);tap=0;}
    if(analyzer.fft){vDSP_destroy_fftsetup(analyzer.fft);analyzer.fft=NULL;}
}

// 1 = no local Spotify output; 2 = setup/access failure; 3 = unsupported macOS.
- (int)start:(NSString *)identifier API_AVAILABLE(macos(14.2)) {
    NSArray *sources=audioProcesses(identifier);
    if(!sources.count)return 1;
    CATapDescription *desc=[[CATapDescription alloc] initMonoMixdownOfProcesses:sources];
    desc.name=[@"Dashledge spectrum " stringByAppendingString:identifier];desc.privateTap=YES;desc.muteBehavior=CATapUnmuted;
    if(@available(macOS 26.0,*)){desc.processRestoreEnabled=YES;}
    if(AudioHardwareCreateProcessTap(desc,&tap)!=noErr)return 2;
    AudioObjectPropertyAddress formatKey={kAudioTapPropertyFormat,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    AudioStreamBasicDescription format={0};UInt32 size=sizeof(format);
    if(AudioObjectGetPropertyData(tap,&formatKey,0,NULL,&size,&format)||format.mFormatID!=kAudioFormatLinearPCM||
       !(format.mFormatFlags&kAudioFormatFlagIsFloat)||format.mBitsPerChannel!=32||format.mChannelsPerFrame!=1||format.mSampleRate<=0)return 2;
    NSDictionary *config=@{@kAudioAggregateDeviceNameKey:desc.name,@kAudioAggregateDeviceUIDKey:NSUUID.UUID.UUIDString,
        @kAudioAggregateDeviceIsPrivateKey:@YES,@kAudioAggregateDeviceTapAutoStartKey:@NO,
        @kAudioAggregateDeviceTapListKey:@[@{@kAudioSubTapUIDKey:desc.UUID.UUIDString,@kAudioSubTapDriftCompensationKey:@YES}]};
    if(AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)config,&device))return 2;
    analyzer.fft=vDSP_create_fftsetup(fftPower,kFFTRadix2);
    if(!analyzer.fft)return 2;
    prepare(&analyzer,format.mSampleRate);
    if(AudioDeviceCreateIOProcID(device,receive,&analyzer,&ioProc)||AudioDeviceStart(device,ioProc))return 2;
    watchdog=dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER,0,0,dispatch_get_global_queue(QOS_CLASS_UTILITY,0));
    dispatch_source_set_timer(watchdog,dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),NSEC_PER_SEC,NSEC_PER_SEC/10);
    dispatch_source_set_event_handler(watchdog,^{
        @synchronized([CATapDescription class]){if(nowNS()-lastPoll>2*NSEC_PER_SEC)[self stop];}
    });
    started=nowNS();
    dispatch_resume(watchdog);
    return 0;
}

- (int)sample:(unsigned char *)levels wave:(unsigned char *)wave bundle:(NSString *)identifier {
    @autoreleasepool {
        if(@available(macOS 14.2,*)){
            @synchronized([CATapDescription class]){
                lastPoll=nowNS();
                uint64_t frameTime=atomic_load(&analyzer.lastFrame);
                if(ioProc && lastPoll>MAX(frameTime,started)+5*NSEC_PER_SEC)
                    [self stop];
                if(!ioProc){int state=[self start:identifier];if(state){[self stop];return state;}}
                uint64_t latest=atomic_load(&analyzer.lastFrame);
                bool fresh=latest && nowNS()-latest<250*NSEC_PER_MSEC;
                for(unsigned i=0;i<bands;i++)levels[i]=fresh?atomic_load(&analyzer.levels[i]):0;
                if(wave)for(unsigned i=0;i<wavePoints;i++)wave[i]=fresh?atomic_load(&analyzer.wave[i]):128;
                return 0;
            }
        }
        return 3;
    }
}
@end

int ew_music_spectrum(bool apple,unsigned char *levels,unsigned char *wave) {
    static EWMusicCapture *music,*spotify;
    static dispatch_once_t once;
    dispatch_once(&once,^{music=[EWMusicCapture new];spotify=[EWMusicCapture new];});
    return [(apple?music:spotify) sample:levels wave:wave bundle:(apple?@"com.apple.Music":@"com.spotify.client")];
}
