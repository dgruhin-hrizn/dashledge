// JavaScriptCore host for sandboxed package connectors (package_connector.rs).
// A connector's context has no fetch, XMLHttpRequest, WebSocket, module loader or
// file access of its own. Its only way out is __host(op, json), which Rust checks.
#import <Foundation/Foundation.h>
#import <JavaScriptCore/JavaScriptCore.h>
#include <stdint.h>
#include <string.h>

// Exported by JavaScriptCore and used by Safari's watchdog; not in the public headers.
extern void JSContextGroupSetExecutionTimeLimit(JSContextGroupRef, double, bool (*)(JSContextRef, void *), void *);

// Implemented in Rust.
extern char *dashledge_connector_host(uintptr_t handle, const char *op, const char *json);
extern void dashledge_connector_free(char *value);
extern void dashledge_connector_ws_event(uintptr_t handle, long socket, const char *type, const char *data);

static bool stop_script(JSContextRef context, void *info) { (void)context; (void)info; return true; }

void *connector_new(uintptr_t handle, double limit) {
  @autoreleasepool {
    JSContext *context = [JSContext new];
    context[@"__host"] = ^JSValue *(NSString *op, NSString *json) {
      JSContext *current = [JSContext currentContext];
      char *out = dashledge_connector_host(handle, op.UTF8String ?: "", json.UTF8String ?: "null");
      if (!out) return [JSValue valueWithNullInContext:current];
      NSString *text = [NSString stringWithUTF8String:out];
      dashledge_connector_free(out);
      return text ? [JSValue valueWithObject:text inContext:current] : [JSValue valueWithNullInContext:current];
    };
    JSContextGroupSetExecutionTimeLimit(JSContextGetGroup(context.JSGlobalContextRef), limit, stop_script, NULL);
    return (__bridge_retained void *)context;
  }
}

// Evaluate source. Returns a malloc'd error message, or NULL on success.
char *connector_eval(void *pointer, const char *source, const char *url) {
  @autoreleasepool {
    JSContext *context = (__bridge JSContext *)pointer;
    context.exception = nil;
    NSString *text = [NSString stringWithUTF8String:source];
    if (!text) return strdup("Connector source isn't UTF-8.");
    [context evaluateScript:text withSourceURL:[NSURL URLWithString:@(url)]];
    if (!context.exception) return NULL;
    NSString *message = [context.exception toString] ?: @"Connector error";
    context.exception = nil;
    return strdup(message.UTF8String ?: "Connector error");
  }
}

void connector_free(void *pointer) {
  @autoreleasepool {
    CFRelease(pointer);
  }
}

// ---- WebSocket, on NSURLSession's delegate queue ----
@interface DLSocketDelegate : NSObject <NSURLSessionWebSocketDelegate>
@end

static NSURLSession *sessions;
static NSMutableDictionary<NSNumber *, NSURLSessionWebSocketTask *> *sockets;
static NSMutableDictionary<NSNumber *, NSArray<NSNumber *> *> *owners; // task id → [handle, socket]

static void event(NSURLSessionTask *task, const char *type, NSString *data) {
  NSArray<NSNumber *> *owner;
  @synchronized (sockets) { owner = owners[@(task.taskIdentifier)]; }
  if (owner) dashledge_connector_ws_event(owner[0].unsignedLongValue, owner[1].longValue, type, (data ?: @"").UTF8String);
}

@implementation DLSocketDelegate
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task didOpenWithProtocol:(NSString *)protocol {
  event(task, "open", protocol);
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)task didCloseWithCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
  event(task, "close", [NSString stringWithFormat:@"%ld", (long)code]);
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (error) event(task, "error", error.localizedDescription);
  event(task, "close", @"1006");
}
// Redirects are refused, as for fetch.
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task willPerformHTTPRedirection:(NSHTTPURLResponse *)response newRequest:(NSURLRequest *)request completionHandler:(void (^)(NSURLRequest *))completionHandler {
  completionHandler(nil);
}
@end

static void receive(NSURLSessionWebSocketTask *task) {
  [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    if (error || !message) return;
    if (message.type == NSURLSessionWebSocketMessageTypeString) event(task, "message", message.string);
    else event(task, "binary", [message.data base64EncodedStringWithOptions:0]);
    receive(task);
  }];
}

void connector_ws_open(uintptr_t handle, long socket, const char *url, const char *header_name, const char *header_value) {
  @autoreleasepool {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
      NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
      config.timeoutIntervalForRequest = 15;
      sessions = [NSURLSession sessionWithConfiguration:config delegate:[DLSocketDelegate new] delegateQueue:nil];
      sockets = [NSMutableDictionary new];
      owners = [NSMutableDictionary new];
    });
    NSURL *address = [NSURL URLWithString:@(url)];
    if (!address) return;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:address];
    if (header_name && header_value && *header_name) [request setValue:@(header_value) forHTTPHeaderField:@(header_name)];
    NSURLSessionWebSocketTask *task = [sessions webSocketTaskWithRequest:request];
    task.maximumMessageSize = 4 * 1024 * 1024;
    @synchronized (sockets) {
      sockets[@(socket)] = task;
      owners[@(task.taskIdentifier)] = @[@(handle), @(socket)];
    }
    [task resume];
    receive(task);
  }
}

void connector_ws_send(long socket, const char *text) {
  @autoreleasepool {
    NSURLSessionWebSocketTask *task;
    @synchronized (sockets) { task = sockets[@(socket)]; }
    NSString *string = [NSString stringWithUTF8String:text];
    if (task && string) [task sendMessage:[[NSURLSessionWebSocketMessage alloc] initWithString:string] completionHandler:^(NSError *error) { (void)error; }];
  }
}

void connector_ws_close(long socket) {
  @autoreleasepool {
    NSURLSessionWebSocketTask *task;
    @synchronized (sockets) {
      task = sockets[@(socket)];
      [sockets removeObjectForKey:@(socket)];
      if (task) [owners removeObjectForKey:@(task.taskIdentifier)];
    }
    [task cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
  }
}
