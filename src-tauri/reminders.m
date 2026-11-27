#import <EventKit/EventKit.h>
#import <AppKit/AppKit.h>
#import <string.h>

// Apple Reminders through EventKit, for package views that declare the `reminders`
// permission. Every entry point returns a JSON string the caller frees with free().

static BOOL canRead(EKAuthorizationStatus status) {
    if (@available(macOS 14.0, *)) return status == EKAuthorizationStatusFullAccess;
#if __MAC_OS_X_VERSION_MIN_REQUIRED < 140000
    return status == EKAuthorizationStatusAuthorized;
#else
    return NO;
#endif
}

static NSString *permissionName(EKAuthorizationStatus status) {
    if (canRead(status)) return @"allowed";
    return status == EKAuthorizationStatusNotDetermined ? @"request" : @"denied";
}

// Ask macOS once, on the main queue, and wait for the answer.
static NSDictionary *requestAccess(EKEventStore *store) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSError *failure = nil;
    void (^finish)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
        (void)granted;
        failure = error;
        dispatch_semaphore_signal(done);
    };
    dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp activateIgnoringOtherApps:YES];
        if (@available(macOS 14.0, *)) [store requestFullAccessToRemindersWithCompletion:finish];
#if __MAC_OS_X_VERSION_MIN_REQUIRED < 140000
        else [store requestAccessToEntityType:EKEntityTypeReminder completion:finish];
#endif
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC)))
        return @{@"permission":@"request", @"detail":@"No response from macOS. Check Reminders in System Settings › Privacy & Security."};
    if (failure) return @{@"permission":@"denied", @"detail":failure.localizedDescription ?: @""};
    return nil;
}

static NSString *hexColor(CGColorRef color) {
    if (!color) return @"";
    NSColor *rgb = [[NSColor colorWithCGColor:color] colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
    if (!rgb) return @"";
    return [NSString stringWithFormat:@"#%02X%02X%02X", (int)lround(rgb.redComponent * 255),
            (int)lround(rgb.greenComponent * 255), (int)lround(rgb.blueComponent * 255)];
}

static NSArray *fetch(EKEventStore *store, NSPredicate *predicate) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSArray *found = nil;
    [store fetchRemindersMatchingPredicate:predicate completion:^(NSArray<EKReminder *> *reminders) {
        found = reminders;
        dispatch_semaphore_signal(done);
    }];
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC))) return nil;
    return found ?: @[];
}

