#import <AppKit/AppKit.h>
#import <LinkPresentation/LinkPresentation.h>

// Called on a worker thread after the user taps Add from clipboard.
char *dash_news_clipboard(void) {
    @autoreleasepool {
        NSPasteboard *board = NSPasteboard.generalPasteboard;
        NSString *raw = [board stringForType:NSPasteboardTypeURL] ?: [board stringForType:NSPasteboardTypeString];
        NSURL *url = raw ? [NSURL URLWithString:[raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]] : nil;
        if (![url.scheme.lowercaseString isEqual:@"https"] || ![url.host.lowercaseString isEqual:@"apple.news"] ||
            url.user || url.password || url.port ||
            [url.path rangeOfString:@"^/[AT][A-Za-z0-9_-]+/?$" options:NSRegularExpressionSearch].location == NSNotFound) return NULL;
        NSString *name = [board stringForType:@"public.url-name"];
        if (!name.length || [name isEqual:url.absoluteString]) {
            LPMetadataProvider *provider = [LPMetadataProvider new];
            provider.timeout = 4;
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            __block NSString *title = nil;
            [provider startFetchingMetadataForURL:url completionHandler:^(LPLinkMetadata *metadata, NSError *error) {
                title = [metadata.title copy];
                dispatch_semaphore_signal(done);
            }];
            if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5*NSEC_PER_SEC)) == 0) name = title;
            else { [provider cancel]; name = nil; }
        }
        NSString *fallback = [url.path hasPrefix:@"/A"] ? @"Apple News story" : @"Apple News source";
        NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"url":url.absoluteString, @"title":name.length ? name : fallback} options:0 error:nil];
        NSString *result = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return result ? strdup(result.UTF8String) : NULL;
    }
}
