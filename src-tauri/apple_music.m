#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>
#import <LinkPresentation/LinkPresentation.h>
#import "Music.h"

@interface EWMusicErrors : NSObject <SBApplicationDelegate>
@property(copy) NSString *message;
@end
@implementation EWMusicErrors
- (id)eventDidFail:(const AppleEvent *)event withError:(NSError *)error {
    if(error.code == -1743)
        self.message=@"Allow Dashledge to control Music in System Settings › Privacy & Security › Automation.";
    else if(!self.message)
        self.message=error.localizedDescription;
    return nil;
}
@end

static NSString *thumbnail(id data,NSInteger size) {
    if([data isKindOfClass:NSAppleEventDescriptor.class]) data=[data data];
    if([data isKindOfClass:NSImage.class]) data=[data TIFFRepresentation];
    if(![data isKindOfClass:NSData.class])return @"";
    CGImageSourceRef source=CGImageSourceCreateWithData((__bridge CFDataRef)data,NULL);
    if(!source)return @"";
    NSDictionary *options=@{(__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways:@YES,
                            (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize:@(size)};
    CGImageRef image=CGImageSourceCreateThumbnailAtIndex(source,0,(__bridge CFDictionaryRef)options);
    CFRelease(source);
    if(!image)return @"";
    NSBitmapImageRep *rep=[[NSBitmapImageRep alloc] initWithCGImage:image];
    CGImageRelease(image);
    NSData *jpeg=[rep representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@0.85}];
    return jpeg?[@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]]:@"";
}

static NSString *artworkImage(NSArray *artworks,NSInteger size) {
    for(MusicArtwork *art in artworks){
        NSString *image=thumbnail(art.rawData,size);
        if(!image.length)image=thumbnail(art.data,size);
        if(image.length)return image;
    }
    return @"";
}

static NSString *cover(MusicTrack *track) { return artworkImage(track.artworks,640); }

// Executed on a blocking worker outside the Music Apple-event lock.
static NSArray *catalogRows(NSURLComponents *url) {
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block NSArray *rows=nil;
    NSURLRequest *req=[NSURLRequest requestWithURL:url.URL cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:7];
    NSURLSessionDataTask *task=[NSURLSession.sharedSession dataTaskWithRequest:req completionHandler:^(NSData *bytes,NSURLResponse *response,NSError *error){
        if(!error && [(NSHTTPURLResponse *)response statusCode]==200 && bytes.length){
            id json=[NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
            if([json isKindOfClass:NSDictionary.class] && [json[@"results"] isKindOfClass:NSArray.class])rows=json[@"results"];
        }
        dispatch_semaphore_signal(done);
    }];
    [task resume];
    if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,8*NSEC_PER_SEC))){[task cancel];return @[];}
    return rows?:@[];
}

static NSArray *searchCatalog(NSString *term, NSString *entity, NSString *country) {
    NSURLComponents *url=[NSURLComponents componentsWithString:@"https://itunes.apple.com/search"];
    url.queryItems=@[[NSURLQueryItem queryItemWithName:@"term" value:term],
                     [NSURLQueryItem queryItemWithName:@"entity" value:entity],
                     [NSURLQueryItem queryItemWithName:@"country" value:country],
                     [NSURLQueryItem queryItemWithName:@"limit" value:@"25"]];
    return catalogRows(url);
}

static NSArray *catalogAlbum(NSString *identifier) {
    if(identifier.longLongValue<=0)return @[];
    NSURLComponents *url=[NSURLComponents componentsWithString:@"https://itunes.apple.com/lookup"];
    url.queryItems=@[[NSURLQueryItem queryItemWithName:@"id" value:identifier],
                     [NSURLQueryItem queryItemWithName:@"entity" value:@"song"],
                     [NSURLQueryItem queryItemWithName:@"country" value:NSLocale.currentLocale.countryCode?:@"US"],
                     [NSURLQueryItem queryItemWithName:@"limit" value:@"200"]];
    NSMutableArray *tracks=[NSMutableArray array];
    for(NSDictionary *row in catalogRows(url)){
        if(![row[@"kind"] isEqual:@"song"] || [row[@"collectionId"] longLongValue]!=identifier.longLongValue)continue;
        [tracks addObject:@{@"title":row[@"trackName"]?:@"",@"artist":row[@"artistName"]?:@"",
            @"disc":row[@"discNumber"]?:@1,@"number":row[@"trackNumber"]?:@0}];
    }
    return tracks;
}

