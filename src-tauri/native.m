#import <AppKit/AppKit.h>
#import <IOKit/IOKitLib.h>
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
        NSString *source=[NSString stringWithFormat:@"tell application id \"com.spotify.client\"\n%@\nreturn {name of current track, artist of current track, album of current track, player state as string, player position, duration of current track}\nend tell",commands[action]];
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
        const char *query="SELECT json_extract(json,'$.title'),json_extract(json,'$.model'),json_extract(json,'$.detail.tool'),json_extract(json,'$.detail.todosDone'),json_extract(json,'$.detail.todosTotal') FROM chats WHERE hidden=0 AND archived=0 ORDER BY last_activity DESC LIMIT 20";
        sqlite3_stmt *stmt=NULL;
        if(sqlite3_prepare_v2(db,query,-1,&stmt,NULL)!=SQLITE_OK){sqlite3_close(db);return NULL;}
        NSMutableArray *rows=[NSMutableArray new];
        int rc;
        while((rc=sqlite3_step(stmt))==SQLITE_ROW){
            NSMutableDictionary *row=[NSMutableDictionary new];
            NSArray *keys=@[@"title",@"model",@"operation",@"done",@"total"];
            for(int i=0;i<5;i++){const unsigned char *v=sqlite3_column_text(stmt,i);if(v)row[keys[i]]=[NSString stringWithUTF8String:(const char*)v]?:@"";}
            [rows addObject:row];
        }
        sqlite3_finalize(stmt);sqlite3_close(db);
        if(rc!=SQLITE_DONE)return NULL;
        NSData *data=[NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
        return strdup([[NSString alloc]initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}