static NSDictionary *item(EKReminder *r) {
    NSMutableDictionary *out = [@{@"id":r.calendarItemIdentifier ?: @"", @"title":r.title ?: @"",
        @"listId":r.calendar.calendarIdentifier ?: @"", @"priority":@(r.priority), @"completed":@(r.completed)} mutableCopy];
    NSDateComponents *c = r.dueDateComponents;
    if (c && c.year != NSDateComponentUndefined && c.month != NSDateComponentUndefined && c.day != NSDateComponentUndefined) {
        out[@"due"] = [NSString stringWithFormat:@"%04ld-%02ld-%02ld", (long)c.year, (long)c.month, (long)c.day];
        if (c.hour != NSDateComponentUndefined)
            out[@"dueTime"] = [NSString stringWithFormat:@"%02ld:%02ld", (long)c.hour,
                               (long)(c.minute == NSDateComponentUndefined ? 0 : c.minute)];
    }
    NSString *notes = [r.notes stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (notes.length) out[@"notes"] = notes.length > 400 ? [notes substringToIndex:400] : notes;
    if (r.completionDate) out[@"completedAt"] = [[[NSISO8601DateFormatter alloc] init] stringFromDate:r.completionDate];
    return out;
}

static NSDictionary *snapshot(BOOL request) {
    EKEventStore *store = [[EKEventStore alloc] init];
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder];
    if (request && status == EKAuthorizationStatusNotDetermined) {
        NSDictionary *problem = requestAccess(store);
        if (problem) return problem;
        status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder];
        // A fresh store sees the new grant.
        store = [[EKEventStore alloc] init];
    }
    if (!canRead(status)) return @{@"permission":permissionName(status)};

    NSMutableArray *lists = [NSMutableArray array];
    for (EKCalendar *list in [store calendarsForEntityType:EKEntityTypeReminder]) {
        if (!list.calendarIdentifier.length) continue;
        [lists addObject:@{@"id":list.calendarIdentifier, @"title":list.title ?: @"Reminders",
                           @"color":hexColor(list.CGColor), @"account":list.source.title ?: @"On My Mac",
                           @"writable":@(list.allowsContentModifications)}];
    }
    EKCalendar *fallback = store.defaultCalendarForNewReminders;

    NSArray *open = fetch(store, [store predicateForIncompleteRemindersWithDueDateStarting:nil ending:nil calendars:nil]);
    NSDate *midnight = [NSCalendar.currentCalendar startOfDayForDate:NSDate.date];
    NSArray *done = fetch(store, [store predicateForCompletedRemindersWithCompletionDateStarting:midnight ending:nil calendars:nil]);
    if (!open || !done) return @{@"permission":@"allowed", @"error":@"Reminders didn’t answer in time.", @"lists":lists};

    NSMutableArray *items = [NSMutableArray array];
    for (EKReminder *r in open) [items addObject:item(r)];
    for (EKReminder *r in done) [items addObject:item(r)];
    return @{@"permission":@"allowed", @"lists":lists, @"defaultList":fallback.calendarIdentifier ?: @"", @"items":items};
}

static char *encode(NSDictionary *value) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    return json ? strdup([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String) : NULL;
}

char *reminders_snapshot(int request) {
    @autoreleasepool { return encode(snapshot(request != 0)); }
}

// Check off or reopen one reminder. Returns {"ok":true} or {"error":"…"}.
char *reminders_set_completed(const char *identifier, int completed) {
    @autoreleasepool {
        EKEventStore *store = [[EKEventStore alloc] init];
        if (!canRead([EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder]))
            return encode(@{@"error":@"Allow Reminders for Dashledge in System Settings."});
        EKCalendarItem *found = [store calendarItemWithIdentifier:[NSString stringWithUTF8String:identifier]];
        if (![found isKindOfClass:EKReminder.class]) return encode(@{@"error":@"That reminder no longer exists."});
        EKReminder *r = (EKReminder *)found;
        if (!r.calendar.allowsContentModifications) return encode(@{@"error":@"That list is read-only."});
        r.completed = completed != 0;
        NSError *error = nil;
        if (![store saveReminder:r commit:YES error:&error])
            return encode(@{@"error":error.localizedDescription ?: @"Reminders refused the change."});
        return encode(@{@"ok":@YES, @"item":item(r)});
    }
}

// Add a reminder to the given list, or to the default list when the id is empty.
char *reminders_add(const char *title, const char *listIdentifier) {
    @autoreleasepool {
        EKEventStore *store = [[EKEventStore alloc] init];
        if (!canRead([EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder]))
            return encode(@{@"error":@"Allow Reminders for Dashledge in System Settings."});
        NSString *wanted = [NSString stringWithUTF8String:listIdentifier];
        EKCalendar *list = wanted.length ? [store calendarWithIdentifier:wanted] : store.defaultCalendarForNewReminders;
        if (!list) return encode(@{@"error":wanted.length ? @"That list no longer exists." : @"Choose a default list in Reminders first."});
        if (!list.allowsContentModifications) return encode(@{@"error":@"That list is read-only."});
        EKReminder *r = [EKReminder reminderWithEventStore:store];
        r.title = [NSString stringWithUTF8String:title];
        r.calendar = list;
        NSError *error = nil;
        if (![store saveReminder:r commit:YES error:&error])
            return encode(@{@"error":error.localizedDescription ?: @"Reminders refused the new reminder."});
        return encode(@{@"ok":@YES, @"item":item(r)});
    }
}
