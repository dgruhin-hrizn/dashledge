#import <EventKit/EventKit.h>
#import <AppKit/AppKit.h>
#import <string.h>

static NSDictionary *snapshot(BOOL request) {
    EKEventStore *store = [[EKEventStore alloc] init];
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    if (request && status == EKAuthorizationStatusNotDetermined) {
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block NSError *failure = nil;
        void (^finish)(BOOL,NSError *) = ^(BOOL granted, NSError *error) {
            failure = error;
            dispatch_semaphore_signal(done);
        };
        dispatch_async(dispatch_get_main_queue(), ^{
            [NSApp activateIgnoringOtherApps:YES];
            if (@available(macOS 14.0, *)) [store requestFullAccessToEventsWithCompletion:finish];
            else [store requestAccessToEntityType:EKEntityTypeEvent completion:finish];
        });
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)))
            return @{@"permission":@"request", @"detail":@"No response from macOS. Check Calendar permissions in System Settings."};
        if (failure) return @{@"permission":@"denied", @"detail":failure.localizedDescription};
        status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeEvent];
    }
    if (status != EKAuthorizationStatusFullAccess)
        return @{@"permission":status==EKAuthorizationStatusNotDetermined?@"request":@"denied"};
    NSDate *now = NSDate.date;
    NSDate *end = [NSCalendar.currentCalendar dateByAddingUnit:NSCalendarUnitDay value:7 toDate:now options:0];
    NSMutableArray *calendars = [NSMutableArray array];
    for (EKCalendar *calendar in [store calendarsForEntityType:EKEntityTypeEvent]) {
        if (!calendar.calendarIdentifier.length) continue;
        [calendars addObject:@{@"id":calendar.calendarIdentifier, @"title":calendar.title ?: @"Calendar",
                               @"accountId":calendar.source.sourceIdentifier ?: @"",
                               @"account":calendar.source.title ?: @"On My Mac"}];
    }
    NSArray *events = [store eventsMatchingPredicate:[store predicateForEventsWithStartDate:now endDate:end calendars:nil]];
    NSMutableArray *items = [NSMutableArray array];
    NSISO8601DateFormatter *iso = [[NSISO8601DateFormatter alloc] init];
    NSDateFormatter *civil = [[NSDateFormatter alloc] init];
    civil.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    civil.dateFormat = @"yyyy-MM-dd";
    NSDataDetector *detector = [NSDataDetector dataDetectorWithTypes:NSTextCheckingTypeLink error:NULL];
    for (EKEvent *e in events) {
        if (e.status == EKEventStatusCanceled || !e.startDate || !e.endDate) continue;
        NSDictionary *start, *finish;
        if (e.allDay) {
            civil.timeZone = e.timeZone ?: NSTimeZone.localTimeZone;
            start = @{@"date":[civil stringFromDate:e.startDate]};
            finish = @{@"date":[civil stringFromDate:e.endDate]};
        } else {
            start = @{@"dateTime":[iso stringFromDate:e.startDate]};
            finish = @{@"dateTime":[iso stringFromDate:e.endDate]};
        }
        NSMutableDictionary *item = [@{@"summary":e.title ?: @"Busy", @"start":start, @"end":finish,
            @"location":e.location ?: @"", @"calendarId":e.calendar.calendarIdentifier ?: @"", @"calendar":e.calendar.title ?: @""} mutableCopy];
        NSString *text = [@[e.URL.absoluteString ?: @"", e.location ?: @"", e.notes ?: @""] componentsJoinedByString:@" "];
        for (NSTextCheckingResult *match in [detector matchesInString:text options:0 range:NSMakeRange(0,text.length)]) {
            NSURL *url=match.URL; NSString *host=url.host.lowercaseString;
            if ([url.scheme.lowercaseString isEqual:@"https"] && ([host isEqual:@"meet.google.com"] ||
                [host isEqual:@"zoom.us"] || [host hasSuffix:@".zoom.us"] || [host isEqual:@"teams.microsoft.com"] ||
                [host isEqual:@"teams.live.com"])) {item[@"meeting"]=url.absoluteString;break;}
        }
        [items addObject:item];
    }
    return @{@"permission":@"allowed",@"calendars":calendars,@"items":items};
}

char *desk_calendar_snapshot(int request) {
    @autoreleasepool {
        NSData *json=[NSJSONSerialization dataWithJSONObject:snapshot(request != 0) options:0 error:NULL];
        return json ? strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String) : NULL;
    }
}
