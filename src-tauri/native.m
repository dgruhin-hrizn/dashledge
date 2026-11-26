#import <AppKit/AppKit.h>
#import <IOKit/IOKitLib.h>
#import <Metal/Metal.h>
#include <string.h>

double ew_gpu(void) {
    @autoreleasepool {
        io_iterator_t devices=0;
        if(IOServiceGetMatchingServices(kIOMainPortDefault,IOServiceMatching("IOAccelerator"),&devices)!=KERN_SUCCESS)return -1;
        double load=-1;
        io_object_t device;
        while((device=IOIteratorNext(devices))){
            NSDictionary *stats=CFBridgingRelease(IORegistryEntryCreateCFProperty(device,CFSTR("PerformanceStatistics"),kCFAllocatorDefault,0));
            NSNumber *util=stats[@"Device Utilization %"];
            if([util isKindOfClass:NSNumber.class])load=MAX(load,util.doubleValue);
            IOObjectRelease(device);
        }
        IOObjectRelease(devices);
        return load;
    }
}

// Execute fixed, app-owned scripts only; no script is supplied by a widget.
char *ew_spotify(int action) {
    @autoreleasepool {
        if(![NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.spotify.client"].count)return strdup("{\"playing\":false,\"status\":\"Open Spotify to connect\"}");
        NSArray *commands=@[@"",@"playpause",@"next track",@"previous track"];
        if(action<0||(NSUInteger)action>=commands.count)return NULL;
        NSString *source=[NSString stringWithFormat:@"with timeout of 3 seconds\ntell application id \"com.spotify.client\"\n%@\nreturn {name of current track, artist of current track, album of current track, player state as string, player position, duration of current track}\nend tell\nend timeout",commands[action]];
        NSDictionary *error;
        NSAppleEventDescriptor *result=[[[NSAppleScript alloc]initWithSource:source]executeAndReturnError:&error];
        if(!result||result.numberOfItems<6)return strdup("{\"status\":\"Spotify unavailable. Check playback and Automation access.\"}");
        NSDictionary *track=@{@"title":[result descriptorAtIndex:1].stringValue?:@"",@"artist":[result descriptorAtIndex:2].stringValue?:@"",@"album":[result descriptorAtIndex:3].stringValue?:@"",@"playing":@([[result descriptorAtIndex:4].stringValue isEqual:@"playing"]),@"position":@([result descriptorAtIndex:5].doubleValue),@"duration":@([result descriptorAtIndex:6].doubleValue/1000.)};
        NSData *data=[NSJSONSerialization dataWithJSONObject:track options:0 error:nil];
        return strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}

#import <sqlite3.h>
char *ew_ember(void) {
    @autoreleasepool {
        NSString *path=[NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/Ember/User/globalStorage/ember.ember-agent/ember.db"];
        sqlite3 *db=NULL;
        if(sqlite3_open_v2(path.fileSystemRepresentation,&db,SQLITE_OPEN_READONLY,NULL)!=SQLITE_OK){if(db)sqlite3_close(db);return NULL;}
        sqlite3_busy_timeout(db,300);
        const char *query="SELECT json_extract(json,'$.title'),json_extract(json,'$.model'),json_extract(json,'$.detail.tool'),json_extract(json,'$.detail.todosDone'),json_extract(json,'$.detail.todosTotal'),id,workspace,json_extract(json,'$.cwd'),json_extract(json,'$.worktree.path') FROM chats WHERE hidden=0 AND archived=0 ORDER BY last_activity DESC LIMIT 20";
        sqlite3_stmt *stmt=NULL;
        if(sqlite3_prepare_v2(db,query,-1,&stmt,NULL)!=SQLITE_OK){sqlite3_close(db);return NULL;}
        NSMutableArray *rows=[NSMutableArray new];
        int rc;
        while((rc=sqlite3_step(stmt))==SQLITE_ROW){
            NSMutableDictionary *row=[NSMutableDictionary new];
            NSArray *keys=@[@"title",@"model",@"operation",@"done",@"total",@"id",@"workspace",@"cwd",@"worktree"];
            for(int i=0;i<9;i++){const unsigned char *v=sqlite3_column_text(stmt,i);if(v)row[keys[i]]=[NSString stringWithUTF8String:(const char*)v]?:@"";}
            [rows addObject:row];
        }
        sqlite3_finalize(stmt);sqlite3_close(db);
        if(rc!=SQLITE_DONE)return NULL;
        NSData *data=[NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
        return strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}

#import <IOKit/ps/IOPowerSources.h>
#import <mach/mach.h>

char *ew_extra_metrics(void) {
    @autoreleasepool {
        NSMutableDictionary *result=[NSMutableDictionary new];
        static NSString *graphics;
        static dispatch_once_t once;
        dispatch_once(&once,^{graphics=MTLCreateSystemDefaultDevice().name;});
        if(graphics)result[@"gpuName"]=graphics;
        NSProcessInfo *info=NSProcessInfo.processInfo;
        NSArray *thermal=@[@"Nominal",@"Fair",@"Serious",@"Critical"];
        NSInteger t=info.thermalState;
        if(t>=0 && t<(NSInteger)thermal.count) result[@"thermal"]=thermal[t];
        NSDictionary *stats=nil;
        CFTypeRef snapshot=IOPSCopyPowerSourcesInfo();
        if(snapshot){
            CFArrayRef sources=IOPSCopyPowerSourcesList(snapshot);
            if(sources){
                for(id item in (__bridge NSArray *)sources){
                    NSDictionary *ps=(__bridge NSDictionary *)IOPSGetPowerSourceDescription(snapshot,(__bridge CFTypeRef)item);
                    if([ps[@"Type"] isEqual:@"InternalBattery"]){stats=[ps copy];break;}
                }
                CFRelease(sources);
            }
            CFRelease(snapshot);
        }
        if(stats){
            double max=[stats[@"Max Capacity"] doubleValue];
            if(max>0)result[@"battery"]=@(100*[stats[@"Current Capacity"] doubleValue]/max);
            result[@"power"]=stats[@"Power Source State"]?:@"";
            result[@"charging"]=stats[@"Is Charging"]?:@NO;
        }
        mach_port_t host=mach_host_self();vm_size_t pageSize=0;vm_statistics64_data_t vm={0};
        mach_msg_type_number_t count=HOST_VM_INFO64_COUNT;
        if(host_page_size(host,&pageSize)==KERN_SUCCESS&&host_statistics64(host,HOST_VM_INFO64,(host_info64_t)&vm,&count)==KERN_SUCCESS){
            result[@"wired"]=@((uint64_t)vm.wire_count*pageSize);
            result[@"compressed"]=@((uint64_t)vm.compressor_page_count*pageSize);
        }
        mach_port_deallocate(mach_task_self(),host);
        NSData *payload=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        return strdup([[NSString alloc]initWithData:payload encoding:NSUTF8StringEncoding].UTF8String);
    }
}

void ew_preview_size(void *pointer, bool vertical) {
    NSWindow *window=(__bridge NSWindow *)pointer;
    NSRect previous=window.frame;
    NSRect available=(window.screen ?: NSScreen.mainScreen).visibleFrame;
    CGFloat ratio=vertical?9.0/32.0:32.0/9.0;
    NSSize current=[window contentRectForFrameRect:previous].size;
    CGFloat maxHeight=available.size.height-(previous.size.height-current.height);
    CGFloat span=MAX(current.width,current.height);
    CGFloat w=MIN(available.size.width,MIN((vertical?span*ratio:span),maxHeight*ratio));
    NSSize content=NSMakeSize(w,w/ratio);
    window.contentMinSize=NSZeroSize;
    window.resizeIncrements=NSMakeSize(1,1);
    NSRect next=[window frameRectForContentRect:(NSRect){NSZeroPoint,content}];
    next.origin.x=MAX(NSMinX(available),MIN(NSMaxX(available)-next.size.width,NSMidX(previous)-next.size.width/2));
    next.origin.y=MAX(NSMinY(available),MIN(NSMaxY(available)-next.size.height,NSMidY(previous)-next.size.height/2));
    [window setFrame:next display:YES];
    window.contentMinSize=NSMakeSize(vertical?90:320,vertical?320:90);
    window.contentAspectRatio=NSMakeSize(vertical?9:32,vertical?32:9);
}

char *ew_display_uuid(CGDirectDisplayID display) {
    CFUUIDRef uuid=CGDisplayCreateUUIDFromDisplayID(display);
    if(!uuid)return NULL;
    NSString *s=CFBridgingRelease(CFUUIDCreateString(NULL,uuid));
    CFRelease(uuid);
    return strdup(s.UTF8String);
}
char *ew_display_name(CGDirectDisplayID display) {
    @autoreleasepool {
        for(NSScreen *s in NSScreen.screens)
            if([s.deviceDescription[@"NSScreenNumber"] unsignedIntValue]==display)return strdup(s.localizedName.UTF8String);
        return NULL;
    }
}
