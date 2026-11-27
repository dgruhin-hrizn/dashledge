#import <EventKit/EventKit.h>
#import <AppKit/AppKit.h>
#import <string.h>
#import <stdio.h>

// Apple Reminders through EventKit, for package views that declare the `reminders`
// permission. Every entry point returns a JSON string the caller frees with free().

// One long-lived store: Apple documents EKEventStore as expensive to create, and every
// placement polls. EventKit stores are safe to use from several threads.
static EKEventStore *sharedStore(void) {
    static EKEventStore *store;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ store = [[EKEventStore alloc] init]; });
    return store;
}

// Bumped whenever EventKit says reminders changed anywhere: here, in the Reminders app,
// through Siri or from another device. Views compare it to decide when to read again.
static volatile long changes = 0;
static void watch(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        [NSNotificationCenter.defaultCenter addObserverForName:EKEventStoreChangedNotification object:sharedStore()
            queue:nil usingBlock:^(NSNotification *note) { (void)note; __atomic_add_fetch(&changes, 1, __ATOMIC_RELAXED); }];
    });
}

long reminders_revision(void) {
    watch();
    return __atomic_load_n(&changes, __ATOMIC_RELAXED);
}

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
        // The moment it is due, in milliseconds, for timed reminders: what voice alerts use.
        if (c.hour != NSDateComponentUndefined) {
            NSDate *at = [NSCalendar.currentCalendar dateFromComponents:c];
            if (at) out[@"dueAt"] = @((long long)llround(at.timeIntervalSince1970 * 1000));
        }
    }
    NSString *notes = [r.notes stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (notes.length) out[@"notes"] = notes.length > 400 ? [notes substringToIndex:400] : notes;
    if (r.completionDate) out[@"completedAt"] = [[[NSISO8601DateFormatter alloc] init] stringFromDate:r.completionDate];
    return out;
}

static NSDictionary *snapshot(BOOL request) {
    EKEventStore *store = sharedStore();
    watch();
    EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder];
    if (request && status == EKAuthorizationStatusNotDetermined) {
        NSDictionary *problem = requestAccess(store);
        if (problem) return problem;
        status = [EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder];
        // Drop what the store cached before the grant.
        [store reset];
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
        EKEventStore *store = sharedStore();
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

// Add a reminder to the given list, or to the default list when the id is empty. `due`
// is YYYY-MM-DD or empty, `time` HH:MM or empty (only with a day), `priority` 0, 1, 5
// or 9. A timed reminder also gets an alert at that time, as Reminders gives one.
char *reminders_add(const char *title, const char *listIdentifier, const char *due, const char *time, int priority) {
    @autoreleasepool {
        EKEventStore *store = sharedStore();
        if (!canRead([EKEventStore authorizationStatusForEntityType:EKEntityTypeReminder]))
            return encode(@{@"error":@"Allow Reminders for Dashledge in System Settings."});
        NSString *wanted = [NSString stringWithUTF8String:listIdentifier];
        EKCalendar *list = wanted.length ? [store calendarWithIdentifier:wanted] : store.defaultCalendarForNewReminders;
        if (!list) return encode(@{@"error":wanted.length ? @"That list no longer exists." : @"Choose a default list in Reminders first."});
        if (!list.allowsContentModifications) return encode(@{@"error":@"That list is read-only."});
        EKReminder *r = [EKReminder reminderWithEventStore:store];
        r.title = [NSString stringWithUTF8String:title];
        r.calendar = list;
        if (priority == 1 || priority == 5 || priority == 9) r.priority = priority;
        int y = 0, m = 0, d = 0, h = -1, min = 0;
        if (sscanf(due, "%4d-%2d-%2d", &y, &m, &d) == 3) {
            NSDateComponents *c = [[NSDateComponents alloc] init];
            c.calendar = NSCalendar.currentCalendar;
            c.timeZone = NSTimeZone.localTimeZone;
            c.year = y; c.month = m; c.day = d;
            if (sscanf(time, "%2d:%2d", &h, &min) == 2 && h >= 0 && h < 24 && min >= 0 && min < 60) { c.hour = h; c.minute = min; }
            r.dueDateComponents = c;
            if (c.hour != NSDateComponentUndefined) {
                NSDate *at = [NSCalendar.currentCalendar dateFromComponents:c];
                if (at) [r addAlarm:[EKAlarm alarmWithAbsoluteDate:at]];
            }
        }
        NSError *error = nil;
        if (![store saveReminder:r commit:YES error:&error])
            return encode(@{@"error":error.localizedDescription ?: @"Reminders refused the new reminder."});
        return encode(@{@"ok":@YES, @"item":item(r)});
    }
}
