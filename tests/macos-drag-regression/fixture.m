// Synthetic inputs only: never reads or changes the general clipboard.
#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>

@interface FixturePasteboard : NSObject
@property(nonatomic, strong) id value;
@end
@implementation FixturePasteboard
- (NSString *)availableTypeFromArray:(NSArray *)types { return NSFilenamesPboardType; }
- (id)propertyListForType:(NSString *)type { return self.value; }
@end

@interface FixtureDragInfo : NSObject
@property(nonatomic, strong) id board;
@end
@implementation FixtureDragInfo
- (NSPasteboard *)draggingPasteboard { return self.board; }
- (NSPoint)draggingLocation { return NSMakePoint(3, 4); }
@end

void *make_fixture(const char *fixture) {
    FixtureDragInfo *info = [FixtureDragInfo new];
    NSString *name = [NSString stringWithUTF8String:fixture];
    if ([name hasPrefix:@"synthetic-"]) {
        FixturePasteboard *pb = [FixturePasteboard new];
        if ([name isEqual:@"synthetic-root"]) pb.value = @"not an array";
        else if ([name isEqual:@"synthetic-entry"]) pb.value = @[@123];
        else if ([name isEqual:@"synthetic-mixed"])
            pb.value = @[@"/tmp/синтетика-a.txt", @123, @"/tmp/日本語-b.txt"];
        else if ([name isEqual:@"synthetic-unencodable"]) {
            // A real NSString whose unpaired UTF-16 surrogate has no UTF-8 form.
            unichar c = 0xD800;
            pb.value = @[[NSString stringWithCharacters:&c length:1]];
        }
        info.board = pb;
    } else {
        NSPasteboard *pb = [NSPasteboard pasteboardWithUniqueName];
        if ([name isEqual:@"invalid-file-url"]) {
            [pb declareTypes:@[NSPasteboardTypeFileURL] owner:nil];
            [pb setString:@"file://" forType:NSPasteboardTypeFileURL];
        } else {
            [pb declareTypes:@[NSFilenamesPboardType] owner:nil];
            if ([name isEqual:@"valid"])
                [pb setPropertyList:@[@"/tmp/synthetic-fixture.txt"] forType:NSFilenamesPboardType];
            else if ([name isEqual:@"empty"])
                [pb setPropertyList:@[] forType:NSFilenamesPboardType];
            // "missing" advertises the type without supplying data.
        }
        info.board = pb;
    }
    return (__bridge_retained void *)info;
}

static id eventTarget;
static FixtureDragInfo *eventInfo;
static int eventIsDrop;
static int eventIsTao;
static IMP originalSendEvent;

static void fixtureSendEvent(id self, SEL cmd, NSEvent *event) {
    if (event.type != NSEventTypeApplicationDefined || event.subtype != 16384) {
        ((void (*)(id, SEL, NSEvent *))originalSendEvent)(self, cmd, event);
        return;
    }
    // Invoke the actual dependency selector from AppKit event dispatch.
    unsigned long result;
    if (eventIsDrop) {
        result = (unsigned long)[eventTarget performDragOperation:eventInfo];
    } else if (eventIsTao) {
        // Tao registers a BOOL return, unlike Wry's NSDragOperation/NSUInteger.
        // Respect that narrow ABI on both Intel and Apple Silicon.
        BOOL accepted = ((BOOL (*)(id, SEL, id))objc_msgSend)(
            eventTarget, @selector(draggingEntered:), eventInfo);
        result = (unsigned long)accepted;
    } else {
        result = (unsigned long)[eventTarget draggingEntered:eventInfo];
    }
    printf("CALLBACK %lu\n", result);
    fflush(stdout);
    // Tao queues WindowEvents; let the loop deliver them before checking output.
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:NO block:^(NSTimer *timer) {
        if ([eventInfo.board isKindOfClass:NSPasteboard.class])
            [eventInfo.board releaseGlobally];
        fflush(stdout);
        exit(0);
    }];
}

void schedule_fixture(void *targetRaw, void *infoRaw, int isDrop, int isTao) {
    eventTarget = (__bridge id)targetRaw;
    eventInfo = (__bridge_transfer FixtureDragInfo *)infoRaw;
    eventIsDrop = isDrop;
    eventIsTao = isTao;
    // This replacement exists only in this isolated test process.
    Method method = class_getInstanceMethod([NSApp class], @selector(sendEvent:));
    originalSendEvent = method_setImplementation(method, (IMP)fixtureSendEvent);
    [NSTimer scheduledTimerWithTimeInterval:0.01 repeats:NO block:^(NSTimer *timer) {
        NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
            location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0
            context:nil subtype:16384 data1:0 data2:0];
        [NSApp postEvent:event atStart:NO];
    }];
}