static BOOL sameName(NSString *name, NSString *target) {
    return [name isKindOfClass:NSString.class] && [name compare:target options:NSCaseInsensitiveSearch|NSDiacriticInsensitiveSearch]==NSOrderedSame;
}

static NSDictionary *catalogArt(NSString *artist, NSString *album) {
    if(!artist.length)return @{};
    NSString *country=NSLocale.currentLocale.countryCode?:@"US";
    NSMutableDictionary *result=[NSMutableDictionary dictionary];
    if(album.length){
        for(NSDictionary *row in searchCatalog([NSString stringWithFormat:@"%@ %@",artist,album],@"album",country)){
            if(!sameName(row[@"collectionName"],album)||!sameName(row[@"artistName"],artist))continue;
            result[@"collectionId"]=row[@"collectionId"];
            NSURL *image=[NSURL URLWithString:row[@"artworkUrl100"]?:@""];
            if([image.scheme isEqual:@"https"] && [image.host hasSuffix:@".mzstatic.com"])result[@"cover"]=image.absoluteString;
            if([row[@"artistId"] isKindOfClass:NSNumber.class])result[@"artistId"]=row[@"artistId"];
            break;
        }
    }
    if(!result[@"artistId"]){
        for(NSDictionary *row in searchCatalog(artist,@"musicArtist",country)){
            if(sameName(row[@"artistName"],artist) && [row[@"artistId"] isKindOfClass:NSNumber.class]){
                result[@"artistId"]=row[@"artistId"];break;
            }
        }
    }
    return result;
}

static NSDictionary *artistPortrait(NSString *identifier) {
    if(identifier.longLongValue<=0)return @{};
    NSString *country=NSLocale.currentLocale.countryCode.lowercaseString?:@"us";
    NSURL *url=[NSURL URLWithString:[NSString stringWithFormat:@"https://music.apple.com/%@/artist/%lld",country,identifier.longLongValue]];
    LPMetadataProvider *provider=[LPMetadataProvider new];provider.timeout=8;
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block NSString *portrait=nil;
    [provider startFetchingMetadataForURL:url completionHandler:^(LPLinkMetadata *meta,NSError *error){
        NSItemProvider *image=meta.imageProvider;
        if(error || ![image canLoadObjectOfClass:NSImage.class]){dispatch_semaphore_signal(done);return;}
        [image loadObjectOfClass:NSImage.class completionHandler:^(id<NSItemProviderReading> value,NSError *failure){
            if(!failure)portrait=thumbnail(value,640);
            dispatch_semaphore_signal(done);
        }];
    }];
    if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,12*NSEC_PER_SEC))){[provider cancel];return @{};}
    return portrait.length?@{@"portrait":portrait}:@{};
}

// Read one property of a bounded playlist range per Apple event.
// ScriptingBridge's arrayByApplyingSelector only supports object-returning accessors.
static NSAppleEventDescriptor *musicObject(OSType cls, OSType form, NSAppleEventDescriptor *key, NSAppleEventDescriptor *container) {
    NSAppleEventDescriptor *record=[NSAppleEventDescriptor recordDescriptor];
    [record setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:cls] forKeyword:keyAEDesiredClass];
    [record setDescriptor:[NSAppleEventDescriptor descriptorWithEnumCode:form] forKeyword:keyAEKeyForm];
    [record setDescriptor:key forKeyword:keyAEKeyData];
    [record setDescriptor:container forKeyword:keyAEContainer];
    return [record coerceToDescriptorType:typeObjectSpecifier];
}

