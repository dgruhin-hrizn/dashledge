#import <Photos/Photos.h>
#import <AppKit/AppKit.h>
#import <Vision/Vision.h>
#import <objc/message.h>

// Shared Album assets and iCloud Shared Photo Library membership are distinct.
// macOS exposes the latter through optional PhotoKit selectors. Always check
// for them and keep a failed shared-only request scoped to that source.
static BOOL sharedSupported(void) {
    return [NSClassFromString(@"PHLibraryScope") respondsToSelector:NSSelectorFromString(@"fetchActiveLibraryScopeWithOptions:")] &&
           [PHAsset respondsToSelector:NSSelectorFromString(@"fetchAssetsInLibraryScope:options:")];
}
static NSDictionary *failure(NSString *message){return @{@"error":message};}
static NSString *accessState(void){
    switch([PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelReadWrite]){
        case PHAuthorizationStatusAuthorized: case PHAuthorizationStatusLimited:return @"allowed";
        case PHAuthorizationStatusNotDetermined:return @"unknown";
        default:return @"denied";
    }
}
// Library-wide sources keep PhotoKit's default (your own library). Album contents and
// lookups by id also reach shared-album and synced photos.
static PHFetchOptions *libraryOptions(void){
    PHFetchOptions *opts=[PHFetchOptions new];
    opts.predicate=[NSPredicate predicateWithFormat:@"mediaType == %d",PHAssetMediaTypeImage];
    return opts;
}
static PHFetchOptions *imageOptions(void){
    PHFetchOptions *opts=libraryOptions();
    opts.includeAssetSourceTypes=PHAssetSourceTypeUserLibrary|PHAssetSourceTypeCloudShared|PHAssetSourceTypeiTunesSynced;
    return opts;
}
// One catalog row: what the picker needs to show and find an album again.
static NSDictionary *albumRow(PHAssetCollection *album,NSString *folder,NSString *kind){
    PHFetchResult *assets=[PHAsset fetchAssetsInAssetCollection:album options:imageOptions()];
    PHAsset *cover=[PHAsset fetchKeyAssetsInAssetCollection:album options:nil].firstObject?:assets.lastObject;
    NSMutableDictionary *row=[@{@"id":album.localIdentifier,@"name":album.localizedTitle?:@"Untitled album",
        @"folder":folder?:@"",@"kind":kind,@"count":@(assets.count)} mutableCopy];
    if(cover)row[@"cover"]=cover.localIdentifier;
    return row;
}
// Walk My Albums with folder paths so similarly named albums can be told apart.
static void walk(PHCollectionList *list,NSString *path,NSMutableArray *rows,NSUInteger depth){
    PHFetchResult *children=list?[PHCollection fetchCollectionsInCollectionList:list options:nil]:[PHCollectionList fetchTopLevelUserCollectionsWithOptions:nil];
    for(PHCollection *child in children){
        if([child isKindOfClass:PHAssetCollection.class]){
            PHAssetCollection *album=(PHAssetCollection *)child;
            // Shared albums are listed once, in their own group.
            if(album.assetCollectionType==PHAssetCollectionTypeAlbum&&album.assetCollectionSubtype!=PHAssetCollectionSubtypeAlbumCloudShared)
                [rows addObject:albumRow(album,path,@"album")];
        }else if([child isKindOfClass:PHCollectionList.class]&&depth<8){
            NSString *name=child.localizedTitle?:@"Folder";
            walk((PHCollectionList *)child,path.length?[NSString stringWithFormat:@"%@ › %@",path,name]:name,rows,depth+1);
        }
    }
}
static NSDictionary *catalog(BOOL ask){
    if(ask && [accessState() isEqual:@"unknown"]){
        dispatch_semaphore_t done=dispatch_semaphore_create(0);
        [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelReadWrite handler:^(PHAuthorizationStatus status){(void)status;dispatch_semaphore_signal(done);}];
        dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,120*NSEC_PER_SEC));
    }
    NSString *access=accessState();
    NSMutableArray *albums=[NSMutableArray array];
    if([access isEqual:@"allowed"]){
        // Smart albums people pick for a frame; the rest are utility views (Screenshots, Hidden…).
        NSArray *smart=@[@(PHAssetCollectionSubtypeSmartAlbumFavorites),@(PHAssetCollectionSubtypeSmartAlbumRecentlyAdded),
            @(PHAssetCollectionSubtypeSmartAlbumPanoramas),@(PHAssetCollectionSubtypeSmartAlbumDepthEffect),
            @(PHAssetCollectionSubtypeSmartAlbumSelfPortraits),@(PHAssetCollectionSubtypeSmartAlbumLivePhotos),
            @(PHAssetCollectionSubtypeSmartAlbumLongExposures)];
        for(NSNumber *subtype in smart){
            PHAssetCollection *album=[PHAssetCollection fetchAssetCollectionsWithType:PHAssetCollectionTypeSmartAlbum subtype:subtype.integerValue options:nil].firstObject;
            if(album)[albums addObject:albumRow(album,@"",@"smart")];
        }
        walk(nil,@"",albums,0);
        for(PHAssetCollection *album in [PHAssetCollection fetchAssetCollectionsWithType:PHAssetCollectionTypeAlbum subtype:PHAssetCollectionSubtypeAlbumCloudShared options:nil])
            [albums addObject:albumRow(album,@"",@"shared")];
    }
    return @{@"access":access,@"albums":albums,@"sharedSupported":@(sharedSupported())};
}
// Photos from the same calendar days in earlier years, widening once if that finds too few.
static PHFetchResult *onThisDay(NSInteger spread){
    NSCalendar *cal=NSCalendar.currentCalendar;NSDate *now=NSDate.date;
    NSMutableArray *ranges=[NSMutableArray array];
    for(NSInteger back=1;back<=40;back++){
        NSDate *day=[cal startOfDayForDate:[cal dateByAddingUnit:NSCalendarUnitYear value:-back toDate:now options:0]];
        NSDate *from=[cal dateByAddingUnit:NSCalendarUnitDay value:-spread toDate:day options:0];
        NSDate *to=[cal dateByAddingUnit:NSCalendarUnitDay value:spread+1 toDate:day options:0];
        [ranges addObject:[NSPredicate predicateWithFormat:@"creationDate >= %@ AND creationDate < %@",from,to]];
    }
    PHFetchOptions *opts=libraryOptions();
    opts.predicate=[NSCompoundPredicate andPredicateWithSubpredicates:@[opts.predicate,[NSCompoundPredicate orPredicateWithSubpredicates:ranges]]];
    return [PHAsset fetchAssetsWithOptions:opts];
}
static NSDictionary *selection(NSDictionary *args){
    NSString *source=args[@"source"];
    PHFetchOptions *opts=[source isEqual:@"albums"]?imageOptions():libraryOptions();
    BOOL skipScreenshots=[args[@"skipScreenshots"] boolValue];
    NSMutableArray *groups=[NSMutableArray array];
    if([source isEqual:@"albums"]){
        for(PHAssetCollection *album in [PHAssetCollection fetchAssetCollectionsWithLocalIdentifiers:args[@"albums"] options:nil]){
            [groups addObject:[PHAsset fetchAssetsInAssetCollection:album options:opts]];
        }
    }else if([source isEqual:@"shared"]){
        if(!sharedSupported())return failure(@"Shared Library selection is unavailable on this version of macOS.");
        id scope=((id(*)(id,SEL,id))objc_msgSend)(NSClassFromString(@"PHLibraryScope"),NSSelectorFromString(@"fetchActiveLibraryScopeWithOptions:"),nil);
        if([scope isKindOfClass:PHFetchResult.class])scope=[scope firstObject];
        if(scope){
            if(![scope isKindOfClass:NSClassFromString(@"PHLibraryScope")])return failure(@"Cannot identify the active Shared Library.");
            id assets=((id(*)(id,SEL,id,id))objc_msgSend)(PHAsset.class,NSSelectorFromString(@"fetchAssetsInLibraryScope:options:"),scope,opts);
            if(assets)[groups addObject:assets];
        }
    }else if([source isEqual:@"favorites"]){
        opts.predicate=[NSPredicate predicateWithFormat:@"mediaType == %d AND favorite == YES",PHAssetMediaTypeImage];
        [groups addObject:[PHAsset fetchAssetsWithOptions:opts]];
    }else if([source isEqual:@"onthisday"]){
        PHFetchResult *found=onThisDay(3);
        [groups addObject:found.count<8?onThisDay(14):found];
    }else if([source isEqual:@"library"]){
        [groups addObject:[PHAsset fetchAssetsWithOptions:opts]];
    }else return failure(@"Unknown photo source.");
    NSMutableArray *result=[NSMutableArray array];
    NSMutableSet *seen=[NSMutableSet set];
    NSMutableArray *samplers=[NSMutableArray array];
    for(PHFetchResult *group in groups){
        if(group.count)[samplers addObject:[@{@"group":group,@"left":@(group.count),@"indices":[NSMutableDictionary dictionary]} mutableCopy]];
    }
    // Randomly interleave albums, sampling each without replacement. Bound the
    // tries so a library of mostly screenshots can't spin through every asset.
    NSUInteger tries=0;
    while(samplers.count && result.count<96 && tries++<6000){
        NSUInteger g=arc4random_uniform((uint32_t)samplers.count);
        NSMutableDictionary *sampler=samplers[g],*indices=sampler[@"indices"];
        NSUInteger left=[sampler[@"left"] unsignedIntegerValue],pick=arc4random_uniform((uint32_t)left);
        NSNumber *index=indices[@(pick)]?:@(pick);
        indices[@(pick)]=indices[@(left-1)]?:@(left-1);
        sampler[@"left"]=@(left-1);
        PHAsset *asset=[sampler[@"group"] objectAtIndex:index.unsignedIntegerValue];
        if(left==1)[samplers removeObjectAtIndex:g];
        if(asset.hidden || asset.mediaType!=PHAssetMediaTypeImage || [seen containsObject:asset.localIdentifier])continue;
        if(skipScreenshots && (asset.mediaSubtypes&PHAssetMediaSubtypePhotoScreenshot))continue;
        if(!asset.pixelWidth||!asset.pixelHeight)continue;
        [seen addObject:asset.localIdentifier];
        [result addObject:@{@"id":asset.localIdentifier,@"w":@(asset.pixelWidth),@"h":@(asset.pixelHeight),
            @"date":@(asset.creationDate.timeIntervalSince1970),@"fav":@(asset.favorite),
            @"pano":@((asset.mediaSubtypes&PHAssetMediaSubtypePhotoPanorama)!=0)}];
    }
    return @{@"assets":result};
}
// Where the eye lands, as fractions of the image from its top-left, so a cropped frame keeps its subject.
static NSDictionary *focusPoint(CGImageRef cg){
    VNGenerateAttentionBasedSaliencyImageRequest *request=[VNGenerateAttentionBasedSaliencyImageRequest new];
    VNImageRequestHandler *handler=[[VNImageRequestHandler alloc] initWithCGImage:cg options:@{}];
    if(![handler performRequests:@[request] error:nil])return nil;
    VNSaliencyImageObservation *seen=(VNSaliencyImageObservation *)request.results.firstObject;
    VNRectangleObservation *best=nil;
    for(VNRectangleObservation *box in seen.salientObjects)
        if(!best||box.boundingBox.size.width*box.boundingBox.size.height>best.boundingBox.size.width*best.boundingBox.size.height)best=box;
    if(!best)return nil;
    CGRect r=best.boundingBox;   // Vision's origin is bottom-left.
    return @{@"x":@(CGRectGetMidX(r)),@"y":@(1-CGRectGetMidY(r))};
}
static NSDictionary *thumbnail(NSString *identifier,NSInteger size,BOOL focus){
    PHAsset *asset=[PHAsset fetchAssetsWithLocalIdentifiers:@[identifier] options:imageOptions()].firstObject;
    if(!asset||asset.hidden||asset.mediaType!=PHAssetMediaTypeImage)return failure(@"Photo unavailable.");
    PHImageRequestOptions *opts=[PHImageRequestOptions new];
    opts.networkAccessAllowed=YES;opts.deliveryMode=PHImageRequestOptionsDeliveryModeHighQualityFormat;
    opts.resizeMode=PHImageRequestOptionsResizeModeFast;
    dispatch_semaphore_t done=dispatch_semaphore_create(0);
    __block NSImage *image=nil;
    PHImageManager *manager=PHImageManager.defaultManager;
    // A square target bounds the long edge, so portraits come back as sharp as landscapes.
    PHImageRequestID request=[manager requestImageForAsset:asset targetSize:CGSizeMake(size,size) contentMode:PHImageContentModeAspectFit options:opts resultHandler:^(NSImage *value,NSDictionary *info){
        if([info[PHImageResultIsDegradedKey] boolValue])return;
        image=value;dispatch_semaphore_signal(done);
    }];
    if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,25*NSEC_PER_SEC))){[manager cancelImageRequest:request];return failure(@"iCloud photo download timed out.");}
    if(!image)return failure(@"Photo could not be loaded.");
    CGImageRef cg=[image CGImageForProposedRect:NULL context:nil hints:nil];
    NSData *data=cg?[[[NSBitmapImageRep alloc] initWithCGImage:cg] representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor:@0.86}]:nil;
    if(!data)return failure(@"Photo could not be decoded.");
    NSMutableDictionary *out=[@{@"image":[@"data:image/jpeg;base64," stringByAppendingString:[data base64EncodedStringWithOptions:0]]} mutableCopy];
    NSDictionary *point=focus?focusPoint(cg):nil;
    if(point)out[@"focus"]=point;
    return out;
}
char *dash_photos(const char *json){
    @autoreleasepool{
        NSDictionary *response=nil;
        @try{
            NSDictionary *args=[NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
            if([args[@"action"] isEqual:@"catalog"])response=catalog([args[@"ask"] boolValue]);
            else if(![accessState() isEqual:@"allowed"])response=failure(@"Allow Photos access in System Settings → Privacy & Security → Photos.");
            else if([args[@"action"] isEqual:@"select"])response=selection(args);
            else{
                NSInteger size=[args[@"size"] isKindOfClass:NSNumber.class]?[args[@"size"] integerValue]:1600;
                response=thumbnail(args[@"id"],MAX(160,MIN(3072,size)),[args[@"focus"] boolValue]);
            }
        }@catch(NSException *exception){response=failure(@"Photos could not read this selection.");}
        NSData *data=[NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        return strdup([[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]?:"{}");
    }
}