static NSAppleEventDescriptor *playlistColumn(NSAppleEventDescriptor *items, OSType property) {
    NSAppleEventDescriptor *column=musicObject(cProperty,formPropertyID,[NSAppleEventDescriptor descriptorWithTypeCode:property],items);
    NSAppleEventDescriptor *event=[NSAppleEventDescriptor appleEventWithEventClass:kAECoreSuite eventID:kAEGetData
        targetDescriptor:[NSAppleEventDescriptor descriptorWithBundleIdentifier:@"com.apple.Music"]
        returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    [event setParamDescriptor:column forKeyword:keyDirectObject];
    NSAppleEventDescriptor *reply=[event sendEventWithOptions:NSAppleEventSendWaitForReply timeout:5 error:nil];
    return [reply paramDescriptorForKeyword:keyDirectObject];
}

static id playlistPage(MusicSource *library, NSInteger offset, NSInteger limit, EWMusicErrors *errors) {
    SBElementArray *list=library.userPlaylists;
    NSInteger total=list.count, end=MIN(total,offset+limit);
    NSString *libraryKey=library.persistentID?:@"";
    if(errors.message)return @{@"error":errors.message};
    if(offset>=total)return @{@"rows":@[],@"next":NSNull.null,@"total":@(total),@"library":libraryKey};
    NSAppleEventDescriptor *source=musicObject('cSrc',formUniqueID,[NSAppleEventDescriptor descriptorWithInt32:(int)library.id],[NSAppleEventDescriptor nullDescriptor]);
    NSAppleEventDescriptor *bounds=[NSAppleEventDescriptor recordDescriptor];
    [bounds setDescriptor:musicObject('cUsP',formAbsolutePosition,[NSAppleEventDescriptor descriptorWithInt32:(int)offset+1],source) forKeyword:keyAERangeStart];
    [bounds setDescriptor:musicObject('cUsP',formAbsolutePosition,[NSAppleEventDescriptor descriptorWithInt32:(int)end],source) forKeyword:keyAERangeStop];
    NSAppleEventDescriptor *items=musicObject('cUsP',formRange,[bounds coerceToDescriptorType:typeRangeDescriptor],source);
    NSAppleEventDescriptor *ids=playlistColumn(items,'ID  '),*keys=playlistColumn(items,'pPIS'),
        *names=playlistColumn(items,'pnam'),*kinds=playlistColumn(items,'pSpK');
    NSMutableArray *rows=[NSMutableArray array];
    if(ids.descriptorType==typeAEList && keys.descriptorType==typeAEList && names.descriptorType==typeAEList && kinds.descriptorType==typeAEList &&
       ids.numberOfItems==end-offset && ids.numberOfItems==keys.numberOfItems && ids.numberOfItems==names.numberOfItems && ids.numberOfItems==kinds.numberOfItems){
        for(NSInteger i=1;i<=ids.numberOfItems;i++){
            if([kinds descriptorAtIndex:i].enumCodeValue==MusicESpKFolder)continue;
            NSString *key=[keys descriptorAtIndex:i].stringValue,*name=[names descriptorAtIndex:i].stringValue;
            if(!key.length || !name)return @{@"error":@"Music changed the playlist list. Refresh to try again."};
            [rows addObject:@{@"id":@([ids descriptorAtIndex:i].int32Value).stringValue,@"key":key,@"name":name}];
        }
    }else{
        for(NSInteger index=offset;index<end;index++){
            MusicPlaylist *p=list[index];
            if(p.specialKind==MusicESpKFolder)continue;
            NSString *key=p.persistentID;
            if(key.length)[rows addObject:@{@"id":@(p.id).stringValue,@"key":key,@"name":p.name?:@""}];
        }
    }
    return errors.message?@{@"error":errors.message}:@{@"rows":rows,@"next":end<total?@(end):NSNull.null,@"total":@(total),@"library":libraryKey};
}

static NSDictionary *song(MusicTrack *track) {
    return @{@"uri":@(track.id).stringValue,@"title":track.name?:@"", @"artist":track.artist?:@""};
}

static NSDictionary *musicSound(MusicApplication *app) {
    NSMutableArray *devices=[NSMutableArray array], *presets=[NSMutableArray array];
    for(MusicAirPlayDevice *dev in app.AirPlayDevices){
        if(dev.available && dev.supportsAudio)
            [devices addObject:@{@"id":@(dev.id).stringValue,@"name":dev.name?:@"AirPlay",
                @"selected":@(dev.selected),@"volume":@(dev.soundVolume)}];
    }
    for(MusicEQPreset *preset in app.EQPresets)if(preset.name)[presets addObject:preset.name];
    MusicEShM mode=app.shuffleMode;
    return @{@"devices":devices,@"volume":@(app.soundVolume),@"presets":presets,
        @"preset":app.currentEQPreset.name?:@"",@"eq":@(app.EQEnabled),
        @"shuffle":app.shuffleEnabled?(mode==MusicEShMAlbums?@"Albums":mode==MusicEShMGroupings?@"Groupings":@"Songs"):@"Off"};
}

static NSDictionary *trackDetails(MusicTrack *t) {
    if(!t.exists)return @{@"error":@"There is no current song."};
    return @{@"id":t.persistentID?:@"",@"title":t.name?:@"",@"artist":t.artist?:@"",
        @"rating":@(t.rating/20),@"computed":@(t.ratingKind==MusicERtKComputed),@"album":t.album?:@"",
        @"year":@(t.year),@"genre":t.genre?:@"",@"composer":t.composer?:@"",@"bpm":@(t.bpm),
        @"format":t.kind?:@"",@"bitrate":@(t.bitRate),@"rate":@(t.sampleRate),
        @"plays":@(t.playedCount),@"skips":@(t.skippedCount),
        @"lastPlayed":@(t.playedDate.timeIntervalSince1970),@"disc":@(t.discNumber),@"track":@(t.trackNumber)};
}

static id musicRequest(NSString *action, NSString *value, NSString *known) {
    BOOL running=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.Music"].count>0;
    if(!running && [action isEqualToString:@"state"]) return @{@"running":@NO};
    if(!running){
        NSWorkspace *workspace=NSWorkspace.sharedWorkspace;
        NSURL *url=[workspace URLForApplicationWithBundleIdentifier:@"com.apple.Music"];
        if(!url)return @{@"error":@"Music is unavailable on this Mac."};
        NSWorkspaceOpenConfiguration *config=[NSWorkspaceOpenConfiguration configuration];
        config.activates=NO;
        dispatch_semaphore_t ready=dispatch_semaphore_create(0);
        __block NSError *launchError=nil;
        [workspace openApplicationAtURL:url configuration:config completionHandler:^(NSRunningApplication *application,NSError *error){
            (void)application;
            launchError=error;
            dispatch_semaphore_signal(ready);
        }];
        if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC)) || launchError)
            return @{@"error":launchError.localizedDescription?:@"Music took too long to start."};
    }
    MusicApplication *app=[SBApplication applicationWithBundleIdentifier:@"com.apple.Music"];
    EWMusicErrors *errors=[EWMusicErrors new];
    app.delegate=errors;
    app.timeout=300;
    if([action isEqualToString:@"state"]){
        MusicEPlS state=app.playerState;
        if(errors.message)return @{@"error":errors.message};
        MusicTrack *t=app.currentTrack;
        if(!t.exists)return @{@"running":@YES};
        MusicPlaylist *p=app.currentPlaylist;
        BOOL hasPlaylist=p.exists;
        BOOL shuffle=app.shuffleEnabled;
        MusicERpt repeat=app.songRepeat;
        NSString *identity=t.persistentID;
        if(!identity.length||[identity isEqual:@"0000000000000000"])identity=[NSString stringWithFormat:@"%@/%@/%@",t.name,t.artist,t.album];
        NSString *key=[NSString stringWithFormat:@"%@/%ld/%ld/%d/%d",identity,(long)t.id,(long)(hasPlaylist?p.id:0),shuffle,repeat];
        NSMutableDictionary *d=[@{@"running":@YES,@"playing":@(state==MusicEPlSPlaying),@"position":@(app.playerPosition),
            @"key":key,@"favorite":@(t.favorited),@"repeat":repeat==MusicERptOne?@"track":repeat==MusicERptAll?@"context":@"off",@"shuffle":@(shuffle)} mutableCopy];
        if(![key isEqualToString:known]){
            [d addEntriesFromDictionary:song(t)];
            d[@"album"]=t.album?:@""; d[@"duration"]=@(t.duration); d[@"artwork"]=cover(t);
            MusicESpK kind=hasPlaylist?p.specialKind:MusicESpKNone;
            BOOL playlist=hasPlaylist && kind!=MusicESpKLibrary && kind!=MusicESpKMusic && ![p isKindOfClass:NSClassFromString(@"MusicLibraryPlaylist")];
            d[@"playlist"]=playlist?(p.name?:@""):@"";
            d[@"albumOrder"]=@(!playlist && t.album.length>0);
            d[@"disc"]=@(t.discNumber); d[@"number"]=@(t.trackNumber);
            d[@"trackCount"]=@(t.trackCount); d[@"discCount"]=@(t.discCount);
            NSString *albumArtist=t.albumArtist;
            d[@"albumArtist"]=albumArtist.length?albumArtist:d[@"artist"];
            NSMutableArray *up=[NSMutableArray array];
            if(playlist&&!shuffle&&repeat!=MusicERptOne){
                SBElementArray *tracks=p.tracks;
                NSInteger i=t.index, count=tracks.count;
                if(i>0 && i<=count && [(MusicTrack *)tracks[i-1] databaseID]==t.databaseID && t.databaseID>0){
                    for(NSInteger j=0;j<MIN(7,count-((repeat==MusicERptAll)?0:i));j++)
                        [up addObject:song(tracks[(i+j)%count])];
                }else if(t.album.length){
                    // A transient playback container can lack an addressable playlist position.
                    d[@"albumOrder"]=@YES;
                }
            }
            d[@"up"]=up;
        }
        return d;
    }
    if([action isEqualToString:@"play"]) [app playOnce:NO];
    else if([action isEqualToString:@"pause"]) [app pause];
    else if([action isEqualToString:@"next"]) [app nextTrack];
    else if([action isEqualToString:@"previous"]) [app previousTrack];
    else if([action isEqualToString:@"shuffle"]) app.shuffleEnabled=!app.shuffleEnabled;
    else if([action isEqualToString:@"repeat"]) app.songRepeat=app.songRepeat==MusicERptOff?MusicERptAll:app.songRepeat==MusicERptAll?MusicERptOne:MusicERptOff;
    else if([action isEqualToString:@"seek"]) app.playerPosition=MAX(0,value.doubleValue);
    else if([action isEqualToString:@"favorite"]) app.currentTrack.favorited=!app.currentTrack.favorited;
    else if([action isEqualToString:@"volume"]) app.soundVolume=MAX(0,MIN(100,value.integerValue));
    else if([action isEqualToString:@"devices"]){
        return musicSound(app);
    }else if([action isEqualToString:@"details"]){
        MusicTrack *t=app.currentTrack;
        NSMutableDictionary *details=[trackDetails(t) mutableCopy];
        if(!details[@"error"]){
            details[@"preset"]=t.EQ?:@"";
            details[@"presets"]=[app.EQPresets arrayByApplyingSelector:@selector(name)]?:@[];
        }
        return details;
    }else if([action isEqualToString:@"track-preset"]){
        MusicTrack *t=app.currentTrack;
        if(!known.length||![known isEqualToString:t.persistentID])return @{@"error":@"The song changed. Reopen Song info to choose its preset."};
        if(value.length&&![[app.EQPresets objectWithName:value] exists])return @{@"error":@"This EQ preset is no longer available."};
        t.EQ=value;
    }else if([action isEqualToString:@"rating"]){
        MusicTrack *t=app.currentTrack;
        if(!known.length||![t.persistentID isEqualToString:known])return @{@"error":@"The song changed. Reopen Song info to rate it."};
        if(![@[@"0",@"1",@"2",@"3",@"4",@"5"] containsObject:value])return @{@"error":@"Choose zero to five stars."};
        t.rating=value.integerValue*20;
    }else if([action isEqualToString:@"eq-off"]){
        app.EQEnabled=NO;
    }else if([action isEqualToString:@"preset"]){
        MusicEQPreset *preset=[app.EQPresets objectWithName:value];
        if(!preset.exists)return @{@"error":@"This EQ preset is no longer available."};
        app.currentEQPreset=preset;
        if(!errors.message)app.EQEnabled=YES;
    }else if([action isEqualToString:@"shuffle-mode"]){
        if([value isEqualToString:@"Off"])app.shuffleEnabled=NO;
        else{
            NSDictionary *modes=@{@"Songs":@(MusicEShMSongs),@"Albums":@(MusicEShMAlbums),@"Groupings":@(MusicEShMGroupings)};
            if(!modes[value])return @{@"error":@"Unknown shuffle mode."};
            app.shuffleMode=[modes[value] unsignedIntValue];
            if(!errors.message)app.shuffleEnabled=YES;
        }
    }else if([action isEqualToString:@"device"]||[action isEqualToString:@"speaker-volume"]){
        MusicAirPlayDevice *dev=[app.AirPlayDevices objectWithID:@(value.integerValue)];
        if(!dev.exists||!dev.available)return @{@"error":@"This output is no longer available."};
        if([action isEqualToString:@"speaker-volume"])dev.soundVolume=MAX(0,MIN(100,known.integerValue));
        else if([known isEqualToString:@"only"])app.currentAirPlayDevices=@[dev];
        else if([known isEqualToString:@"add"])dev.selected=YES;
        else if([known isEqualToString:@"remove"]){
            if(app.currentAirPlayDevices.count<=1)return @{@"error":@"Select another output before removing the last speaker."};
            dev.selected=NO;
        }else return @{@"error":@"Unknown output selection."};
    }else if([action isEqualToString:@"lyrics"]){
        MusicTrack *t=app.currentTrack;
        if(known.length&&![known isEqualToString:t.persistentID])return @{@"error":@"The song changed. Reopen Song info for its lyrics."};
        return @{@"lyrics":t.lyrics?:@""};
    }else if([action isEqualToString:@"playlist-cover"]){
        MusicPlaylist *p=[app.playlists objectWithID:@(value.integerValue)];
        if(!p.exists || ![known isEqual:p.persistentID])return @{};
        NSString *image=artworkImage(p.artworks,160);
        if(!image.length){
            MusicTrack *first=p.tracks.firstObject;
            if(first)image=artworkImage(first.artworks,160);
        }
        return @{@"art":image};
    }else if([action isEqualToString:@"playlist"] || [action isEqualToString:@"up"]){
        MusicItem *item=[action isEqualToString:@"playlist"]?[app.playlists objectWithID:@(value.integerValue)]:
            [app.currentPlaylist.tracks objectWithID:@(value.integerValue)];
        if(!item.exists || (known.length && ![known isEqual:item.persistentID]))return @{@"error":@"This item is no longer available."};
        [item playOnce:NO];
    }else{
        MusicSource *library=nil;
        for(MusicSource *source in app.sources) if(source.kind==MusicESrcLibrary){library=source;break;}
        if([action isEqualToString:@"playlists"]){
            if(!library)return @{@"error":errors.message?:@"Music has no available library."};
            return playlistPage(library,MAX(0,MIN(INT_MAX,value.integerValue)),MAX(1,MIN(12,known.integerValue)),errors);
        }
        MusicLibraryPlaylist *all=library.libraryPlaylists.firstObject;
        if(!all)return @{@"error":@"Music has no available library."};
        if([action isEqualToString:@"library-album"]){
            id found=[all searchFor:value only:MusicESrAAlbums];
            NSArray *matches=[found isKindOfClass:NSArray.class]?found:(found?@[found]:@[]);
            NSMutableArray *rows=[NSMutableArray array];
            for(MusicTrack *track in matches){
                if(!sameName(track.album,value))continue;
                NSString *by=track.albumArtist;
                if(!sameName(by.length?by:track.artist,known))continue;
                NSMutableDictionary *row=[song(track) mutableCopy];
                row[@"number"]=@(track.trackNumber);row[@"disc"]=@(track.discNumber);
                [rows addObject:row];
            }
            return rows;

        }else if([action isEqualToString:@"search"]){
            id found=[all searchFor:value only:MusicESrAAll];
            NSArray *matches=[found isKindOfClass:NSArray.class]?found:(found?@[found]:@[]);
            NSMutableArray *rows=[NSMutableArray array];
            if(!errors.message)for(MusicTrack *track in matches){[rows addObject:song(track)];if(rows.count>=40)break;}
            return errors.message?@{@"error":errors.message}:rows;
        }else if([action isEqualToString:@"track"]){
            MusicTrack *track=[all.tracks objectWithID:@(value.integerValue)];
            if(!track.exists)return @{@"error":@"This song is no longer available."};
            [track playOnce:NO];
        }else return @{@"error":@"Unknown Music action."};
    }
    return errors.message?@{@"error":errors.message}:@{};
}

char *ew_apple_music(const char *action,const char *value,const char *known) {
    @autoreleasepool {
        {
            id result;
            @try {
                if(!strcmp(action,"catalog-art"))result=catalogArt(@(value),@(known));
                else if(!strcmp(action,"catalog-album"))result=catalogAlbum(@(value));
                else if(!strcmp(action,"artist-portrait"))result=artistPortrait(@(value));
                else @synchronized(EWMusicErrors.class){result=musicRequest(@(action),@(value),@(known));}
            }
            @catch(NSException *e){result=@{@"error":e.reason?:@"Music could not complete this request."};}
            NSData *data=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
            NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            return strdup(json.UTF8String?:"{}");
        }
    }
}
